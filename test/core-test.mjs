// dsh-skills-manager core 单元测试（临时根，零第三方依赖）
// 运行：node test/core-test.mjs

import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  toKebab,
  parseSkillDoc,
  unquote,
  parseBoolValue,
  setSkillEnabled,
  deleteSkill,
  importSkill,
  scanEntries,
  state,
  resolveEntry,
  entryPath,
  userRoots,
  saveSourceFolder,
  clearSourceFolder,
  syncSourceFolder,
  normalizeRepoUrl,
  normalizeSubdir,
  saveGitRepo,
  clearGitRepo,
  syncGitRepo,
  importFromGitRepo,
  listRepoSkills,
  listSavedRepoSkills,
  importRepoSkill,
  importSavedRepoSkill,
  importRepoSkills,
  importSavedRepoSkills,
  loadSettings,
  pushConfig,
  savePushConfig,
  pluginMeta,
  pushSkillToSource,
  isTransientNetworkError,
} from "../lib/core.js";
import { apply as applyHost, notifyChatCatalog } from "../lib/index.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("✗ " + msg);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + " (got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected) + ")");
}

function requestJson(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function makeSkill(root, name, content) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
  return dir;
}

const tmp = await mkdtemp(join(tmpdir(), "dssm-test-"));
process.env.DSH_HOME = join(tmp, "dsh");
process.env.DSH_AGENTS_HOME = join(tmp, "agents");
const dshRoot = join(process.env.DSH_HOME, "skills");
const agentsRoot = join(process.env.DSH_AGENTS_HOME, "skills");
await mkdir(dshRoot, { recursive: true });
await mkdir(agentsRoot, { recursive: true });

// Linux 同样必须拒绝 Windows 保留设备名；Windows 无法创建这类来源，故仅在可创建的系统上做端到端断言。
if (process.platform !== "win32") {
  const reservedSourceRoot = join(tmp, "reserved-source");
  const reservedHome = join(tmp, "reserved-home");
  const reservedRoot = join(reservedHome, "skills");
  await mkdir(reservedSourceRoot, { recursive: true });
  const conSource = await makeSkill(reservedSourceRoot, "con", "---\nname: con\n---\nbody");
  const nulSource = join(reservedSourceRoot, "nul.md");
  await writeFile(nulSource, "---\nname: nul\n---\nbody", "utf8");
  const linkTarget = join(reservedSourceRoot, "link-target.md");
  await writeFile(linkTarget, "---\nname: link-target\n---\nbody", "utf8");
  const linkSource = join(reservedSourceRoot, "linked-source.md");
  await symlink(linkTarget, linkSource);
  const nestedLinkSource = await makeSkill(reservedSourceRoot, "nested-link", "---\nname: nested-link\n---\nbody");
  await symlink(linkTarget, join(nestedLinkSource, "linked-content.md"));
  const originalDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = reservedHome;
  try {
    for (const [source, name] of [[conSource, "con"], [nulSource, "nul"]]) {
      const result = await importSkill(source, null);
      ok(result.ok === false, `import rejects reserved device name: ${name}`);
      eq(result.failed[0].code, "error.import.invalidName", `reserved device name carries invalidName: ${name}`);
    }
    let targetCreated = true;
    try { await stat(reservedRoot); } catch { targetCreated = false; }
    ok(targetCreated === false, "reserved-name imports do not create the target root");

    await makeSkill(reservedRoot, "con", "---\nname: con\n---\nbody");
    await writeFile(join(reservedRoot, "nul.md"), "---\nname: nul\n---\nbody", "utf8");
    eq((await scanEntries(reservedRoot)).entries.length, 0, "scan hides entries that cannot be resolved safely");
    const linkedSourceImport = await importSkill(linkSource, null);
    eq(linkedSourceImport.code, "error.source.symlink", "import rejects a symbolic-link source");
    const nestedLinkImport = await importSkill(join(nestedLinkSource, "SKILL.md"), null);
    eq(nestedLinkImport.failed[0].code, "error.source.symlink", "import rejects a source containing a symbolic link");
    // 预检必须与实导同口径：嵌套链接与深度超限在 dry-run 阶段即拒绝，不能等用户确认覆盖后才失败。
    const nestedLinkDry = await importSkill(join(nestedLinkSource, "SKILL.md"), null, { dryRun: true });
    ok(nestedLinkDry.ok === false, "dry-run rejects a source containing a nested symbolic link");
    eq(nestedLinkDry.failed[0].code, "error.source.symlink", "nested-link dry-run carries the symlink code");
    const mixedBatch = join(reservedSourceRoot, "mixed-batch");
    const taintedSkill = await makeSkill(mixedBatch, "tainted", "---\nname: tainted\n---\nbody");
    await symlink(linkTarget, join(taintedSkill, "linked.md"));
    await writeFile(join(mixedBatch, "clean.md"), "---\nname: clean\n---\nbody", "utf8");
    const mixedDry = await importSkill(mixedBatch, null, { dryRun: true });
    ok(mixedDry.ok !== false, "mixed dry-run still reports the clean candidate");
    eq(mixedDry.pending.length, 1, "mixed dry-run keeps only the clean candidate pending");
    eq(mixedDry.failed[0].code, "error.source.symlink", "mixed dry-run fails the tainted candidate");
  } finally {
    process.env.DSH_HOME = originalDshHome;
  }
}

