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

import { homedir, tmpdir } from "node:os";
import { join, basename, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

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

function dshRootPath() {
  return userRoots().find((root) => root.key === "dsh").path;
}

/** 公共 Agent 目录的只读拒绝结果；action 为可翻译语义值（toggle/delete）。 */
function readonlyError(action) {
  return {
    ok: false,
    code: "error.root.readonly",
    params: { action },
    error: action === "delete" ? "公共 Agent 技能目录不允许删除" : "公共 Agent 技能目录不允许启用或停用",
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

/** 导入内容不接受符号链接，避免把目标目录外的内容带入技能目录。 */
async function assertNoSymbolicLinks(source) {
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

// ── 源文件夹持久化与同步 ────────────────────────────────────────────────────

/** 源文件夹设置文件路径，与审计日志同驻 $DSH_HOME。 */
function settingsPath() {
  return join(resolveDshHome(), "dsh-skills-manager.json");
}

/** 读取源文件夹设置；文件缺失或内容损坏时返回空对象。 */
export async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 校验源文件夹：必须是非空路径、存在的真实目录，且不与 DSH 技能根重叠。 */
async function validateSourceFolder(source) {
  if (typeof source !== "string" || source.trim() === "") {
    return { ok: false, error: "源文件夹路径为空", code: "error.folder.invalidPath", params: { path: "" } };
  }
  const path = resolve(source.trim());
  const st = await lstatOrNull(path);
  if (!st) return { ok: false, error: `路径不存在: ${source}`, code: "error.source.notFound", params: { path: source } };
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { ok: false, error: `不是有效目录: ${source}`, code: "error.folder.invalidPath", params: { path: source } };
  }
  if (await pathsOverlap(path, dshRootPath())) {
    return { ok: false, error: "源文件夹不能与 DSH 技能目录相同、包含或位于其中", code: "error.import.overlap" };
  }
  return { ok: true, path };
}

/** 保存源文件夹路径（持久化），供「刷新文件夹」反复扫描。 */
export async function saveSourceFolder(source, log) {
  const validated = await validateSourceFolder(source);
  if (!validated.ok) return validated;
  const settings = await loadSettings();
  settings.sourceFolder = validated.path;
  await writeFileAtomically(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  if (log) log("folder.save", `保存源文件夹 ${validated.path}`);
  return { sourceFolder: validated.path };
}

/** 清除已保存的源文件夹。 */
export async function clearSourceFolder(log) {
  const settings = await loadSettings();
  const previous = typeof settings.sourceFolder === "string" ? settings.sourceFolder : "";
  delete settings.sourceFolder;
  await writeFileAtomically(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  if (log) log("folder.clear", `清除源文件夹 ${previous}`);
  return { sourceFolder: null };
}

/** 扫描已保存的源文件夹，把其中的 skill 导入 DSH（同名跳过，不覆盖既有技能）。 */
export async function syncSourceFolder(log) {
  const settings = await loadSettings();
  const source = typeof settings.sourceFolder === "string" ? settings.sourceFolder : "";
  if (source === "") return { ok: false, error: "尚未保存源文件夹", code: "error.folder.notSet" };
  return importSkill(source, log, { conflict: "skip" });
}

// ── GitHub 远程仓库导入 ──────────────────────────────────────────────────────

/** 识别常见 Git 仓库地址（https/http/ssh/git/file 协议或 git@ 缩写）。 */
function isGitUrl(url) {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|git@)/i.test(url);
}

/** 校验并返回规范化的 Git 仓库地址；非法输入返回业务错误。 */
export function normalizeRepoUrl(url) {
  if (typeof url !== "string" || url.trim() === "") {
    return { ok: false, error: "仓库地址为空", code: "error.github.invalidUrl", params: { url: "" } };
  }
  const trimmed = url.trim();
  if (!isGitUrl(trimmed)) {
    return { ok: false, error: `不是有效的 Git 仓库地址: ${url}`, code: "error.github.invalidUrl", params: { url } };
  }
  return { ok: true, url: trimmed };
}

/** 规范化仓库内子目录：允许空（根目录），拒绝绝对路径、盘符与 `..` 穿越。 */
export function normalizeSubdir(subdir) {
  if (typeof subdir !== "string" || subdir.trim() === "") return { ok: true, subdir: "" };
  const normalized = subdir.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (normalized === "") return { ok: true, subdir: "" };
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((seg) => seg === ".." || seg === "" || seg === ".")) {
    return { ok: false, error: `无效的仓库子目录: ${subdir}`, code: "error.github.invalidSubdir", params: { subdir } };
  }
  return { ok: true, subdir: normalized };
}

/** 运行一次 git 命令；失败时抛出带 stderr 的错误。 */
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || "").trim() || (error && error.message) || `git ${args[0]} failed`));
      else resolve(String(stdout || ""));
    });
  });
}

