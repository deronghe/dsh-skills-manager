// dsh-skills-manager core —— 纯 Node 技能文件管理核心（零第三方依赖，可独立单测）
//
// 覆盖 DSH 用户级技能根：
//   - 根目录：~/.dsh/skills
//   - 条目形态：<root>/<name>/SKILL.md（bundle）或 <root>/<name>.md（flat），只扫一层
//   - 前端展示 name、description 与启停状态，不做格式检查或自动修复
//
// 所有函数返回普通结果对象，业务校验失败返回 { ok: false, error, code?, params? }；
// error 保持中文原文（兼容性红线），code 为点分小写业务错误码，params 供前端词典占位符替换；
// 系统异常（fs ENOENT 等）透传 String(e.message)，不加 code。
// 文件写入错误由路由返回给调用方。

import { homedir } from "node:os";
import { join, basename, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_SOURCE_DEPTH = 64;
const MAX_ENTRY_NAME_LENGTH = 128;

// ── 业务错误码 ────────────────────────────────────────────────────────────────

/** 构造带 code/params 的业务 Error，供导入链路 throw 后透传到失败明细。 */
function codedError(message, code, params) {
  const error = new Error(message);
  error.code = code;
  error.params = params;
  return error;
}

/** 把业务 Error 的 code/params 附加到失败明细；系统异常（ENOENT 等，非 error.* 前缀）保持原文。 */
function attachCode(item, error) {
  if (error && typeof error.code === "string" && /^error\./.test(error.code)) item.code = error.code;
  if (error && error.params) item.params = error.params;
  return item;
}

// ── 路径解析 ────────────────────────────────────────────────────────────────

export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function resolveAgentsHome() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), ".agents");
}

/** DSH 可管理目录与只读的公共 Agent 目录。 */
export function userRoots() {
  return [
    { key: "dsh", path: join(resolveDshHome(), "skills"), label: "DSH 技能", mutable: true },
    { key: "agents", path: join(resolveAgentsHome(), "skills"), label: "公共 Agent 技能", mutable: false },
  ];
}

export function logPath() {
  return join(resolveDshHome(), "dsh-skills-manager.log");
}

/** 插件自身元信息（名称、版本、项目仓库），供设置页版本卡展示。 */
export async function pluginMeta() {
  try {
    const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
    const repository = typeof pkg.repository === "string"
      ? pkg.repository
      : (pkg.repository && typeof pkg.repository.url === "string" ? pkg.repository.url : "");
    return { name: String(pkg.name || ""), version: String(pkg.version || ""), repository };
  } catch {
    return { name: "", version: "", repository: "" };
  }
}

function dshRootPath() {
  return userRoots().find((root) => root.key === "dsh").path;
}

/** 公共 Agent 目录的只读拒绝结果；action 为可翻译语义值（toggle/delete/push）。 */
function readonlyError(action) {
  return {
    ok: false,
    code: "error.root.readonly",
    params: { action },
    error: action === "delete"
      ? "公共 Agent 技能目录不允许删除"
      : action === "push"
        ? "公共 Agent 技能目录不允许推送"
        : "公共 Agent 技能目录不允许启用或停用",
  };
}