// ── 客户端装配约束 ──
// 客户端 bundle 由宿主 AMD 加载，无法在零依赖测试中直接挂载；仅保留协议常量锚点。
const clientSource = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
ok(clientSource.includes('id: "@deronghe/dsh-skills-manager"'), "client registers the scoped package module ID");
ok(clientSource.includes('"x-dsh-skills-manager": "1"'), "client sends the mutation request marker");
ok(clientSource.includes('className: "dssm-modal dssm-modal-upload"'), "upload dialog uses the adaptive modal class");
ok(clientSource.includes('.dssm-modal{box-sizing:border-box;display:flex;width:min(480px,100%)!important;height:auto!important;'), "all plugin dialogs stay compact against host stretch");
ok(clientSource.includes('.dssm-modal-upload{width:min(480px,100%)!important;height:auto!important;'), "upload dialog stays compact against host stretch");
ok(clientSource.includes('.dssm-dropzone{box-sizing:border-box;display:flex;width:100%;min-height:144px;flex:none;'), "dropzone keeps a compact height");
ok(clientSource.includes('.dssm-modal-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}'), "upload actions wrap instead of stretching the dialog");
ok(clientSource.includes('@media (max-width:560px){.dssm-mask{padding:12px;align-items:center}'), "upload dialog stays centered on a narrow viewport");
ok(clientSource.includes('id: "dssm-filter-search"'), "settings panel registers a skill search input");
ok(clientSource.includes('className: "dssm-tabs"'), "settings panel organizes content into tabs");
ok(clientSource.includes('role: "tablist"'), "tab bar declares the tablist role");
ok(clientSource.includes('t("btn.push")'), "skill rows offer a push action");
ok(clientSource.includes('callApi("/push"'), "client calls the push endpoint");
ok(clientSource.includes('callApi("/config"'), "client reads and writes repository settings");
ok(clientSource.includes('renderPushModal'), "client renders the push dialog");
ok(clientSource.includes("aria-selected\": tab === entry.key"), "active tab is announced to assistive tech");
ok(clientSource.includes('className: "dssm-field dssm-field-search"'), "search field follows the expert plugin filter layout");
ok(clientSource.includes('.dssm-search-clear{'), "search input provides a visible clear control");
ok(clientSource.includes('className: "dssm-select-trigger"'), "category filter uses the styled custom select");
ok(clientSource.includes('.dssm-select-menu{'), "custom select menu uses design tokens instead of native chrome");
ok(!/h\(\s*"select"/.test(clientSource), "category filter does not use a native select");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
ok(packageJson.peerDependencies["@deepseek-ai/dsh-client-runtime"], "package declares the client runtime peer");
ok(packageJson.peerDependencies["@deepseek-ai/dsh-client-ui-slots"], "package declares the settings slots peer");
ok(packageJson.peerDependencies["@deepseek-ai/dsh-host-webserver"].includes("<0.2.0"), "host-webserver peer has an upper bound");
ok(packageJson.peerDependencies["@deepseek-ai/dsh-skill"].includes("<0.2.0"), "skill peer has an upper bound");
ok(packageJson.peerDependencies["@deepseek-ai/dsh-client-ui-workspace"].includes("<0.2.0"), "workspace peer has an upper bound");
ok(clientSource.includes("inflightRef"), "client guards mutations with a synchronous in-flight flag");
ok(clientSource.includes('function executeImport(source, conflict, chained)') && clientSource.includes('if (inflightRef.current && !chained) return;'), "executeImport rejects a second in-flight call unless chained from the dry-run");
ok(clientSource.includes('executeImport(selected.source, "skip", true)'), "installSelected chains into executeImport explicitly, never via stale busy closures");
ok(clientSource.includes("importResult && !uploadOpen && !isUploadPickerError(importResult)"), "import results stay off the page while the upload dialog is open");
ok(/setUploadOpen\(false\);\s*setSelected\(null\);\s*setImportResult\(\{ error: error \}\)/.test(clientSource), "import failure clears the selected source with the dialog");

// ── 命名规整 ──
eq(toKebab("FooBar"), "foo-bar", "toKebab camelCase");
eq(toKebab("Foo Bar_Test"), "foo-bar-test", "toKebab mixed separators");
eq(toKebab("guizang-ppt-skill-main"), "guizang-ppt-skill-main", "toKebab already kebab");
eq(toKebab("  GuiZangPPT-Skill  "), "gui-zang-ppt-skill", "toKebab trim + acronym-ish");
eq(toKebab("中文名"), "", "toKebab non-ascii strips to empty");
eq(entryPath(dshRoot, "foo:bar"), null, "entryPath rejects Windows ADS names");
eq(entryPath(dshRoot, ".hidden"), null, "entryPath rejects leading-dot names");
eq(entryPath(dshRoot, ".good-skill.dssm-stage-dead"), null, "entryPath rejects leftover stage directories");
eq(entryPath(dshRoot, "a".repeat(129)), null, "entryPath rejects names longer than 128 characters");
ok(entryPath(dshRoot, "a".repeat(128)) !== null, "entryPath accepts a 128-character name");

// ── frontmatter 解析 ──
const protoDoc = parseSkillDoc("---\n__proto__: polluted\nname: proto\n---\nbody");
ok(Object.getPrototypeOf(protoDoc.map) === null, "frontmatter map uses a null prototype");
eq(protoDoc.map.name, "proto", "frontmatter still reads ordinary keys");
const bomDoc = parseSkillDoc("\uFEFF---\nname: foo\n---\nbody");
eq(bomDoc.map.name, "foo", "parseSkillDoc strips BOM");
eq(bomDoc.body, "body", "parseSkillDoc body");

const q = parseSkillDoc('---\nname: foo\ndescription: "has: colon"\ndisable-model-invocation: true\n---\nhello');
eq(q.map.description, "has: colon", "parseSkillDoc reads quoted value");
eq(unquote(q.map.description), "has: colon", "unquote");
eq(parseBoolValue("true"), true, "parseBoolValue true");
eq(parseBoolValue("YES"), true, "parseBoolValue yes");
eq(parseBoolValue("off"), false, "parseBoolValue off");
eq(parseBoolValue("0"), false, "parseBoolValue 0");
eq(parseBoolValue("notabool"), undefined, "parseBoolValue invalid");

const folded = parseSkillDoc("---\nname: folded\ndescription: >-\n  First line.\n  Second line.\n---\nbody");
eq(folded.map.description, "First line. Second line.", "parseSkillDoc reads folded description");
const deeplyIndented = parseSkillDoc("---\nname: indented\ndescription: |\n    First line.\n    Second line.\n---\nbody");
eq(deeplyIndented.map.description, "First line.\nSecond line.", "parseSkillDoc removes common block indentation");

// ── 启用 / 停用 ──
await makeSkill(dshRoot, "good-skill", "---\nname: good-skill\ndescription: A good skill.\n---\nbody");
const audit = [];
await setSkillEnabled(dshRoot, "good-skill", false, (event) => audit.push(event));
let goodDoc = parseSkillDoc(await readFile(join(dshRoot, "good-skill", "SKILL.md"), "utf8"));
eq(parseBoolValue(goodDoc.map["disable-model-invocation"]), true, "disable sets flag");
eq(parseBoolValue(goodDoc.map["user-invocable"]), false, "disable hides the skill from slash commands");
eq(audit.join(","), "disable", "disable writes an audit log event");
await setSkillEnabled(dshRoot, "good-skill", true, (event) => audit.push(event));
eq(audit.join(","), "disable,enable", "enable writes an audit log event");
goodDoc = parseSkillDoc(await readFile(join(dshRoot, "good-skill", "SKILL.md"), "utf8"));
ok(goodDoc.map["disable-model-invocation"] === undefined, "enable removes flag");
ok(goodDoc.map["user-invocable"] === undefined, "enable restores slash command visibility");
await makeSkill(dshRoot, "crlf-skill", "---\r\nname: crlf-skill\r\n---\r\nbody");
await setSkillEnabled(dshRoot, "crlf-skill", false);
const crlfAfterDisable = await readFile(join(dshRoot, "crlf-skill", "SKILL.md"), "utf8");
ok(!/(^|[^\r])\n/.test(crlfAfterDisable), "toggle preserves CRLF frontmatter files");
const quotedFrontmatter = '---\nname: quoted-skill\ndescription: "Quoted description: unchanged"\nmetadata:\n  source: retained\n---\nbody';
await makeSkill(dshRoot, "quoted-skill", quotedFrontmatter);
await setSkillEnabled(dshRoot, "quoted-skill", false);
await setSkillEnabled(dshRoot, "quoted-skill", true);
const quotedAfterToggle = await readFile(join(dshRoot, "quoted-skill", "SKILL.md"), "utf8");
eq(quotedAfterToggle, quotedFrontmatter, "toggle preserves quoted and nested frontmatter exactly");
const literalFrontmatter = "---\nname: literal-skill\ndescription: |\n  disable-model-invocation: explanatory text\n  user-invocable: explanatory text\n---\nbody";
await makeSkill(dshRoot, "literal-skill", literalFrontmatter);
await setSkillEnabled(dshRoot, "literal-skill", false);
const literalAfterToggle = await readFile(join(dshRoot, "literal-skill", "SKILL.md"), "utf8");
ok(literalAfterToggle.includes("  disable-model-invocation: explanatory text") && literalAfterToggle.includes("  user-invocable: explanatory text"), "toggle preserves block-scalar content that resembles policy fields");
await makeSkill(dshRoot, "trailing-root", "---\nname: trailing-root\n---\nbody");
const trailingRootToggle = await setSkillEnabled(dshRoot + sep, "trailing-root", false);
ok(trailingRootToggle.ok !== false, "toggle accepts a normalized DSH root path");
const missing = await setSkillEnabled(dshRoot, "no-such-skill", true);
ok(missing.ok === false, "setSkillEnabled missing returns error");
eq(missing.code, "error.skill.notFound", "missing skill carries the notFound code");
eq(missing.params && missing.params.name, "no-such-skill", "missing skill params.name");
await makeSkill(dshRoot, "plain-skill", "没有 frontmatter 的正文");
const plainToggle = await setSkillEnabled(dshRoot, "plain-skill", false);
ok(plainToggle.ok === false, "setSkillEnabled rejects skills without frontmatter");
eq(plainToggle.code, "error.skill.noFrontmatter", "no-frontmatter toggle carries the code");
eq(plainToggle.params && plainToggle.params.action, "disable", "no-frontmatter params.action");
eq(await readFile(join(dshRoot, "plain-skill", "SKILL.md"), "utf8"), "没有 frontmatter 的正文", "missing frontmatter remains unchanged");
await makeSkill(agentsRoot, "public-skill", "---\nname: public-skill\ndescription: Public skill.\n---\nbody");
const publicToggle = await setSkillEnabled(agentsRoot, "public-skill", false);
ok(publicToggle.ok === false, "public Agent skill rejects enable and disable");
eq(publicToggle.code, "error.root.readonly", "public toggle carries the readonly code");
eq(publicToggle.params && publicToggle.params.action, "toggle", "public toggle params.action");
const publicDoc = parseSkillDoc(await readFile(join(agentsRoot, "public-skill", "SKILL.md"), "utf8"));
ok(publicDoc.map["disable-model-invocation"] === undefined, "public skill metadata remains unchanged");

// ── 删除 ──
const deleted = await deleteSkill(dshRoot, "good-skill");
eq(deleted.name, "good-skill", "deleteSkill returns deleted name");
ok(await resolveEntry(dshRoot, "good-skill") === null, "deleteSkill removes bundle");
const publicDelete = await deleteSkill(agentsRoot, "public-skill");
ok(publicDelete.ok === false, "deleteSkill rejects public Agent directory");

async function tryLink(target, path, type) {
  try {
    if (type) await symlink(target, path, type);
    else await symlink(target, path);
    return true;
  } catch {
    return false;
  }
}

const leftoverDir = join(dshRoot, ".good-skill.dssm-stage-dead");
await mkdir(leftoverDir, { recursive: true });
await writeFile(join(leftoverDir, "SKILL.md"), "---\nname: leftover\n---\nbody", "utf8");
ok(!(await scanEntries(dshRoot)).entries.some((item) => item.name.startsWith(".")), "scan hides crash leftover stage directories");

const outsidePayload = await makeSkill(join(tmp, "outside-payload"), "payload", "---\nname: payload\n---\nsecret");
const plantedLink = join(dshRoot, "evil-link");
const linkType = process.platform === "win32" ? "junction" : undefined;
if (await tryLink(outsidePayload, plantedLink, linkType)) {
  eq(await resolveEntry(dshRoot, "evil-link"), null, "resolveEntry ignores a symlink bundle that leaves the skill root");
  const linkedToggle = await setSkillEnabled(dshRoot, "evil-link", false);
  ok(linkedToggle.ok === false, "enable/disable refuses a symlink planted in the skill root");
  const outsideDoc = await readFile(join(outsidePayload, "SKILL.md"), "utf8");
  ok(!outsideDoc.includes("disable-model-invocation: true"), "symlink toggle does not rewrite files outside the skill root");
  ok(!(await scanEntries(dshRoot)).entries.some((item) => item.name === "evil-link"), "scan hides symlink bundles");
} else {
  ok(true, "symlink write-through test skipped because this environment cannot create directory links");
}

const aliasHome = join(tmp, "alias-home");
if (await tryLink(process.env.DSH_HOME, aliasHome, linkType)) {
  const viaAlias = await importSkill(join(aliasHome, "skills"), null, { dryRun: true });
  eq(viaAlias.code, "error.import.overlap", "import overlap follows intermediate directory links");
} else {
  ok(true, "intermediate-link overlap test skipped because this environment cannot create directory links");
}
eq(publicDelete.code, "error.root.readonly", "public delete carries the readonly code");
eq(publicDelete.params && publicDelete.params.action, "delete", "public delete params.action");
ok(await resolveEntry(agentsRoot, "public-skill") !== null, "public skill remains after rejected delete");
await writeFile(join(dshRoot, "SKILL.md"), "---\nname: root\n---\nbody", "utf8");
await writeFile(join(process.env.DSH_HOME, "SKILL.md"), "---\nname: dsh-home\n---\nbody", "utf8");
ok(await resolveEntry(dshRoot, ".") === null, "resolveEntry rejects current-directory traversal");
ok(await resolveEntry(dshRoot, "..") === null, "resolveEntry rejects parent-directory traversal");
ok(await resolveEntry(dshRoot, "...") === null, "resolveEntry rejects Windows-normalized dot names");
const dotDelete = await deleteSkill(dshRoot, ".");
ok(dotDelete.ok === false, "deleteSkill rejects current-directory traversal");
await makeSkill(dshRoot, "safe-bar", "---\nname: safe-bar\n---\nbody");
const nestedDelete = await deleteSkill(dshRoot, "foo/../safe-bar");
ok(nestedDelete.ok === false, "deleteSkill rejects nested traversal");
ok(await resolveEntry(dshRoot, "safe-bar") !== null, "nested delete leaves the target skill unchanged");
await writeFile(join(dshRoot, "flat-delete.md"), "---\nname: flat-delete\n---\nbody", "utf8");
const flatDeleted = await deleteSkill(dshRoot, "flat-delete");
eq(flatDeleted.name, "flat-delete", "deleteSkill deletes a flat skill");
ok(await resolveEntry(dshRoot, "flat-delete") === null, "flat skill no longer resolves after delete");
await makeSkill(dshRoot, "dual-shape", "---\nname: dual-shape\n---\nbundle");
await writeFile(join(dshRoot, "dual-shape.md"), "---\nname: dual-shape\n---\nflat", "utf8");
await deleteSkill(dshRoot, "dual-shape");
ok(await resolveEntry(dshRoot, "dual-shape") === null, "deleteSkill removes both bundle and flat forms of one skill");
await makeSkill(dshRoot, "dual-scan", "---\nname: dual-scan\n---\nbundle");
await writeFile(join(dshRoot, "dual-scan.md"), "---\nname: dual-scan\n---\nflat", "utf8");
eq((await scanEntries(dshRoot)).entries.filter((item) => item.name === "dual-scan").length, 1, "scan keeps one row when bundle and flat share a name");
eq((await scanEntries(dshRoot)).entries.find((item) => item.name === "dual-scan").kind, "bundle", "scan prefers the bundle form over the flat file");

// 删除必须清掉指向目录的伴随链接本身，且不跟随链接误删目标内容。
const altDirTarget = join(tmp, "alt-dir-target");
await mkdir(altDirTarget, { recursive: true });
if (await tryLink(altDirTarget, join(dshRoot, "alt-dir.md"), linkType)) {
  await makeSkill(dshRoot, "alt-dir", "---\nname: alt-dir\n---\nbundle");
  await deleteSkill(dshRoot, "alt-dir");
  let altDirLinkExists = true;
  try { await stat(join(dshRoot, "alt-dir.md")); } catch { altDirLinkExists = false; }
  ok(altDirLinkExists === false, "deleteSkill removes an alternate link that points at a directory");
  let targetStillExists = true;
  try { await stat(altDirTarget); } catch { targetStillExists = false; }
  ok(targetStillExists, "deleteSkill does not follow the alternate link to its target");
} else {
  ok(true, "alternate-link delete test skipped because this environment cannot create directory links");
}

// ── 导入 ──
const srcSkill = await makeSkill(tmp, "Import Me", "---\nname: import-me\ndescription: Imported.\n---\nbody");
const imp = await importSkill(join(srcSkill, "SKILL.md"), null);
eq(imp.imported.length, 1, "import single dir");
eq(imp.imported[0].name, "import-me", "import kebabifies name");
const importedEntry = await resolveEntry(dshRoot, "import-me");
ok(importedEntry !== null, "imported entry resolvable");

// 已安装目录不能作为导入来源，否则覆盖会先删除来源再复制。
const selfImport = await importSkill(dshRoot, null, { dryRun: true });
ok(selfImport.ok === false, "import rejects a source inside the DSH skills root");
eq(selfImport.code, "error.import.overlap", "self import carries the overlap code");
const parentImport = await importSkill(tmp, null, { dryRun: true });
ok(parentImport.ok === false, "import rejects a source that contains the DSH skills root");
eq(parentImport.code, "error.import.overlap", "parent import carries the overlap code");
const namesBeforeHomeImport = (await scanEntries(dshRoot)).entries.map((entry) => entry.name).sort().join(",");
const homeSkillImport = await importSkill(join(process.env.DSH_HOME, "SKILL.md"), null, { dryRun: true });
ok(homeSkillImport.ok === false && homeSkillImport.error.includes("导入来源不能与 DSH 技能目录相同、包含或位于其中"), "import rejects a SKILL.md whose parent contains the DSH skills root");
eq(homeSkillImport.code, "error.import.overlap", "home SKILL.md import carries the overlap code");
eq((await scanEntries(dshRoot)).entries.map((entry) => entry.name).sort().join(","), namesBeforeHomeImport, "rejected home SKILL.md import leaves skills unchanged");

// 重名 dry-run
const dry = await importSkill(join(srcSkill, "SKILL.md"), null, { dryRun: true });
eq(dry.conflicts.length, 1, "import dryRun detects conflict");
eq(dry.pending.length, 0, "import dryRun pending empty on conflict");

// dry-run 预检与实际导入对符号链接口径一致：SKILL.md 本身是链接时，预检阶段即拒绝。
const docLinkTarget = join(tmp, "doc-link-target.md");
await writeFile(docLinkTarget, "---\nname: doc-link\n---\nbody", "utf8");
const linkedDocSkill = join(tmp, "linked-doc-skill");
await mkdir(linkedDocSkill, { recursive: true });
if (await tryLink(docLinkTarget, join(linkedDocSkill, "SKILL.md"))) {
  const singleDryLink = await importSkill(linkedDocSkill, null, { dryRun: true });
  ok(singleDryLink.ok === false, "dry-run rejects a single source whose SKILL.md is a symlink");
  eq(singleDryLink.code, "error.source.symlink", "single dry-run symlink carries the code");
  const batchLinkDir = join(tmp, "batch-link");
  await mkdir(batchLinkDir, { recursive: true });
  await mkdir(join(batchLinkDir, "holder"), { recursive: true });
  await tryLink(docLinkTarget, join(batchLinkDir, "holder", "SKILL.md"));
  const batchDryLink = await importSkill(batchLinkDir, null, { dryRun: true });
  ok(batchDryLink.ok === false, "dry-run rejects a batch containing a symlinked SKILL.md");
  eq(batchDryLink.code, "error.source.symlink", "batch dry-run symlink carries the code");
} else {
  ok(true, "symlink dry-run tests skipped because this environment cannot create file links");
}
// 覆盖
const overwrite = await importSkill(join(srcSkill, "SKILL.md"), null, { conflict: "overwrite" });
eq(overwrite.imported.length, 1, "import overwrite");
ok(overwrite.imported[0].overwritten === true, "import overwrite marks overwritten");

// 跨形态重名：foo.md 与 foo\SKILL.md 视为同一技能，覆盖时只保留新形态。
await writeFile(join(dshRoot, "cross-shape.md"), "---\nname: cross-shape\n---\nflat", "utf8");
const crossShapeSource = await makeSkill(tmp, "cross-shape", "---\nname: cross-shape\n---\nbundle");
const crossShapeDryRun = await importSkill(join(crossShapeSource, "SKILL.md"), null, { dryRun: true });
eq(crossShapeDryRun.conflicts.length, 1, "cross-shape duplicate is detected as a conflict");
const crossShapeOverwrite = await importSkill(join(crossShapeSource, "SKILL.md"), null, { conflict: "overwrite" });
eq(crossShapeOverwrite.imported.length, 1, "cross-shape overwrite imports bundle");
ok(await resolveEntry(dshRoot, "cross-shape").then((entry) => entry.kind === "bundle"), "cross-shape overwrite keeps bundle");
let crossShapeFlatExists = true;
try { await readFile(join(dshRoot, "cross-shape.md"), "utf8"); } catch { crossShapeFlatExists = false; }
ok(crossShapeFlatExists === false, "cross-shape overwrite removes flat entry");

// 单条导入完全失败必须返回错误，不能被客户端显示为上传完成。
const invalidSource = join(tmp, "中文技能.md");
await writeFile(invalidSource, "---\nname: invalid\n---\nbody", "utf8");
const invalidImport = await importSkill(invalidSource, null);
ok(invalidImport.ok === false, "failed single import returns an error result");
eq(invalidImport.failed.length, 1, "failed single import includes failure detail");
eq(invalidImport.failed[0].code, "error.import.invalidName", "invalid kebab name carries the code");
eq(invalidImport.failed[0].params && invalidImport.failed[0].params.name, "中文技能", "invalid kebab name params");
eq(invalidImport.code, "error.import.failed", "fully failed import carries the aggregate code");
eq(invalidImport.error, invalidImport.failed.map((item) => item.error).join("；"), "aggregate error preserves the original zh text");

const partialBatchDir = join(tmp, "partial-batch");
await mkdir(partialBatchDir, { recursive: true });
await writeFile(join(partialBatchDir, "valid.md"), "---\nname: valid\n---\nbody", "utf8");
await writeFile(join(partialBatchDir, "无效.md"), "---\nname: invalid\n---\nbody", "utf8");
const partialImport = await importSkill(partialBatchDir, null);
eq(partialImport.imported.length, 1, "partial import keeps successful entries");
eq(partialImport.failed.length, 1, "partial import returns failed entry details");
eq(partialImport.failed[0].code, "error.import.invalidName", "partial import failed item carries the code");
ok(partialImport.error === undefined, "partial import does not surface a top-level error");

const duplicateBatchDir = join(tmp, "duplicate-batch");
await mkdir(duplicateBatchDir, { recursive: true });
await writeFile(join(duplicateBatchDir, "Foo Bar.md"), "---\nname: foo-bar\n---\nfirst", "utf8");
await writeFile(join(duplicateBatchDir, "foo-bar.md"), "---\nname: foo-bar\n---\nsecond", "utf8");
const duplicateBatch = await importSkill(duplicateBatchDir, null, { dryRun: true });
ok(duplicateBatch.ok === false, "batch import rejects candidates with the same normalized name");
eq(duplicateBatch.failed.length, 2, "duplicate batch reports every colliding candidate");
eq(duplicateBatch.failed[0].code, "error.import.duplicateName", "duplicate batch carries the code");
eq(duplicateBatch.failed[0].params && duplicateBatch.failed[0].params.name, "foo-bar", "duplicate batch params.name");

const emptyBatchDir = join(tmp, "empty-batch");
await mkdir(emptyBatchDir, { recursive: true });
const emptyImport = await importSkill(emptyBatchDir, null);
ok(emptyImport.ok === false, "empty batch dir returns an error result");
eq(emptyImport.code, "error.import.emptySource", "empty batch carries the emptySource code");
eq(emptyImport.params && emptyImport.params.path, emptyBatchDir, "empty batch params.path");

const deepSource = await makeSkill(tmp, "deep-source", "---\nname: deep-source\n---\nbody");
let deepPath = deepSource;
for (let i = 0; i < 65; i++) {
  deepPath = join(deepPath, `nested-${i}`);
  await mkdir(deepPath);
}
const deepImport = await importSkill(join(deepSource, "SKILL.md"), null);
ok(deepImport.ok === false, "import rejects sources that exceed the directory depth limit");
eq(deepImport.failed[0].code, "error.source.tooDeep", "too-deep import carries the code");
eq(deepImport.failed[0].params && deepImport.failed[0].params.depth, 64, "too-deep params.depth");
const deepDry = await importSkill(join(deepSource, "SKILL.md"), null, { dryRun: true });
ok(deepDry.ok === false, "dry-run rejects sources that exceed the directory depth limit");
eq(deepDry.failed[0].code, "error.source.tooDeep", "too-deep dry-run carries the code");

await makeSkill(dshRoot, "invalid-policy", "---\nname: invalid-policy\ndisable-model-invocation: maybe\n---\nbody");
const invalidPolicyEntries = await scanEntries(dshRoot);
eq(invalidPolicyEntries.entries.find((entry) => entry.name === "invalid-policy").invocationPolicyValid, false, "scan marks invalid invocation policy values");
await writeFile(join(dshRoot, "UPPER.MD"), "---\nname: upper\n---\nbody", "utf8");
const upperCaseEntries = await scanEntries(dshRoot);
ok(upperCaseEntries.entries.some((entry) => entry.name === "UPPER"), "scan recognizes uppercase Markdown extensions");

// 批量导入
const batchDir = join(tmp, "batch");
await mkdir(batchDir, { recursive: true });
await makeSkill(batchDir, "Alpha Beta", "---\nname: alpha-beta\ndescription: A.\n---\nbody");
await writeFile(join(batchDir, "gamma.md"), "---\nname: gamma\ndescription: G.\n---\nbody", "utf8");
const batch = await importSkill(batchDir, null);
eq(batch.imported.length, 2, "import batch dir");


// ── 斜杠菜单刷新通知 ──
{
  const events = [];
  let catalog = 0;
  notifyChatCatalog({
    emit() { events.push(Array.from(arguments)); },
    get(name) {
      if (name === "sessions") return { list() { return [{ id: "s1", header: { agentPreset: "web" } }]; } };
    },
  }, () => { catalog++; });
  eq(catalog, 1, "notifyChatCatalog invalidates the host skill catalog");
  ok(events.some((event) => event[0] === "commands/change"), "notifyChatCatalog emits commands/change");
  ok(events.some((event) => event[0] === "agent-preset/selected" && event[1] === "s1" && event[2] === "web"), "notifyChatCatalog emits the live session preset");
}
// ── HTTP 路由 ──
await makeSkill(dshRoot, "http-skill", "---\nname: http-skill\n---\nbody");
const concurrentImportSource = await makeSkill(tmp, "concurrent-import", "---\nname: concurrent-import\n---\nbody");
let route;
let invalidated = 0;
const emitted = [];
applyHost({
  webServer: { register(value) { route = value; return function () {}; } },
  skills: { registerProvider(register) { register({ invalidate() { invalidated++; } }); return function () {}; } },
  effect(register) { return register(); },
  emit() { emitted.push(Array.from(arguments)); },
  get(name) {
    if (name === "sessions") {
      return {
        list() {
          return [
            { id: "sess-live", header: { id: "sess-live", agentPreset: "cordis" } },
            { id: "sess-blank", header: { id: "sess-blank" } },
          ];
        },
      };
    }
  },
});
const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});
const address = server.address();
const api = `http://127.0.0.1:${address.port}/api/dsh-skills-manager`;
const secureHeaders = { "content-type": "application/json", "x-dsh-skills-manager": "1" };
try {
  const stateResponse = await fetch(api + "/state");
  eq(stateResponse.status, 200, "state route returns 200");
  const headState = await fetch(api + "/state", { method: "HEAD" });
  eq(headState.status, 200, "HEAD /state returns 200");
  eq(await headState.text(), "", "HEAD /state has an empty body");
  const stateGet = await fetch(api + "/state");
  eq(headState.headers.get("content-length"), stateGet.headers.get("content-length"), "HEAD /state content-length matches the GET entity");
  const headDisable = await fetch(api + "/disable", { method: "HEAD" });
  eq(headDisable.status, 405, "HEAD on a mutation route returns 405");
  eq(await headDisable.text(), "", "HEAD 405 has an empty body");
  eq(headDisable.headers.get("content-length"), String(Buffer.byteLength(JSON.stringify({ ok: false, code: "error.proto.method", error: "method not allowed: HEAD" })), "utf8"), "HEAD 405 content-length matches the POST 405 payload shape");

  const evilStateResponse = await requestJson(api + "/state", "GET", { host: "evil.example" });
  eq(evilStateResponse.status, 403, "state route rejects non-loopback Host headers");
  eq(evilStateResponse.payload.code, "error.proto.forbiddenHost", "non-loopback Host on GET carries the forbiddenHost code");

  const localhostStateResponse = await requestJson(api + "/state", "GET", { host: "localhost:" + address.port });
  eq(localhostStateResponse.status, 200, "state route accepts localhost Host headers");
  ok(localhostStateResponse.payload.ok === true, "loopback GET /state still returns the snapshot");

  const evilHostResponse = await requestJson(api + "/disable", "POST", { ...secureHeaders, host: "evil.example" }, JSON.stringify({ name: "http-skill" }));
  eq(evilHostResponse.status, 403, "mutating route rejects non-loopback Host headers");
  eq(evilHostResponse.payload.code, "error.proto.forbiddenHost", "non-loopback Host carries the forbiddenHost code");

  const localhostHostResponse = await requestJson(api + "/enable", "POST", { ...secureHeaders, host: "localhost:" + address.port }, JSON.stringify({ name: "http-skill" }));
  eq(localhostHostResponse.status, 200, "mutating route accepts localhost Host headers");

  const csrfResponse = await fetch(api + "/disable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "http-skill" }) });
  eq(csrfResponse.status, 403, "mutating route rejects requests without the client marker");
  eq((await csrfResponse.json()).code, "error.proto.forbidden", "403 response carries the protocol error code");

  const contentTypeResponse = await fetch(api + "/disable", { method: "POST", headers: { "x-dsh-skills-manager": "1" }, body: JSON.stringify({ name: "http-skill" }) });
  eq(contentTypeResponse.status, 415, "mutating route requires JSON content type");
  eq((await contentTypeResponse.json()).code, "error.proto.contentType", "415 response carries the protocol error code");

  const methodResponse = await fetch(api + "/disable", { method: "PUT" });
  eq(methodResponse.status, 405, "unsupported method returns 405");
  eq((await methodResponse.json()).code, "error.proto.method", "405 response carries the protocol error code");

  const invalidJsonResponse = await fetch(api + "/disable", { method: "POST", headers: secureHeaders, body: "{" });
  eq(invalidJsonResponse.status, 400, "invalid JSON returns 400");

  let oversizedStatus = 0;
  try {
    const oversizedResponse = await fetch(api + "/disable", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "http-skill", padding: "x".repeat(1 << 20) }) });
    oversizedStatus = oversizedResponse.status;
  } catch {
    oversizedStatus = -1;
  }
  eq(oversizedStatus, 413, "oversized JSON returns 413 without dropping the response");

  const disableResponse = await fetch(api + "/disable", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "http-skill" }) });
  eq(disableResponse.status, 200, "valid mutation returns 200");
  ok((await readFile(join(dshRoot, "http-skill", "SKILL.md"), "utf8")).includes("disable-model-invocation: true"), "HTTP disable updates the skill policy");
  ok(invalidated > 0, "successful mutation invalidates the skill catalog");