/** 传输层瞬时失败特征（网络抖动 / 本地代理异常 / TLS 握手失败）；命中才值得换参数重试。 */
function isTransientNetworkError(text) {
  return /schannel|handshake|ssl|tls|unable to access|could not resolve host|name or service not known|connection (?:reset|closed|refused|timed out)|timed out|timeout|reset by peer|early eof|recv failure|network is unreachable|failed to connect|hung up|fetch failed/i.test(String(text || ""));
}

/** 网络 git 命令依次尝试的传输参数组合。
 *  Windows 的 schannel 后端经本地代理访问 GitHub 时 TLS 握手偶发失败
 *  （"failed to receive handshake, SSL/TLS connection failed"），
 *  依次换显式 HTTP/1.1、OpenSSL 后端、直连重试；末项直连绕开本地代理。 */
const NETWORK_VARIANTS = [
  [],
  ["-c", "http.version=HTTP/1.1"],
  ["-c", "http.sslBackend=openssl"],
  ["-c", "http.proxy=", "-c", "https.proxy="],
];

/** 两次传输重试之间短暂停顿，等待瞬时网络故障自行恢复。 */
function networkRetryDelay() {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
}

/**
 * 依次用 NETWORK_VARIANTS 运行一次网络 git 命令；buildArgs(extra) 负责按组合拼参数。
 * 返回首个成功结果；非瞬时错误立即返回该结果；全部瞬时失败返回最后一次结果。
 */
async function runGitNetwork(buildArgs, cwd) {
  let last = null;
  for (const variant of NETWORK_VARIANTS) {
    const result = await runGitResult(buildArgs(variant), cwd);
    last = result;
    if (result.status === 0) return result;
    if (!isTransientNetworkError([result.stdout, result.stderr].join("\n"))) return result;
    await networkRetryDelay();
  }
  return last;
}

/** 浅克隆仓库到 dest；网络/权限/地址错误透传 git 的 stderr。
 *  Windows schannel 握手偶发失败或本地代理异常时，清空目标并按组合换参重试。 */
async function cloneGitRepo(url, dest) {
  let lastError;
  for (const variant of NETWORK_VARIANTS) {
    try {
      await runGit([...variant, "clone", "--depth", "1", url, dest]);
      return;
    } catch (error) {
      lastError = error;
      await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined);
      await fs.mkdir(dest, { recursive: true });
      if (!isTransientNetworkError(String(error && error.message ? error.message : error))) break;
      await networkRetryDelay();
    }
  }
  throw lastError;
}

/** 在克隆仓库内解析技能目录：显式子目录优先；留空时自动识别仓库内的 skills/ 子目录，否则退回仓库根。 */
async function repoSkillDir(tempRoot, sub) {
  if (sub !== "") {
    const dir = resolve(tempRoot, ...sub.split("/"));
    if (!isSameOrDescendant(tempRoot, dir) || dir === tempRoot) {
      const error = new Error(`仓库子目录越界: ${sub}`);
      error.code = "error.github.invalidSubdir";
      error.params = { subdir: sub };
      throw error;
    }
    return dir;
  }
  const skillsSub = resolve(tempRoot, "skills");
  const subStat = await lstatOrNull(skillsSub);
  return subStat && subStat.isDirectory() ? skillsSub : tempRoot;
}