/** 判断 child 是否与 parent 相同或位于其内部。跨盘符时 relative 会返回绝对路径。 */
function isSameOrDescendant(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** 解析真实路径；中间若有目录链接，按落地目录比较重叠。 */
async function resolvedPath(path) {
  try {
    return await fs.realpath(path);
  } catch {
    return resolve(path);
  }
}

/** 两个路径重叠时，覆盖导入可能删除自身来源，必须拒绝。 */
async function pathsOverlap(a, b) {
  const left = await resolvedPath(a);
  const right = await resolvedPath(b);
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

/** 预解析技能根后的根内校验，供逐条目扫描复用同一次 realpath，减少重复 IO。 */
async function isInsideResolvedRoot(rootReal, path) {
  return isSameOrDescendant(rootReal, await resolvedPath(path));
}

async function lstatOrNull(path) {
  try {
    return await fs.lstat(path);
  } catch {
    return null;
  }
}

/** 名称只允许一个普通路径段；不把既有技能名称限制为 kebab-case。 */
export function entryPath(root, name) {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || name.startsWith(".") || name.length > MAX_ENTRY_NAME_LENGTH || /[\\/:*?"<>|\0]/.test(name) || /[. ]$/.test(name) || WINDOWS_DEVICE_NAME_RE.test(name) || basename(name) !== name) return null;
  const rootPath = resolve(root);
  const path = resolve(rootPath, name);
  return isSameOrDescendant(rootPath, path) && rootPath !== path ? path : null;
}

function isDshRoot(root) {
  return typeof root === "string" && resolve(root) === resolve(dshRootPath());
}

// ── 命名规整 ────────────────────────────────────────────────────────────────

/** 尽量把任意名称规整为 kebab-case；无法生成合法名称时返回空串。 */
export function toKebab(s) {
  let t = String(s).trim();
  if (t === "") return "";
  t = t.replace(/([a-z0-9])([A-Z])/g, "$1-$2"); // camelCase 边界
  t = t.toLowerCase();
  t = t.replace(/[\s_.]+/g, "-");
  t = t.replace(/[^a-z0-9-]/g, "-");
  t = t.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return t;
}

// ── frontmatter 解析 / 序列化（宽松 YAML 对象，保留键序）────────────────────

/** 剥离 UTF-8 BOM（Windows 工具常写入，不剥离会导致开头 --- 失配）。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 解析 SKILL.md 的 frontmatter。返回 { fields, map, body }，map 保留键序。
 *  只识别顶层 key: value；缩进嵌套字段（如 metadata.source）不进入 map。
 *  写入走 updateInvocationPolicy 的文本级替换，因此嵌套块会被原样保留。 */
export function parseSkillDoc(text) {
  const src = stripBom(String(text));
  const lines = src.split(/\r?\n/);
  const map = Object.create(null);
  const fields = [];
  let body = src;
  if (lines.length > 0 && lines[0].trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        end = i;
        break;
      }
    }
    if (end >= 0) {
      for (let i = 1; i < end; i++) {
        const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
        if (m) {
          fields.push({ key: m[1], raw: m[2] });
          const block = /^([>|])[-+]?\s*$/.exec(m[2]);
          if (block) {
            const content = [];
            while (i + 1 < end && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) {
              i++;
              content.push(lines[i]);
            }
            const indentation = content.filter((line) => line.trim() !== "").reduce((min, line) => Math.min(min, (/^\s*/.exec(line) || [""])[0].length), Infinity);
            const normalized = content.map((line) => Number.isFinite(indentation) ? line.slice(Math.min(indentation, line.length)) : line);
            map[m[1]] = block[1] === ">" ? normalized.join(" ").replace(/\s+/g, " ").trim() : normalized.join("\n").trim();
          } else {
            map[m[1]] = decodeYamlScalar(m[2]);
          }
        }
      }
      body = lines.slice(end + 1).join("\n");
    }
  }
  return { fields, map, body };
}

/** 读取 YAML 标量的显示值；不依赖第三方 YAML 解析器。 */
function decodeYamlScalar(v) {
  const s = String(v == null ? "" : v).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      const value = JSON.parse(s);
      if (typeof value === "string") return value;
    } catch {
      /* 保留无法解析的原始内容 */
    }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function unquote(v) {
  const s = String(v == null ? "" : v).trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 仅更新调用策略行，避免重写并破坏其他 YAML frontmatter。
 *  启用时删除这两行以恢复缺省可调用，不还原这两行的原始文本或行内注释。 */
function updateInvocationPolicy(text, enabled) {
  const source = String(text);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return null;
  const fields = lines.slice(1, end).filter((line) => !/^(disable-model-invocation|user-invocable)\s*:/.test(line));
  if (!enabled) fields.push("disable-model-invocation: true", "user-invocable: false");
  return ["---", ...fields, "---", ...lines.slice(end + 1)].join(newline);
}

/** 同目录临时文件加 rename，避免写入中断时截断原 SKILL.md。 */
async function writeFileAtomically(path, content) {
  const temp = join(dirname(path), `.${basename(path)}.dssm-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, content, "utf8");
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 解析布尔字段值；合法布尔返回 true/false，非法返回 undefined。 */
export function parseBoolValue(raw) {
  const v = unquote(raw).trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === "false" || v === "no" || v === "off" || v === "0") return false;
  return undefined;
}

// ── 条目定位 / 扫描 ─────────────────────────────────────────────────────────

/** 按名称解析条目（bundle 优先，其次 flat）。找不到返回 null。 */
export async function resolveEntry(root, name) {
  const bundlePath = entryPath(root, name);
  if (bundlePath === null) return null;
  const rootPath = resolve(root);
  const rootReal = await resolvedPath(rootPath);
  const bundleStat = await lstatOrNull(bundlePath);
  if (bundleStat && bundleStat.isDirectory() && !bundleStat.isSymbolicLink()) {
    const bundleDoc = join(bundlePath, "SKILL.md");
    const docStat = await lstatOrNull(bundleDoc);
    if (docStat && docStat.isFile() && !docStat.isSymbolicLink() && await isInsideResolvedRoot(rootReal, bundleDoc)) {
      return { kind: "bundle", docPath: bundleDoc, entryPath: bundlePath };
    }
  }
  const flatDoc = resolve(rootPath, `${name}.md`);
  if (!isSameOrDescendant(rootPath, flatDoc) || rootPath === flatDoc) return null;
  const flatStat = await lstatOrNull(flatDoc);
  if (flatStat && flatStat.isFile() && !flatStat.isSymbolicLink() && await isInsideResolvedRoot(rootReal, flatDoc)) {
    return { kind: "flat", docPath: flatDoc, entryPath: flatDoc };
  }
  return null;
}

function entryOf(name, kind, docPath, doc) {
  const description = doc.map.description !== undefined ? unquote(doc.map.description) : "";
  const modelValue = parseBoolValue(doc.map["disable-model-invocation"]);
  const userValue = parseBoolValue(doc.map["user-invocable"]);
  const modelDisabled = modelValue === true;
  const userDisabled = userValue === false;
  const invocationPolicyValid = (doc.map["disable-model-invocation"] === undefined || modelValue !== undefined) && (doc.map["user-invocable"] === undefined || userValue !== undefined);
  return {
    name,
    kind,
    docPath,
    description,
    modelInvocable: !modelDisabled,
    userInvocable: !userDisabled,
    invocationPolicyValid,
  };
}

/** 扫描一个技能根（只扫一层）。返回 { exists, entries }。 */
export async function scanEntries(root) {
  let items;
  try {
    items = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { exists: false, entries: [] };
  }
  const byName = new Map();
  const rootReal = await resolvedPath(root);
  for (const it of items) {
    try {
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory() && entryPath(root, it.name) !== null) {
        const docPath = join(root, it.name, "SKILL.md");
        const st = await lstatOrNull(docPath);
        if (!st || !st.isFile() || st.isSymbolicLink() || !(await isInsideResolvedRoot(rootReal, docPath))) continue;
        const doc = parseSkillDoc(await fs.readFile(docPath, "utf8"));
        byName.set(it.name, entryOf(it.name, "bundle", docPath, doc));
      } else if (it.isFile() && it.name.toLowerCase().endsWith(".md") && it.name.toLowerCase() !== "skill.md" && entryPath(root, it.name.slice(0, -3)) !== null) {
        const skillName = it.name.slice(0, -3);
        if (byName.has(skillName)) continue;
        const docPath = join(root, it.name);
        if (!(await isInsideResolvedRoot(rootReal, docPath))) continue;
        const doc = parseSkillDoc(await fs.readFile(docPath, "utf8"));
        byName.set(skillName, entryOf(skillName, "flat", docPath, doc));
      }
    } catch {
      /* 跳过不可读条目 */
    }
  }
  const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { exists: true, entries };
}

// ── 启用 / 停用（同时控制模型与 / 手动调用，非破坏）──────────────────────────

/** enabled=true 恢复模型与 / 手动调用；false 同时停用两种调用入口。 */
export async function setSkillEnabled(root, name, enabled, log) {
  if (!isDshRoot(root)) return readonlyError("toggle");
  const resolved = await resolveEntry(root, name);
  if (resolved === null) return { ok: false, error: `技能不存在: ${name}`, code: "error.skill.notFound", params: { name } };
  const source = await fs.readFile(resolved.docPath, "utf8");
  const updated = updateInvocationPolicy(source, enabled);
  if (updated === null) return { ok: false, error: `技能缺少完整 frontmatter，无法${enabled ? "启用" : "停用"}: ${name}`, code: "error.skill.noFrontmatter", params: { name, action: enabled ? "enable" : "disable" } };
  await writeFileAtomically(resolved.docPath, updated);
  if (log) log(enabled ? "enable" : "disable", `${enabled ? "启用" : "停用"} ${resolved.docPath}`);
  return { name, enabled };
}

/** 删除 DSH 根目录中的单个技能。调用方必须先向用户确认。 */
export async function deleteSkill(root, name, log) {
  if (!isDshRoot(root)) return readonlyError("delete");
  const resolved = await resolveEntry(root, name);
  if (resolved === null) return { ok: false, error: `技能不存在: ${name}`, code: "error.skill.notFound", params: { name } };
  const bundlePath = entryPath(root, name);
  const alternatePath = resolved.kind === "bundle" ? resolve(root, `${name}.md`) : bundlePath;
  const alternateDocPath = resolved.kind === "bundle" ? alternatePath : join(alternatePath, "SKILL.md");
  const targets = [{ path: resolved.entryPath, recursive: resolved.kind === "bundle" }];
  // 链接形态的伴随条目也要清理本体；fs.rm 只删除链接本身，不会跟随写到根外。
  const alternateStat = await lstatOrNull(alternateDocPath);
  if (alternateStat && (alternateStat.isFile() || alternateStat.isSymbolicLink())) targets.push({ path: alternatePath, recursive: resolved.kind !== "bundle" });
  for (const target of targets) await fs.rm(target.path, { recursive: target.recursive, force: true });
  if (log) log("delete", `删除 ${targets.map((target) => target.path).join("、")}`);
  return { name };
}

// ── 导入 ────────────────────────────────────────────────────────────────────

/** 分析来源：单 skill 目录 / 单 .md 文件 / 批量目录。 */
async function analyzeSource(source) {
  let st;
  try {
    st = await fs.lstat(source);
  } catch {
    return { kind: "none", error: `路径不存在: ${source}`, code: "error.source.notFound", params: { path: source } };
  }
  if (st.isSymbolicLink()) return { kind: "none", error: `不支持包含符号链接的 skill 来源: ${source}`, code: "error.source.symlink", params: { path: source } };
  if (st.isDirectory()) {
    const sk = join(source, "SKILL.md");
    const skSt = await lstatOrNull(sk);
    // 预检与实际导入口径一致：SKILL.md 本身是链接时直接拒绝，避免 dry-run 通过、正式导入才失败。
    if (skSt && skSt.isSymbolicLink()) return { kind: "none", error: `不支持包含符号链接的 skill 来源: ${sk}`, code: "error.source.symlink", params: { path: sk } };
    if (skSt && skSt.isFile()) {
      return { kind: "single", rawName: basename(source), kebab: toKebab(basename(source)), source, isDir: true, skillFile: sk };
    }
    return { kind: "batch", rawName: basename(source), source, isDir: true };
  }
  if (st.isFile() && source.toLowerCase().endsWith(".md")) {
    if (basename(source).toLowerCase() === "skill.md") {
      const parent = dirname(source);
      return { kind: "single", rawName: basename(parent), kebab: toKebab(basename(parent)), source: parent, isDir: true, skillFile: source };
    }
    const rawName = basename(source).slice(0, -3);
    return { kind: "single", rawName, kebab: toKebab(rawName), source, isDir: false, skillFile: source };
  }
  return { kind: "none", error: `无法识别的 skill 来源: ${source}`, code: "error.source.unrecognized", params: { path: source } };
}

async function collectCandidates(dir) {
  const items = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const it of items) {
    if (it.isSymbolicLink()) throw codedError(`不支持包含符号链接的 skill 来源: ${join(dir, it.name)}`, "error.source.symlink", { path: join(dir, it.name) });
    if (it.isDirectory()) {
      const sk = join(dir, it.name, "SKILL.md");
      // lstatOrNull 吞掉 IO 异常（返回 null 即跳过）；symlink 必须抛出，不能被“跳过”逻辑掩盖。
      const st = await lstatOrNull(sk);
      if (st && st.isSymbolicLink()) throw codedError(`不支持包含符号链接的 skill 来源: ${sk}`, "error.source.symlink", { path: sk });
      if (st && st.isFile()) {
        out.push({ source: join(dir, it.name), kebab: toKebab(it.name), rawName: it.name, isDir: true });
      }
    } else if (it.isFile() && it.name.toLowerCase().endsWith(".md") && it.name.toLowerCase() !== "skill.md") {
      out.push({ source: join(dir, it.name), kebab: toKebab(it.name.slice(0, -3)), rawName: it.name.slice(0, -3), isDir: false });
    }
  }
  return out;
}

/** 导入/推送内容不接受符号链接，避免把目标目录外的内容带入技能目录或来源仓库。 */
export async function assertNoSymbolicLinks(source) {
  const pending = [{ path: source, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (current.depth > MAX_SOURCE_DEPTH) throw codedError(`skill 来源目录层级超过 ${MAX_SOURCE_DEPTH} 层: ${source}`, "error.source.tooDeep", { depth: MAX_SOURCE_DEPTH, path: source });
    const st = await fs.lstat(current.path);
    if (st.isSymbolicLink()) throw codedError(`不支持包含符号链接的 skill 来源: ${current.path}`, "error.source.symlink", { path: current.path });
    if (!st.isDirectory()) continue;
    const items = await fs.readdir(current.path, { withFileTypes: true });
    for (const item of items) {
      const path = join(current.path, item.name);
      if (item.isSymbolicLink()) throw codedError(`不支持包含符号链接的 skill 来源: ${path}`, "error.source.symlink", { path });
      if (item.isDirectory()) pending.push({ path, depth: current.depth + 1 });
    }
  }
}

function temporaryPath(target, kind) {
  return join(dirname(target), `.${basename(target)}.dssm-${kind}-${randomUUID()}`);
}

/** dry-run 预检执行与正式导入相同的符号链接/深度检查，预检失败即结论，不再进入覆盖确认。
 *  预检与实导之间来源被替换的竞态仍由实导阶段的复制后校验兜底。 */
async function preflightCandidates(pending, conflicts, failed) {
  for (const group of [pending, conflicts]) {
    for (let i = group.length - 1; i >= 0; i--) {
      const candidate = group[i];
      try {
        await assertNoSymbolicLinks(candidate.source);
      } catch (error) {
        failed.push(attachCode({ source: candidate.source, error: String(error && error.message ? error.message : error) }, error));
        group.splice(i, 1);
      }
    }
  }
}

/** 先复制到同目录临时路径，复制失败时不触碰现有技能。 */
async function copyToTemporary(source, target, isDir) {
  const temp = temporaryPath(target, "stage");
  try {
    await assertNoSymbolicLinks(source);
    if (isDir) await fs.cp(source, temp, { recursive: true, dereference: false });
    else await fs.copyFile(source, temp);
    await assertNoSymbolicLinks(temp);
    return temp;
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** 临时副本就绪后再替换；替换失败时尽力恢复旧条目。 */
async function replaceWithCopy(source, dest, isDir, existing = []) {
  const stage = await copyToTemporary(source, dest, isDir);
  const backups = [];
  try {
    for (const path of existing) {
      const backup = temporaryPath(path, "backup");
      await fs.rename(path, backup);
      backups.push({ path, backup });
    }
    await fs.rename(stage, dest);
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    const rollbackFailures = [];
    for (const item of backups.reverse()) {
      try {
        await fs.rename(item.backup, item.path);
      } catch (rollbackError) {
        rollbackFailures.push(item.backup);
      }
    }
    if (rollbackFailures.length) {
      const causeText = String(error && error.message ? error.message : error);
      throw codedError(
        `${causeText}；覆盖导入回滚失败，备份保留在: ${rollbackFailures.join("、")}`,
        "error.import.rollbackFailed",
        { path: rollbackFailures.join("; "), error: causeText },
      );
    }
    throw error;
  }
  const warnings = [];
  for (const item of backups) {
    try {
      await fs.rm(item.backup, { recursive: true, force: true });
    } catch (error) {
      warnings.push({
        code: "warning.backupUncleaned",
        params: { path: item.backup, error: String(error && error.message ? error.message : error) },
        error: `旧版本备份未清理: ${item.backup}（${String(error && error.message ? error.message : error)}）`,
      });
    }
  }
  return warnings;
}

/**
 * 导入技能到目标根。
 * options: { conflict: 'skip'|'overwrite', dryRun: boolean }
 * 成功返回 { kind, imported, skipped, failed }；失败返回 { ok:false, error }。
 */
export async function importSkill(source, log, options = {}) {
  const targetRoot = dshRootPath();
  const conflict = options.conflict === "overwrite" ? "overwrite" : "skip";
  const dryRun = options.dryRun === true;

  const analysis = await analyzeSource(source);
  if (analysis.kind === "none") return { ok: false, error: analysis.error || "无法识别的 skill 来源", code: analysis.code || "error.source.unrecognized", params: analysis.params };
  if (await pathsOverlap(analysis.source, targetRoot)) return { ok: false, error: "导入来源不能与 DSH 技能目录相同、包含或位于其中", code: "error.import.overlap" };

  let candidates = [];
  if (analysis.kind === "single") {
    candidates = [{ source: analysis.source, kebab: analysis.kebab, rawName: analysis.rawName, isDir: analysis.isDir }];
  } else {
    try {
      candidates = await collectCandidates(source);
    } catch (error) {
      return attachCode({ ok: false, error: String(error && error.message ? error.message : error) }, error);
    }
    if (candidates.length === 0) return { ok: false, error: `目录下未找到任何 skill 条目（需含 SKILL.md 的子目录或 .md 文件）: ${source}`, code: "error.import.emptySource", params: { path: source } };
  }

  const pending = [];
  const conflicts = [];
  const failed = [];
  const imported = [];
  const skipped = [];

  const nameCount = new Map();
  for (const candidate of candidates) {
    if (candidate.kebab && KEBAB_RE.test(candidate.kebab) && entryPath(targetRoot, candidate.kebab) !== null) nameCount.set(candidate.kebab, (nameCount.get(candidate.kebab) || 0) + 1);
  }

  function failureResult() {
    return {
      ok: false,
      // 聚合失败明细的原文；前端优先展示已翻译的 failed 明细，此处仅作兜底。
      error: failed.map((item) => item.error).join("；"),
      code: "error.import.failed",
      kind: analysis.kind,
      imported,
      skipped,
      failed,
    };
  }

  for (const c of candidates) {
    if (!c.kebab || !KEBAB_RE.test(c.kebab) || entryPath(targetRoot, c.kebab) === null) {
      failed.push({ source: c.source, error: `无法生成合法 kebab-case 名称（原始名: ${c.rawName || basename(c.source)}）`, code: "error.import.invalidName", params: { name: c.rawName || basename(c.source) } });
      continue;
    }
    if (nameCount.get(c.kebab) > 1) {
      failed.push({ source: c.source, error: `批量来源中存在多个同名插件: ${c.kebab}`, code: "error.import.duplicateName", params: { name: c.kebab } });
      continue;
    }
    const dest = c.isDir ? join(targetRoot, c.kebab) : join(targetRoot, `${c.kebab}.md`);
    const paths = [join(targetRoot, c.kebab), join(targetRoot, `${c.kebab}.md`)];
    const existing = [];
    for (const path of paths) {
      try {
        await fs.stat(path);
        existing.push(path);
      } catch {}
    }
    if (existing.length) {
      conflicts.push({ name: c.kebab, source: c.source, isDir: c.isDir, paths: existing });
      continue;
    }
    pending.push({ name: c.kebab, source: c.source, isDir: c.isDir, dest });
  }

  if (pending.length === 0 && conflicts.length === 0) return failureResult();

  if (dryRun) {
    // 预检即结论：与正式导入同口径执行符号链接/深度检查，避免预检通过、确认覆盖后实导才失败。
    await preflightCandidates(pending, conflicts, failed);
    if (pending.length === 0 && conflicts.length === 0) return failureResult();
    return { kind: analysis.kind, pending, conflicts, failed };
  }

  if (pending.length > 0 || (conflict === "overwrite" && conflicts.length > 0)) {
    await fs.mkdir(targetRoot, { recursive: true });
  }

  for (const p of pending) {
    try {
      const warnings = await replaceWithCopy(p.source, p.dest, p.isDir);
      imported.push({ name: p.name, overwritten: false, warnings });
      if (log) log("import", `导入 ${p.source} -> ${p.dest}`);
    } catch (e) {
      failed.push(attachCode({ source: p.source, error: String(e && e.message ? e.message : e) }, e));
    }
  }

  if (conflict === "overwrite") {
    for (const c of conflicts) {
      try {
        const dest = c.isDir ? join(targetRoot, c.name) : join(targetRoot, `${c.name}.md`);
        const warnings = await replaceWithCopy(c.source, dest, c.isDir, c.paths);
        imported.push({ name: c.name, overwritten: true, warnings });
        if (log) log("import-overwrite", `覆盖导入 ${c.source} -> ${dest}`);
      } catch (e) {
        failed.push(attachCode({ source: c.source, error: String(e && e.message ? e.message : e) }, e));
      }
    }
  } else {
    for (const c of conflicts) skipped.push({ name: c.name, source: c.source });
  }

  if (failed.length && imported.length === 0) return failureResult();
  return { kind: analysis.kind, imported, skipped, failed };
}

// ── 插件配置：来源仓库与令牌（$DSH_HOME\dsh-skills-manager.json）────────────
//
// gitRepo.url 为技能推送的来源 GitHub 仓库；gitRepo.subdir 为仓库内技能所在
// 子目录（留空时自动识别 skills/ 目录）。gitToken 仅在本机使用，GET 不回传。
// 全部函数沿用业务结果约定：失败返回 { ok:false, code, params, error }。

export function configPath() {
  return join(resolveDshHome(), "dsh-skills-manager.json");
}

function sanitizeGitRepo(raw) {
  const repo = raw && typeof raw === "object" ? raw : {};
  const url = typeof repo.url === "string" ? repo.url.trim() : "";
  const subdir = typeof repo.subdir === "string" ? repo.subdir.trim().replace(/^\/+|\/+$/g, "") : "";
  return { url, subdir };
}

/** 读取配置；文件缺失或损坏时返回缺省值，不把读失败当业务错误。 */
export async function readConfig() {
  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(configPath(), "utf8"));
  } catch {
    /* 缺省配置 */
  }
  const token = parsed && typeof parsed.gitToken === "string" ? parsed.gitToken : "";
  return { gitRepo: sanitizeGitRepo(parsed && parsed.gitRepo), gitToken: token };
}

/** 校验 GitHub https 仓库地址；返回规整后的裸地址（不带 .git 与凭据）。 */
export function validateGitRepoUrl(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (value === "") return { ok: false, code: "error.config.invalidUrl", error: "来源仓库地址不能为空" };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, code: "error.config.invalidUrl", error: "来源仓库地址不是合法 URL" };
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    return { ok: false, code: "error.config.invalidUrl", error: "来源仓库仅支持 https://github.com 地址" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: "error.config.invalidUrl", error: "来源仓库地址不允许内嵌用户名或令牌" };
  }
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length < 2) return { ok: false, code: "error.config.invalidUrl", error: "来源仓库地址缺少 owner/repo" };
  const repoName = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9._-]+$/.test(parts[0]) || !/^[A-Za-z0-9._-]+$/.test(repoName)) {
    return { ok: false, code: "error.config.invalidUrl", error: "来源仓库地址中的 owner/repo 不合法" };
  }
  return { ok: true, value: `https://github.com/${parts[0]}/${repoName}` };
}

/** 校验仓库内子目录：只允许普通相对路径段，禁止穿越。 */
export function validateRepoSubdir(raw) {
  const value = String(raw == null ? "" : raw).trim().replace(/^\/+|\/+$/g, "");
  if (value === "") return { ok: true, value: "" };
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      return { ok: false, code: "error.config.invalidSubdir", error: "来源仓库子目录包含非法路径段" };
    }
  }
  return { ok: true, value };
}

/** 校验令牌文本（仅做长度与字符粗检，不校验其有效范围）。 */
function validateGitToken(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (value.length > 512) return { ok: false, code: "error.config.invalidToken", error: "GitHub 令牌过长" };
  if (value !== "" && /[\r\n]/.test(value)) return { ok: false, code: "error.config.invalidToken", error: "GitHub 令牌不能包含换行" };
  return { ok: true, value };
}

/**
 * 保存配置补丁。只接受 gitRepo.url / gitRepo.subdir / gitToken 三个字段；
 * 成功返回不含令牌的公开配置 { gitRepo }。令牌为空串表示保留现有令牌，
 * 显式置 null 表示清除。
 */
export async function saveConfig(patch) {
  const current = await readConfig();
  const nextRepo = { url: current.gitRepo.url, subdir: current.gitRepo.subdir };
  let nextToken = current.gitToken;
  if (patch && typeof patch.gitRepo === "object") {
    if (patch.gitRepo.url !== undefined) {
      const checked = validateGitRepoUrl(patch.gitRepo.url);
      if (checked.ok !== true) return { ok: false, code: checked.code, error: checked.error };
      nextRepo.url = checked.value;
    }
    if (patch.gitRepo.subdir !== undefined) {
      const checked = validateRepoSubdir(patch.gitRepo.subdir);
      if (checked.ok !== true) return { ok: false, code: checked.code, error: checked.error };
      nextRepo.subdir = checked.value;
    }
  }
  if (patch && "gitToken" in patch && patch.gitToken !== null) {
    const checked = validateGitToken(patch.gitToken);
    if (checked.ok !== true) return { ok: false, code: checked.code, error: checked.error };
    nextToken = checked.value;
  }
  if (patch && "gitToken" in patch && patch.gitToken === null) nextToken = "";
  const payload = { gitRepo: nextRepo };
  if (nextToken !== "") payload.gitToken = nextToken;
  await fs.mkdir(dirname(configPath()), { recursive: true });
  await writeFileAtomically(configPath(), `${JSON.stringify(payload, null, 2)}\n`);
  return { gitRepo: nextRepo };
}

// ── 来源仓库镜像与技能推送 ──────────────────────────────────────────────────
//
// 推送语义：把 DSH 技能目录中的一个技能整体同步到配置的来源仓库（缺省布局
// skills/<name>/），先刷新本地镜像到远端，再复制技能、提交并推送。镜像缓存
// 于 $DSH_HOME\.dsh-skills-manager\repos\<owner>__<repo>，只作为暂存区。

function repoSlug(url) {
  const parts = url.replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/g, "").split("/");
  const owner = (parts[0] || "unknown").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const repo = (parts[1] || "unknown").toLowerCase().replace(/\.git$/i, "").replace(/[^a-z0-9-]/g, "-");
  return `${owner}__${repo}`;
}