ok(emitted.some((event) => event[0] === "commands/change"), "successful mutation notifies the command catalog");
ok(emitted.some((event) => event[0] === "agent-preset/selected" && event[1] === "sess-live" && event[2] === "cordis"), "successful mutation refreshes live session slash menus");
ok(!emitted.some((event) => event[0] === "agent-preset/selected" && event[1] === "sess-blank"), "sessions without a preset are not rewritten");

  const publicResponse = await fetch(api + "/disable", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "public-skill", root: "agents" }) });
  eq(publicResponse.status, 400, "HTTP route rejects public Agent mutations");
  const publicPayload = await publicResponse.json();
  eq(publicPayload.code, "error.root.readonly", "HTTP route returns the readonly code");
  eq(publicPayload.params && publicPayload.params.action, "toggle", "HTTP route readonly params.action");
  const httpDeleteAgents = await fetch(api + "/delete", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "http-skill", root: "agents" }) });
  eq(httpDeleteAgents.status, 400, "HTTP delete rejects public Agent root");
  eq((await httpDeleteAgents.json()).code, "error.root.readonly", "HTTP delete with agents root is readonly");
  ok(await resolveEntry(dshRoot, "http-skill") !== null, "HTTP delete with agents root does not remove the DSH skill");
  const httpDotDelete = await fetch(api + "/delete", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "." }) });
  eq(httpDotDelete.status, 400, "HTTP delete rejects current-directory traversal");
  const httpNestedDelete = await fetch(api + "/delete", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "foo/../safe-bar" }) });
  eq(httpNestedDelete.status, 400, "HTTP delete rejects nested traversal");
  ok(await resolveEntry(dshRoot, "safe-bar") !== null, "HTTP traversal deletes leave skills unchanged");
  const unknownResponse = await fetch(api + "/unknown", { method: "POST", headers: secureHeaders, body: "{}" });
  eq(unknownResponse.status, 404, "unknown mutation route returns 404");
  eq((await unknownResponse.json()).code, "error.proto.unknownAction", "404 response carries the protocol error code");

  const cfgGet = await fetch(api + "/config");
  eq(cfgGet.status, 200, "GET /config returns 200");
  const cfgPayload = await cfgGet.json();
  ok(cfgPayload.data && typeof cfgPayload.data.gitRepo === "object", "GET /config exposes gitRepo");
  ok(!("gitToken" in cfgPayload.data), "GET /config never exposes the stored token");
  const cfgEvilHost = await requestJson(api + "/config", "GET", { host: "evil.example" });
  eq(cfgEvilHost.status, 403, "GET /config rejects a non-loopback Host");
  const metaResp = await fetch(api + "/meta");
  eq(metaResp.status, 200, "GET /meta returns 200");
  const metaPayload = await metaResp.json();
  eq(metaPayload.data.version, packageJson.version, "GET /meta exposes the current plugin version");

  const pushReadonly = await fetch(api + "/push", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "public-skill", root: "agents", dryRun: true }) });
  eq(pushReadonly.status, 400, "push route rejects the public Agent root");
  eq((await pushReadonly.json()).code, "error.root.readonly", "push readonly carries the readonly code");

  const pushNoRepo = await fetch(api + "/push", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "http-skill", dryRun: true }) });
  eq(pushNoRepo.status, 400, "push without a configured repository is an error");
  eq((await pushNoRepo.json()).code, "error.push.noRepo", "no-repo push carries the noRepo code");

  const cfgSave = await fetch(api + "/config", { method: "POST", headers: secureHeaders, body: JSON.stringify({ gitRepo: { url: "https://github.com/deronghe/skills", subdir: "" } }) });
  eq(cfgSave.status, 200, "POST /config accepts a valid GitHub URL");
  const cfgBad = await fetch(api + "/config", { method: "POST", headers: secureHeaders, body: JSON.stringify({ gitRepo: { url: "https://gitlab.com/owner/repo" } }) });
  eq(cfgBad.status, 400, "POST /config rejects a non-GitHub URL");
  eq((await cfgBad.json()).code, "error.config.invalidUrl", "invalid config URL carries the code");

  const concurrentResponses = await Promise.all([1, 2].map(function () {
    return fetch(api + "/import", { method: "POST", headers: secureHeaders, body: JSON.stringify({ source: concurrentImportSource }) }).then(function (response) { return response.json(); });
  }));
  eq(concurrentResponses.reduce(function (count, payload) { return count + payload.data.imported.length; }, 0), 1, "concurrent imports perform one installation");
  eq(concurrentResponses.reduce(function (count, payload) { return count + payload.data.skipped.length; }, 0), 1, "concurrent imports serialize the second conflict check");

  // ── GitHub 导入路由回归：saveGitRepo 之后必须继续执行 syncGitRepo（导入 skill） ──
  if (await gitAvailable()) {
    const ghRoot = join(tmp, "gh-route-repo");
    await mkdir(join(ghRoot, "skills"), { recursive: true });
    await makeSkill(join(ghRoot, "skills"), "Route Skill", "---\nname: route-skill\n---\nbody");
    const ghRun = (args) => new Promise((resolve, reject) => {
      execFile("git", args, { cwd: ghRoot, windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || "").trim() || error.message));
        else resolve();
      });
    });
    await ghRun(["init", "-q"]);
    await ghRun(["config", "user.email", "test@example.com"]);
    await ghRun(["config", "user.name", "test"]);
    await ghRun(["add", "-A"]);
    await ghRun(["commit", "-q", "-m", "init"]);

    const ghResponse = await fetch(api + "/github/import", { method: "POST", headers: secureHeaders, body: JSON.stringify({ url: pathToFileURL(ghRoot).href, subdir: "skills", update: false }) });
    const ghPayload = await ghResponse.json();
    eq(ghResponse.status, 200, "github/import route returns 200 for a valid repo");
    eq((ghPayload.data && ghPayload.data.imported || []).length, 1, "github/import route imports the skill after saving (save must not short-circuit the import)");
    ok(await resolveEntry(dshRoot, "route-skill") !== null, "route-imported skill route-skill resolvable");

    const skillsList = await fetch(api + "/github/skills");
    const skillsPayload = await skillsList.json();
    eq(skillsList.status, 200, "GET /github/skills returns 200 for the saved repo");
    eq((skillsPayload.data && skillsPayload.data.skills || []).length, 1, "github/skills lists the saved repo skills");
    eq(skillsPayload.data.skills[0].name, "Route Skill", "github/skills reports the raw repository entry name");
    eq(skillsPayload.data.skills[0].installed, true, "github/skills matches installed by the kebab-cased local name");

    const oneMore = await fetch(api + "/github/import-one", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "Route Skill" }) });
    const oneMorePayload = await oneMore.json();
    eq(oneMore.status, 200, "POST /github/import-one returns 200 for an existing skill");
    eq(((oneMorePayload.data && oneMorePayload.data.skipped) || []).length, 1, "import-one skips a locally installed skill by default");
    const updateOne = await fetch(api + "/github/import-one", { method: "POST", headers: secureHeaders, body: JSON.stringify({ name: "Route Skill", update: true }) });
    const updateOnePayload = await updateOne.json();
    eq(updateOne.status, 200, "POST /github/import-one returns 200 with update=true");
    eq(updateOnePayload.data.imported[0].overwritten, true, "import-one with update=true overwrites the installed skill");
    const manyResp = await fetch(api + "/github/import-many", { method: "POST", headers: secureHeaders, body: JSON.stringify({ names: ["Route Skill", "Missing Skill"], update: true }) });
    const manyPayload = await manyResp.json();
    eq(manyResp.status, 200, "POST /github/import-many returns 200");
    eq((manyPayload.data.imported || []).length, 1, "import-many imports the installed skill with update=true");
    eq((manyPayload.data.failed || []).length, 1, "import-many reports the missing skill as failed");
    eq(manyPayload.data.failed[0].code, "error.github.skillNotFound", "import-many failed entry carries skillNotFound");
    await clearGitRepo();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