/**
 * 从 GitHub 远程仓库导入 skill。
 * options.update 为 true 时用 overwrite 覆盖同名技能（即「更新」），否则跳过同名技能。
 * 返回 importSkill 的结果；克隆/校验失败返回 { ok: false, ... }。
 */
export async function importFromGitRepo(url, subdir, log, options = {}) {
  const normalizedUrl = normalizeRepoUrl(url);
  if (!normalizedUrl.ok) return normalizedUrl;
  const normalizedSub = normalizeSubdir(subdir);
  if (!normalizedSub.ok) return normalizedSub;

  const repoUrl = normalizedUrl.url;
  const sub = normalizedSub.subdir;
  const conflict = options.update === true ? "overwrite" : "skip";

  const tempRoot = await fs.mkdtemp(join(tmpdir(), "dssm-git-"));
  try {
    await cloneGitRepo(repoUrl, tempRoot);
    const skillsDir = await repoSkillDir(tempRoot, sub);
    const st = await lstatOrNull(skillsDir);
    if (!st || !st.isDirectory()) {
      return { ok: false, error: `仓库中不存在该子目录: ${sub || "(根目录)"}`, code: "error.source.notFound", params: { path: sub || repoUrl } };
    }
    return await importSkill(skillsDir, log, { conflict });
  } catch (error) {
    return { ok: false, error: `克隆仓库失败: ${String(error && error.message ? error.message : error)}`, code: "error.github.cloneFailed", params: { url: repoUrl } };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 保存 GitHub 仓库地址与子目录（持久化），供「更新」反复拉取。 */
export async function saveGitRepo(url, subdir, log) {
  const normalizedUrl = normalizeRepoUrl(url);
  if (!normalizedUrl.ok) return normalizedUrl;
  const normalizedSub = normalizeSubdir(subdir);
  if (!normalizedSub.ok) return normalizedSub;
  const settings = await loadSettings();
  settings.gitRepo = { url: normalizedUrl.url, subdir: normalizedSub.subdir };
  await writeFileAtomically(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  if (log) log("github.save", `保存 GitHub 仓库 ${normalizedUrl.url} (子目录: ${normalizedSub.subdir || "(根)"})`);
  return { gitRepo: settings.gitRepo };
}

/** 清除已保存的 GitHub 仓库。 */
export async function clearGitRepo(log) {
  const settings = await loadSettings();
  const previous = settings.gitRepo && typeof settings.gitRepo.url === "string" ? settings.gitRepo.url : "";
  delete settings.gitRepo;
  await writeFileAtomically(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  if (log) log("github.clear", `清除 GitHub 仓库 ${previous}`);
  return { gitRepo: null };
}

/** 重新拉取已保存的 GitHub 仓库并导入；options.update 为 true 时覆盖同名技能。 */
export async function syncGitRepo(log, options = {}) {
  const settings = await loadSettings();
  const repo = settings.gitRepo;
  if (!repo || typeof repo.url !== "string" || repo.url === "") {
    return { ok: false, error: "尚未保存 GitHub 仓库", code: "error.github.notSet" };
  }
  return importFromGitRepo(repo.url, repo.subdir, log, { update: options.update === true });
}

// ── 仓库技能浏览与单个导入：列出仓库 skill，逐个导入到本地 DSH ───────────────

/** bundle 条目的导入来源是其所在目录，flat 条目是 .md 文件本身。 */
function repoEntrySource(entry) {
  return entry.kind === "bundle" ? dirname(entry.docPath) : entry.docPath;
}

/** 读取已保存的来源仓库配置；未保存返回 null。 */
async function savedGitRepo() {
  const settings = await loadSettings();
  const repo = settings.gitRepo;
  if (!repo || typeof repo.url !== "string" || repo.url === "") return null;
  return { url: repo.url, subdir: typeof repo.subdir === "string" ? repo.subdir : "" };
}

/**
 * 列出来源仓库内的全部 skill（只读，不导入），并附带本地 DSH 的安装状态。
 * 成功返回 { ok:true, repo, subdir, directory, skills:[{name,kind,description,installed,localValid,enabled}] }。
 */
export async function listRepoSkills(url, subdir) {
  const normalizedUrl = normalizeRepoUrl(url);
  if (!normalizedUrl.ok) return normalizedUrl;
  const normalizedSub = normalizeSubdir(subdir);
  if (!normalizedSub.ok) return normalizedSub;
  const repoUrl = normalizedUrl.url;
  const sub = normalizedSub.subdir;

  const tempRoot = await fs.mkdtemp(join(tmpdir(), "dssm-list-"));
  try {
    await cloneGitRepo(repoUrl, tempRoot);
    const skillsDir = await repoSkillDir(tempRoot, sub);
    const st = await lstatOrNull(skillsDir);
    if (!st || !st.isDirectory()) {
      return { ok: false, error: `仓库中不存在该子目录: ${sub || "(根目录)"}`, code: "error.source.notFound", params: { path: sub || repoUrl } };
    }
    const scanned = await scanEntries(skillsDir);
    const local = new Map((await scanEntries(dshRootPath())).entries.map((entry) => [entry.name, entry]));
    const skills = scanned.entries.map((entry) => {
      // 本地导入会把条目名规整为 kebab-case（如 "Route Skill" -> "route-skill"），
      // 安装状态同时按原始名与 kebab 名匹配，避免误报未安装。
      const kebab = toKebab(entry.name);
      const found = local.get(entry.name) || (kebab !== "" && kebab !== entry.name ? local.get(kebab) : undefined);
      return {
        name: entry.name,
        kind: entry.kind,
        description: entry.description,
        installed: found !== undefined,
        localValid: found === undefined || found.invocationPolicyValid,
        enabled: found !== undefined && found.invocationPolicyValid && found.modelInvocable && found.userInvocable,
      };
    });
    return { ok: true, repo: repoUrl, subdir: sub, directory: relative(tempRoot, skillsDir).split(sep).join("/"), skills };
  } catch (error) {
    return { ok: false, error: `克隆仓库失败: ${String(error && error.message ? error.message : error)}`, code: "error.github.cloneFailed", params: { url: repoUrl } };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 列出已保存来源仓库内的全部 skill；未保存仓库返回 notSet。 */
export async function listSavedRepoSkills() {
  const repo = await savedGitRepo();
  if (repo === null) return { ok: false, error: "尚未保存 GitHub 仓库", code: "error.github.notSet" };
  return listRepoSkills(repo.url, repo.subdir);
}

/**
 * 从来源仓库导入单个 skill 到本地 DSH。
 * options.update 为 true 时覆盖同名（「更新」），否则跳过同名。
 * 成功返回 importSkill 的结果形态；克隆/校验失败返回 { ok:false }。
 */
export async function importRepoSkill(url, subdir, name, log, options = {}) {
  const normalizedUrl = normalizeRepoUrl(url);
  if (!normalizedUrl.ok) return normalizedUrl;
  const normalizedSub = normalizeSubdir(subdir);
  if (!normalizedSub.ok) return normalizedSub;
  const skillName = String(name == null ? "" : name).trim();
  if (skillName === "") {
    return { ok: false, error: "技能名称不能为空", code: "error.skill.notFound", params: { name: "" } };
  }
  const repoUrl = normalizedUrl.url;
  const sub = normalizedSub.subdir;

  const tempRoot = await fs.mkdtemp(join(tmpdir(), "dssm-import-"));
  try {
    await cloneGitRepo(repoUrl, tempRoot);
    const skillsDir = await repoSkillDir(tempRoot, sub);
    const st = await lstatOrNull(skillsDir);
    if (!st || !st.isDirectory()) {
      return { ok: false, error: `仓库中不存在该子目录: ${sub || "(根目录)"}`, code: "error.source.notFound", params: { path: sub || repoUrl } };
    }
    const { entries } = await scanEntries(skillsDir);
    const target = entries.find((entry) => entry.name === skillName);
    if (!target) {
      return { ok: false, error: `仓库中不存在该技能: ${skillName}`, code: "error.github.skillNotFound", params: { name: skillName } };
    }
    return await importSkill(repoEntrySource(target), log, { conflict: options.update === true ? "overwrite" : "skip" });
  } catch (error) {
    return attachCode({ ok: false, error: `导入失败: ${String(error && error.message ? error.message : error)}`, code: "error.github.cloneFailed", params: { url: repoUrl } }, error);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 从已保存的来源仓库导入单个 skill；未保存仓库返回 notSet。 */
export async function importSavedRepoSkill(name, log, options = {}) {
  const repo = await savedGitRepo();
  if (repo === null) return { ok: false, error: "尚未保存 GitHub 仓库", code: "error.github.notSet" };
  return importRepoSkill(repo.url, repo.subdir, name, log, options);
}

// ── 推送配置：与 GitHub 导入共用 settings.gitRepo；gitToken 为额外字段 ───────

function sanitizeGitRepoValue(raw) {
  const repo = raw && typeof raw === "object" ? raw : {};
  return {
    url: typeof repo.url === "string" ? repo.url : "",
    subdir: typeof repo.subdir === "string" ? repo.subdir : "",
  };
}

/** 读取公开推送配置（永不返回令牌）。 */
export async function pushConfig() {
  const settings = await loadSettings();
  return { gitRepo: sanitizeGitRepoValue(settings.gitRepo) };
}

/** 校验推送目标地址：仅允许 https://github.com，返回规整裸地址。 */
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
    return { ok: false, code: "error.config.invalidUrl", error: "推送目标仅支持 https://github.com 地址" };
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

/** 校验令牌文本：长度与换行粗检，不校验有效范围。 */
function validateGitTokenValue(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (value.length > 512) return { ok: false, code: "error.config.invalidToken", error: "GitHub 令牌过长" };
  if (value !== "" && /[\r\n]/.test(value)) return { ok: false, code: "error.config.invalidToken", error: "GitHub 令牌不能包含换行" };
  return { ok: true, value };
}

/** 保存推送配置。gitToken 传 '' 表示保留现有令牌，传 null 表示清除。 */
export async function savePushConfig(patch) {
  const settings = await loadSettings();
  const next = sanitizeGitRepoValue(settings.gitRepo);
  if (patch && typeof patch.gitRepo === "object") {
    if (patch.gitRepo.url !== undefined) {
      const checked = validateGitRepoUrl(patch.gitRepo.url);
      if (checked.ok !== true) return { ok: false, code: checked.code, error: checked.error };
      next.url = checked.value;
    }
    if (patch.gitRepo.subdir !== undefined) {
      const sub = normalizeSubdir(patch.gitRepo.subdir);
      if (sub.ok !== true) return { ok: false, code: "error.config.invalidSubdir", error: sub.error };
      next.subdir = sub.subdir;
    }
  }
  let nextToken = typeof settings.gitToken === "string" ? settings.gitToken : "";
  if (patch && "gitToken" in patch && patch.gitToken !== null) {
    const checked = validateGitTokenValue(patch.gitToken);
    if (checked.ok !== true) return { ok: false, code: checked.code, error: checked.error };
    nextToken = checked.value;
  }
  if (patch && "gitToken" in patch && patch.gitToken === null) nextToken = "";
  settings.gitRepo = next;
  if (nextToken === "") delete settings.gitToken;
  else settings.gitToken = nextToken;
  await writeFileAtomically(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  return { gitRepo: next };
}

/** 插件自身元信息（名称、版本、项目仓库），供「关于」页展示。 */
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

// ── 技能推送：把 DSH 技能同步回来源 GitHub 仓库 ─────────────────────────────
//
// 每次推送临时浅克隆来源仓库，刷新到远端最新后复制技能、比对差异、提交并推送，
// 完成后删除临时目录。推送只发生在 DSH 根目录（公共 Agent 目录始终只读）。

/** 运行 git 并返回 { status, stdout, stderr }（不抛错），便于按状态分流。 */
function runGitResult(args, cwd) {
  return new Promise((resolvePromise) => {
    execFile("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolvePromise({ status: code, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function gitTail(result) {
  return [result.stdout, result.stderr].join("\n").trim().split("\n").slice(-6).join("\n").trim();
}

function isAuthFailure(result) {
  const text = String(result.stderr || "").toLowerCase();
  return /authentication failed|could not read username|invalid username or password|not authorized|access denied/i.test(text);
}

/** git 失败结果：params.error 供词典占位，error 保留中文原文兜底。 */
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
async function remoteDefaultBranch(url, cwd) {
  const headRef = await runGitResult(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (headRef.status === 0) {
    const name = headRef.stdout.trim().replace(/^origin\//, "");
    if (name !== "") return name;
  }
  const symref = await runGitNetwork((extra) => [...extra, "ls-remote", "--symref", url, "HEAD"], cwd);
  const match = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(symref.stdout);
  return match && match[1] ? match[1] : "main";
}

/**
 * 浅克隆（多组合重试）：Windows schannel 握手偶发失败或本地代理异常时，
 * 依次换 HTTP/1.1、OpenSSL 后端、直连重试；返回成功结果或最后一次失败结果。
 */
async function cloneRepoShallow(url, dest) {
  let last = null;
  for (const variant of NETWORK_VARIANTS) {
    const result = await runGitResult([...variant, "-c", "core.autocrlf=false", "clone", "--depth", "1", url, dest]);
    last = result;
    if (result.status === 0) return result;
    if (!isTransientNetworkError([result.stdout, result.stderr].join("\n"))) return result;
    await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    await fs.mkdir(dest, { recursive: true });
    await networkRetryDelay();
  }
  return last;
}

/**
 * 把 DSH 根目录中的技能推送到配置的来源 GitHub 仓库。
 * options: { dryRun, log }；dryRun 只比对差异，不提交不推送。
 * 成功：{ ok:true, changed, files, commit?, branch, repo, destination }
 */
export async function pushSkillToSource(root, name, options = {}) {
  const dryRun = options && options.dryRun === true;
  if (!isDshRoot(root)) return readonlyError("push");
  const resolved = await resolveEntry(root, name);
  if (resolved === null) return { ok: false, code: "error.skill.notFound", params: { name }, error: `技能不存在: ${name}` };
  const settings = await loadSettings();
  const rawUrl = settings.gitRepo && typeof settings.gitRepo.url === "string" ? settings.gitRepo.url.trim() : "";
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
  const tempRoot = await fs.mkdtemp(join(tmpdir(), "dssm-push-"));
  try {
    const cloned = await cloneRepoShallow(url, tempRoot);
    if (cloned.status !== 0) return gitFail("克隆来源仓库失败", gitTail(cloned));
    const branch = await remoteDefaultBranch(url, tempRoot);
    let base;
    if (settings.gitRepo && settings.gitRepo.subdir) {
      base = resolve(tempRoot, ...settings.gitRepo.subdir.split("/"));
    } else {
      const skillsSub = join(tempRoot, "skills");
      const skillsStat = await lstatOrNull(skillsSub);
      base = skillsStat && skillsStat.isDirectory() ? skillsSub : tempRoot;
    }
    const dest = resolved.kind === "bundle" ? join(base, name) : join(base, `${name}.md`);
    if (!isSameOrDescendant(tempRoot, dest) || dest === tempRoot) {
      return { ok: false, code: "error.push.unsafeDest", error: "无法把该技能映射到来源仓库内的安全路径" };
    }
    const relativeDest = relative(tempRoot, dest).split(sep).join("/");
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(dirname(dest), { recursive: true });
    if (resolved.kind === "bundle") await fs.cp(resolved.entryPath, dest, { recursive: true, dereference: false });
    else await fs.copyFile(resolved.docPath, dest);
    // 先暂存再按「忽略行尾差异」比对：Windows 本地的 CRLF 与仓库 LF 只算换行差异，
    // 不是真实改动，不应允许推送（内容一致时 diff --cached --quiet 退出码为 0）。
    const staged = await runGitResult(["-c", "core.autocrlf=true", "add", "-A", "--", relativeDest], tempRoot);
    if (staged.status !== 0) return gitFail("暂存失败", gitTail(staged));
    const diff = await runGitResult(["-c", "core.autocrlf=true", "diff", "--cached", "--ignore-space-at-eol", "--quiet", "--", relativeDest], tempRoot);
    if (diff.status >= 2) return gitFail("读取差异失败", gitTail(diff));
    if (diff.status === 0) return { ok: true, changed: false, files: [], branch, repo: url, destination: relativeDest };
    const filesRes = await runGitResult(["diff", "--cached", "--name-only", "--", relativeDest], tempRoot);
    if (filesRes.status !== 0) return gitFail("读取差异失败", gitTail(filesRes));
    const files = filesRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (dryRun) return { ok: true, changed: true, files, branch, repo: url, destination: relativeDest, dryRun: true };
    const identity = await runGitResult(["config", "user.name"], tempRoot);
    const identityArgs = identity.status !== 0 || identity.stdout.trim() === ""
      ? ["-c", "user.name=dsh-skills-manager", "-c", "user.email=dsh-skills-manager@localhost"]
      : [];
    const commit = await runGitResult([...identityArgs, "-c", "core.autocrlf=true", "commit", "-m", `feat(skills): 更新 ${name}（由 DSH 技能管理推送）`], tempRoot);
    if (commit.status !== 0) return gitFail("提交失败", gitTail(commit));
    const token = (typeof settings.gitToken === "string" ? settings.gitToken : "") || process.env.GITHUB_TOKEN || "";
    const pushUrl = token ? `https://${token}@github.com/${url.replace(/^https:\/\/github\.com\//i, "")}` : url;
    const pushed = await runGitNetwork((extra) => [...extra, "push", pushUrl, `HEAD:${branch}`], tempRoot);
    if (pushed.status !== 0) {
      if (isAuthFailure(pushed)) {
        return { ok: false, code: "error.push.auth", error: "推送被拒绝：未提供有效令牌。请设置环境变量 GITHUB_TOKEN，或在「仓库」页配置 GitHub 令牌" };
      }
      const tail = gitTail(pushed);
      const hint = isTransientNetworkError([pushed.stdout, pushed.stderr].join("\n"))
        ? "已依次尝试默认、HTTP/1.1、OpenSSL 后端与直连仍失败：多为网络或代理瞬时故障，请检查后重试"
        : "";
      return gitFail("推送失败", hint ? `${tail}\n${hint}` : tail);
    }
    const sha = (await runGitResult(["rev-parse", "--short", "HEAD"], tempRoot)).stdout.trim();
    if (options && typeof options.log === "function") options.log("push", `推送 ${name} -> ${url} ${relativeDest} (${sha})`);
    return { ok: true, changed: true, files, commit: sha, branch, repo: url, destination: relativeDest };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── 状态快照 ────────────────────────────────────────────────────────────────

/** DSH 与公共 Agent 根目录技能快照，附带已保存的源文件夹路径与 GitHub 仓库。 */
export async function state() {
  const roots = userRoots();
  const settings = await loadSettings();
  const gitRepo = settings.gitRepo && typeof settings.gitRepo.url === "string" ? { url: settings.gitRepo.url, subdir: settings.gitRepo.subdir || "" } : null;
  const result = {
    roots: [],
    sourceFolder: typeof settings.sourceFolder === "string" ? settings.sourceFolder : null,
    gitRepo,
  };
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

export { KEBAB_RE, isTransientNetworkError };