function mirrorRoot() {
  return join(resolveDshHome(), ".dsh-skills-manager", "repos");
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    const error = codedError(`git 命令无法启动: ${String(result.error.message || result.error)}`, "error.git.launch");
    throw error;
  }
  return result;
}

function gitTail(result) {
  return [result.stdout, result.stderr].join("\n").trim().split("\n").slice(-6).join("\n").trim();
}

function isAuthFailure(result) {
  const text = String(result.stderr || "").toLowerCase();
  return /authentication failed|could not read username|invalid username or password|not authorized|access denied/i.test(text);
}

/** git 失败的结果对象：params.error 供前端词典占位，error 保留中文原文兜底。 */
function gitFail(message, tail) {
  const text = String(tail || "").trim();
  return {
    ok: false,
    code: "error.git.failed",
    params: { error: text || message },
    error: text ? `${message}：${text}` : message,
  };
}

/** 远端默认分支：优先 origin/HEAD，其次 ls-remote --symref。 */
function remoteDefaultBranch(mirror, url) {
  const headRef = runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], mirror);
  if (headRef.status === 0) {
    const name = headRef.stdout.trim().replace(/^origin\//, "");
    if (name !== "") return name;
  }
  const symref = runGit(["ls-remote", "--symref", url, "HEAD"], mirror);
  const match = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(symref.stdout);
  if (match && match[1]) return match[1];
  return "main";
}