// ── 仓库技能列表与单个导入（本地 file:// 仓库，需要 git，不可用时跳过） ──
if (await gitAvailable()) {
  const repoRoot = join(tmp, "gh-one-repo");
  await mkdir(join(repoRoot, "skills"), { recursive: true });
  await makeSkill(join(repoRoot, "skills"), "Gamma Three", "---\nname: gamma-three\n---\nbody");
  await writeFile(join(repoRoot, "skills", "delta-four.md"), "---\nname: delta-four\n---\nbody", "utf8");
  const ghRun = (args) => new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoRoot, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || "").trim() || error.message));
      else resolve();
    });
  });
  await ghRun(["init", "-q"]);
  await ghRun(["config", "user.email", "test@example.com"]);
  await ghRun(["config", "user.name", "test"]);
  await ghRun(["add", "-A"]);
  await ghRun(["commit", "-q", "-m", "init"]);
  const oneRepoUrl = pathToFileURL(repoRoot).href;

  const listBefore = await listRepoSkills(oneRepoUrl, "skills");
  ok(listBefore.ok === true, "listRepoSkills lists a valid repo");
  eq((listBefore.skills || []).length, 2, "listRepoSkills finds every skill in the repo");
  eq(listBefore.skills.map((s) => s.name).join(","), "delta-four,Gamma Three", "listRepoSkills sorts entries by name");
  ok(listBefore.skills.every((s) => s.installed === false), "listRepoSkills reports nothing installed before import");

  const singleImport = await importRepoSkill(oneRepoUrl, "skills", "Gamma Three");
  ok(singleImport.imported && singleImport.imported.length === 1, "importRepoSkill imports the chosen skill");
  eq(singleImport.imported[0].name, "gamma-three", "importRepoSkill kebab-cases the local name");
  ok(await resolveEntry(dshRoot, "gamma-three") !== null, "single-imported skill resolvable");
  ok(await resolveEntry(dshRoot, "delta-four") === null, "single import leaves the other repo skill untouched");

  const listAfter = await listRepoSkills(oneRepoUrl, "skills");
  const gammaItem = listAfter.skills.find((s) => s.name === "Gamma Three");
  ok(gammaItem && gammaItem.installed === true, "listRepoSkills matches installed by the kebab-cased local name");
  ok(gammaItem && gammaItem.enabled === true, "listRepoSkills reports the imported skill enabled");

  const repeatSkip = await importRepoSkill(oneRepoUrl, "skills", "Gamma Three");
  eq(((repeatSkip && repeatSkip.skipped) || []).length, 1, "default single import skips an existing skill");

  const repeatUpdate = await importRepoSkill(oneRepoUrl, "skills", "Gamma Three", null, { update: true });
  ok(repeatUpdate.imported && repeatUpdate.imported.length === 1, "update single import overwrites the existing skill");
  eq(repeatUpdate.imported[0].overwritten, true, "update single import reports overwritten");

  const missingName = await importRepoSkill(oneRepoUrl, "skills", "No Such Skill");
  ok(missingName.ok === false, "importRepoSkill rejects an unknown skill name");
  eq(missingName.code, "error.github.skillNotFound", "unknown skill name carries the skillNotFound code");

  // 已保存仓库配置的浏览/导入入口：未保存时先报 notSet。
  const notSetList = await listSavedRepoSkills();
  ok(notSetList.ok === false, "listSavedRepoSkills errors before any repo is saved");
  eq(notSetList.code, "error.github.notSet", "unsaved repo list carries the notSet code");
  const notSetOne = await importSavedRepoSkill("Gamma Three");
  ok(notSetOne.ok === false, "importSavedRepoSkill errors before any repo is saved");
  eq(notSetOne.code, "error.github.notSet", "unsaved single import carries the notSet code");

  await saveGitRepo(oneRepoUrl, "skills");
  const savedList = await listSavedRepoSkills();
  ok(savedList.ok === true && (savedList.skills || []).length === 2, "listSavedRepoSkills lists the saved repo skills");
  const savedImport = await importSavedRepoSkill("delta-four");
  ok(savedImport.imported && savedImport.imported.length === 1, "importSavedRepoSkill imports the chosen skill from the saved repo");
  ok(await resolveEntry(dshRoot, "delta-four") !== null, "saved-repo single-imported skill resolvable");
  await clearGitRepo();

  const multiDefault = await importRepoSkills(oneRepoUrl, "skills", ["Gamma Three", "delta-four", "No Such Skill"]);
  eq((multiDefault.imported || []).length, 0, "multi import imports nothing new when all selected skills are installed");
  eq((multiDefault.skipped || []).length, 2, "multi import skips installed skills by default");
  eq((multiDefault.failed || []).length, 1, "multi import reports unknown skills as failed");
  eq(multiDefault.failed[0].code, "error.github.skillNotFound", "multi import failed entry carries skillNotFound");
  const multiUpdate = await importRepoSkills(oneRepoUrl, "skills", ["Gamma Three", "delta-four"], null, { update: true });
  eq((multiUpdate.imported || []).length, 2, "multi import with update overwrites the selected skills");
  eq(multiUpdate.imported.every((item) => item.overwritten === true), true, "multi import with update reports overwritten");
  const emptyMulti = await importRepoSkills(oneRepoUrl, "skills", []);
  ok(emptyMulti.imported.length === 0 && emptyMulti.skipped.length === 0 && emptyMulti.failed.length === 0, "multi import with no names is a no-op");
}

// ── 状态快照 ──
const snap = await state();
eq(snap.roots.length, 2, "state returns DSH and public Agent roots");
const dshSnap = snap.roots.find((r) => r.key === "dsh");
ok(dshSnap.mutable === true, "DSH root allows destructive actions");
ok(dshSnap.skills.some((s) => s.name === "import-me"), "state lists imported skill");
ok(dshSnap.skills.find((s) => s.name === "import-me").modelInvocable === true, "state modelInvocable");
const agentsSnap = snap.roots.find((r) => r.key === "agents");
ok(agentsSnap.mutable === false, "public Agent root disallows destructive actions");
ok(agentsSnap.skills.some((s) => s.name === "public-skill"), "state lists public Agent skill");

// ── 源文件夹保存 / 同步 / 清除 ──
const notSetSync = await syncSourceFolder();
ok(notSetSync.ok === false, "syncSourceFolder errors before any folder is saved");
eq(notSetSync.code, "error.folder.notSet", "unsaved sync carries the notSet code");

const missingSave = await saveSourceFolder(join(tmp, "no-such-folder"));
ok(missingSave.ok === false, "saveSourceFolder rejects a nonexistent path");
eq(missingSave.code, "error.source.notFound", "nonexistent save carries the notFound code");

const overlapSave = await saveSourceFolder(dshRoot);
ok(overlapSave.ok === false, "saveSourceFolder rejects the DSH skills root itself");
eq(overlapSave.code, "error.import.overlap", "overlap save carries the overlap code");