async function isDirectory(path) {
  try {
    return (await fs.lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 克隆或刷新镜像到远端最新；返回 { mirror, branch }。 */
async function ensureMirror(url) {
  const mirror = join(mirrorRoot(), repoSlug(url));
  if (!(await isDirectory(mirror))) {
    await fs.mkdir(dirname(mirror), { recursive: true });
    const cloned = runGit(["clone", url, mirror]);
    if (cloned.status !== 0) throw codedError(`克隆来源仓库失败: ${gitTail(cloned)}`, "error.git.failed", { error: gitTail(cloned) });
  } else {
    const fetched = runGit(["fetch", "origin", "--prune"], mirror);
    if (fetched.status !== 0) throw codedError(`刷新来源仓库失败: ${gitTail(fetched)}`, "error.git.failed", { error: gitTail(fetched) });
  }
  const branch = remoteDefaultBranch(mirror, url);
  const reset = runGit(["reset", "--hard", `origin/${branch}`], mirror);
  if (reset.status !== 0) throw codedError(`对齐来源仓库 ${branch} 失败: ${gitTail(reset)}`, "error.git.failed", { error: gitTail(reset) });
  runGit(["clean", "-fdq"], mirror);
  return { mirror, branch };
}

/** 解析技能在镜像仓库中的目标路径；subdir 优先，否则仓库根 skills/ 目录。 */
async function skillDestination(mirror, subdir, entry) {
  let base;
  if (subdir !== "") base = join(mirror, ...subdir.split("/"));
  else if (await isDirectory(join(mirror, "skills"))) base = join(mirror, "skills");
  else base = mirror;
  const dest = entry.kind === "bundle" ? join(base, entry.name) : join(base, `${entry.name}.md`);
  if (!isSameOrDescendant(mirror, dest) || dest === mirror) return null;
  return dest;
}

function withIdentityFallback(args, mirror) {
  const identity = runGit(["config", "user.name"], mirror);
  if (identity.status !== 0 || identity.stdout.trim() === "") {
    return ["-c", "user.name=dsh-skills-manager", "-c", "user.email=dsh-skills-manager@localhost", ...args];
  }
  return args;
}

/**
 * 把 DSH 根目录中的技能推送到配置的来源仓库。
 * options: { dryRun, log }；dryRun 只比对差异不提交推送。
 * 成功：{ ok:true, changed, files, commit?, branch, repo, destination }
 */
export async function pushSkillToSource(root, name, options = {}) {
  const dryRun = options && options.dryRun === true;
  if (!isDshRoot(root)) return readonlyError("push");
  const resolved = await resolveEntry(root, name);
  if (resolved === null) return { ok: false, code: "error.skill.notFound", params: { name }, error: `技能不存在: ${name}` };
  const config = await readConfig();
  const rawUrl = config.gitRepo && config.gitRepo.url;
  if (!rawUrl) {
    return { ok: false, code: "error.push.noRepo", error: "尚未配置来源仓库，请在「仓库」页填写 GitHub 仓库地址" };
  }
  const checked = validateGitRepoUrl(rawUrl);
  if (checked.ok !== true) return { ok: false, code: checked.code, error: `配置的来源仓库地址无效: ${rawUrl}` };
  const url = checked.value;
  try {
    await assertNoSymbolicLinks(resolved.entryPath);
  } catch (error) {
    return attachCode({ ok: false, error: String(error && error.message ? error.message : error) }, error);
  }
  let mirror;
  let branch;
  try {
    const ensured = await ensureMirror(url);
    mirror = ensured.mirror;
    branch = ensured.branch;
  } catch (error) {
    return attachCode({ ok: false, error: String(error && error.message ? error.message : error) }, error);
  }
  const dest = await skillDestination(mirror, config.gitRepo.subdir || "", resolved);
  if (dest === null) {
    return { ok: false, code: "error.push.unsafeDest", error: "无法把该技能映射到来源仓库内的安全路径" };
  }
  const relativeDest = relative(mirror, dest).split(sep).join("/");
  try {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(dirname(dest), { recursive: true });
    if (resolved.kind === "bundle") await fs.cp(resolved.entryPath, dest, { recursive: true, dereference: false });
    else await fs.copyFile(resolved.docPath, dest);
  } catch (error) {
    return attachCode({ ok: false, error: `写入镜像失败: ${String(error && error.message ? error.message : error)}` }, error);
  }
  const status = runGit(["status", "--porcelain", "--", relativeDest], mirror);
  if (status.status !== 0) return gitFail("读取差异失败", gitTail(status));
  const files = status.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (files.length === 0) return { ok: true, changed: false, files: [], branch, repo: url, destination: relativeDest };
  if (dryRun) return { ok: true, changed: true, files, branch, repo: url, destination: relativeDest, dryRun: true };
  const staged = runGit(["add", "--", relativeDest], mirror);
  if (staged.status !== 0) return gitFail("暂存失败", gitTail(staged));
  const commit = runGit(withIdentityFallback(["commit", "-m", `feat(skills): 更新 ${name}（由 DSH 技能管理推送）`, "--", relativeDest], mirror), mirror);
  if (commit.status !== 0) return gitFail("提交失败", gitTail(commit));
  const token = config.gitToken || process.env.GITHUB_TOKEN || "";
  const pushUrl = token ? `https://${token}@github.com/${url.replace(/^https:\/\/github\.com\//i, "")}` : url;
  const pushed = runGit(["push", pushUrl, `HEAD:${branch}`], mirror);
  if (pushed.status !== 0) {
    if (isAuthFailure(pushed)) {
      return { ok: false, code: "error.push.auth", error: "推送被拒绝：未提供有效令牌。请设置环境变量 GITHUB_TOKEN，或在「仓库」页配置 GitHub 令牌" };
    }
    return gitFail("推送失败", gitTail(pushed));
  }
  const sha = runGit(["rev-parse", "--short", "HEAD"], mirror).stdout.trim();
  if (options && typeof options.log === "function") options.log("push", `推送 ${name} -> ${url} ${relativeDest} (${sha})`);
  return { ok: true, changed: true, files, commit: sha, branch, repo: url, destination: relativeDest };
}

// ── 状态快照 ────────────────────────────────────────────────────────────────

/** DSH 与公共 Agent 根目录技能快照。 */
export async function state() {
  const roots = userRoots();
  const result = { roots: [] };
  for (const root of roots) {
    const { exists, entries } = await scanEntries(root.path);
    const skills = [];
    for (const e of entries) {
      skills.push({
        name: e.name,
        kind: e.kind,
        description: e.description,
        modelInvocable: e.modelInvocable,
        userInvocable: e.userInvocable,
        invocationPolicyValid: e.invocationPolicyValid,
      });
    }
    result.roots.push({ key: root.key, path: root.path, label: root.label, mutable: root.mutable, exists, skills });
  }
  return result;
}

export { KEBAB_RE };