const batchSrcRoot = join(tmp, "batch-src");
await makeSkill(batchSrcRoot, "Alpha One", "---\nname: alpha-one\n---\nbody");
await writeFile(join(batchSrcRoot, "beta-two.md"), "---\nname: beta-two\n---\nbody", "utf8");
const saveResult = await saveSourceFolder(batchSrcRoot);
ok(typeof saveResult.sourceFolder === "string" && saveResult.sourceFolder !== "", "saveSourceFolder persists the folder path");
const snapAfterSave = await state();
eq(snapAfterSave.sourceFolder, resolve(batchSrcRoot), "state exposes the saved source folder");

const syncResult = await syncSourceFolder();
eq((syncResult.imported || []).length, 2, "syncSourceFolder imports every skill from the saved folder");
ok(await resolveEntry(dshRoot, "alpha-one") !== null, "synced bundle skill alpha-one resolvable");
ok(await resolveEntry(dshRoot, "beta-two") !== null, "synced flat skill beta-two resolvable");

const syncAgain = await syncSourceFolder();
eq((syncAgain.imported || []).length, 0, "second sync imports nothing new");
eq((syncAgain.skipped || []).length, 2, "second sync skips the existing skills");

const clearResult = await clearSourceFolder();
ok(clearResult.sourceFolder === null, "clearSourceFolder clears the saved folder");
const snapAfterClear = await state();
ok(snapAfterClear.sourceFolder === null, "state exposes null after clearing the source folder");

// ── GitHub 仓库地址与子目录校验 ──
eq(normalizeRepoUrl("").ok, false, "normalizeRepoUrl rejects empty input");
eq(normalizeRepoUrl("not-a-url").ok, false, "normalizeRepoUrl rejects a bare string");
eq(normalizeRepoUrl("https://github.com/owner/repo.git").ok, true, "normalizeRepoUrl accepts an https URL");
eq(normalizeRepoUrl("git@github.com:owner/repo.git").ok, true, "normalizeRepoUrl accepts a git@ URL");
eq(normalizeRepoUrl("file:///C:/tmp/repo").ok, true, "normalizeRepoUrl accepts a file URL");

eq(normalizeSubdir("").subdir, "", "normalizeSubdir treats empty as root");
eq(normalizeSubdir("skills").subdir, "skills", "normalizeSubdir keeps a plain segment");
eq(normalizeSubdir("  skills/  ").subdir, "skills", "normalizeSubdir trims and strips slashes");
eq(normalizeSubdir("a/b").subdir, "a/b", "normalizeSubdir keeps nested segments");
ok(normalizeSubdir("../evil").ok === false, "normalizeSubdir rejects parent traversal");
ok(normalizeSubdir("/abs").ok === false, "normalizeSubdir rejects an absolute path");
ok(normalizeSubdir("C:/win").ok === false, "normalizeSubdir rejects a drive path");

// ── GitHub 仓库保存 / 清除 / 状态（不触发克隆） ──
const badGitSave = await saveGitRepo("not-a-url", "");
ok(badGitSave.ok === false, "saveGitRepo rejects an invalid URL");
eq(badGitSave.code, "error.github.invalidUrl", "invalid save carries the invalidUrl code");

const badGitImport = await importFromGitRepo("not-a-url", "");
ok(badGitImport.ok === false, "importFromGitRepo rejects an invalid URL before cloning");
eq(badGitImport.code, "error.github.invalidUrl", "invalid import carries the invalidUrl code");

const notSetGit = await syncGitRepo();
ok(notSetGit.ok === false, "syncGitRepo errors before any repo is saved");
eq(notSetGit.code, "error.github.notSet", "unsaved git sync carries the notSet code");

const goodGitSave = await saveGitRepo("https://github.com/deronghe/skills.git", "skills");
ok(goodGitSave.gitRepo && goodGitSave.gitRepo.url === "https://github.com/deronghe/skills.git", "saveGitRepo persists the repo URL");
eq(goodGitSave.gitRepo.subdir, "skills", "saveGitRepo persists the subdir");

const snapWithRepo = await state();
ok(snapWithRepo.gitRepo && snapWithRepo.gitRepo.url === "https://github.com/deronghe/skills.git", "state exposes the saved gitRepo");
eq(snapWithRepo.gitRepo.subdir, "skills", "state exposes the gitRepo subdir");

const clearGit = await clearGitRepo();
ok(clearGit.gitRepo === null, "clearGitRepo clears the saved repo");
const snapAfterClearGit = await state();
ok(snapAfterClearGit.gitRepo === null, "state exposes null gitRepo after clearing");

// ── GitHub 仓库克隆导入（需要 git，不可用时跳过） ──
function gitAvailable() {
  return new Promise((resolve) => {
    execFile("git", ["--version"], { windowsHide: true }, (error) => resolve(!error));
  });
}

if (await gitAvailable()) {
  const repoRoot = join(tmp, "git-repo");
  await mkdir(join(repoRoot, "skills"), { recursive: true });
  await makeSkill(join(repoRoot, "skills"), "Remote One", "---\nname: remote-one\n---\nbody");
  const gitRun = (args) => new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoRoot, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || "").trim() || error.message));
      else resolve();
    });
  });
  await gitRun(["init", "-q"]);
  await gitRun(["config", "user.email", "test@example.com"]);
  await gitRun(["config", "user.name", "test"]);
  await gitRun(["add", "-A"]);
  await gitRun(["commit", "-q", "-m", "init"]);

  const gitImport = await importFromGitRepo(pathToFileURL(repoRoot).href, "skills", null, {});
  eq((gitImport.imported || []).length, 1, "importFromGitRepo clones a local repo and imports its skill");
  ok(await resolveEntry(dshRoot, "remote-one") !== null, "cloned skill remote-one resolvable");
} else {
  ok(true, "git clone import test skipped because git is unavailable");
}

// ── 推送配置 / 元信息 / 推送守卫（不触网）──
const tokenSave = await savePushConfig({ gitToken: "ghp_local_test_token" });
ok(tokenSave.ok !== false, "savePushConfig stores a token");
eq((await loadSettings()).gitToken, "ghp_local_test_token", "token persists in the shared settings file");
const tokenClear = await savePushConfig({ gitToken: null });
ok(tokenClear.ok !== false, "savePushConfig clears a token on null");
ok((await loadSettings()).gitToken === undefined, "cleared token is removed from settings");
const badUrlSave = await savePushConfig({ gitRepo: { url: "https://gitlab.com/owner/repo" } });
ok(badUrlSave.ok === false, "savePushConfig rejects a non-GitHub URL");
eq(badUrlSave.code, "error.config.invalidUrl", "invalid URL carries the config code");
const badSubdirSave = await savePushConfig({ gitRepo: { subdir: "../escape" } });
ok(badSubdirSave.ok === false, "savePushConfig rejects a traversal subdirectory");
eq(badSubdirSave.code, "error.config.invalidSubdir", "traversal subdir carries the config code");
const longTokenSave = await savePushConfig({ gitToken: "x".repeat(600) });
ok(longTokenSave.ok === false, "savePushConfig rejects an overlong token");
eq(longTokenSave.code, "error.config.invalidToken", "overlong token carries the config code");
const publicCfg = await pushConfig();
ok(publicCfg && typeof publicCfg.gitRepo === "object", "pushConfig exposes gitRepo without a token");
const meta = await pluginMeta();
ok(meta.version !== "", "pluginMeta exposes the plugin version");
eq(meta.version, packageJson.version, "pluginMeta version matches package.json");
ok(/github\.com/.test(meta.repository), "pluginMeta exposes the project repository");
const agentsPush = await pushSkillToSource(agentsRoot, "public-skill", { dryRun: true });
ok(agentsPush.ok === false, "push rejects the public Agent root");
eq(agentsPush.code, "error.root.readonly", "push readonly carries the readonly code");
eq(agentsPush.params && agentsPush.params.action, "push", "push readonly params.action is push");
const missingPush = await pushSkillToSource(dshRoot, "no-such-skill", { dryRun: true });
ok(missingPush.ok === false, "push of a missing skill is an error");
eq(missingPush.code, "error.skill.notFound", "push missing skill carries the notFound code");

// ── 传输层瞬时失败判定：schannel 握手失败必须命中，真实错误不得命中 ──
ok(isTransientNetworkError("fatal: unable to access 'https://github.com/deronghe/skills/': schannel: failed to receive handshake, SSL/TLS connection failed") === true, "transient classifier matches the schannel handshake failure");
ok(isTransientNetworkError("could not resolve host: github.com") === true, "transient classifier matches DNS resolution failure");
ok(isTransientNetworkError("") === false, "transient classifier rejects empty text");
ok(isTransientNetworkError("Repository not found.") === false, "transient classifier rejects repo-not-found");
ok(isTransientNetworkError("remote: Invalid username or password") === false, "transient classifier rejects credential failures");

// 清理
await rm(tmp, { recursive: true, force: true });
delete process.env.DSH_HOME;
delete process.env.DSH_AGENTS_HOME;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);


