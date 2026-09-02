// dsh-skills-manager 一键发布：bump 版本 → 提交 → 打 vX.Y.Z 标签 → 推送 → 创建 GitHub Release
//
// 用法（在仓库根目录）：
//   node scripts/release.mjs            # 默认 minor：0.2.0 -> 0.3.0
//   node scripts/release.mjs patch      # 0.3.0 -> 0.3.1
//   node scripts/release.mjs major      # 0.3.0 -> 1.0.0
//
// 前置条件：
//   - 工作区干净、当前分支为 main；
//   - 环境变量 GITHUB_TOKEN 已设置（推送鉴权与创建 Release 均使用）。
// 变更日志自动取上一个版本标签以来的提交；Release 已存在时跳过创建（幂等）。

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "package.json");

function run(args, options = {}) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`git ${args.join(" ")} 失败：${output || error.message}`);
  }
}

function bump(version, type) {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) throw new Error(`无法解析版本号: ${version}`);
  if (type === "major") return `${parts[0] + 1}.0.0`;
  if (type === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  if (type === "patch") return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  throw new Error(`未知的版本类型: ${type}（支持 patch|minor|major）`);
}

const type = (process.argv[2] || "minor").toLowerCase();
const token = process.env.GITHUB_TOKEN || "";
if (!token) throw new Error("未设置 GITHUB_TOKEN 环境变量");

const branch = run(["branch", "--show-current"]);
if (branch !== "main") throw new Error(`当前分支为 ${branch}，发布只允许在 main 分支执行`);
const status = run(["status", "--porcelain"]);
if (status !== "") throw new Error(`工作区不干净，请先提交或还原改动：\n${status}`);

const pkg = JSON.parse(await readFile(packagePath, "utf8"));
const current = pkg.version;
const next = bump(current, type);
pkg.version = next;
await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

const previousTag = run(["describe", "--tags", "--abbrev=0", "--always", "HEAD"]);
let changelog = [];
if (previousTag && previousTag !== next && previousTag.startsWith("v")) {
  changelog = run(["log", "--oneline", "--no-decorate", `${previousTag}..HEAD`]).split(/\r?\n/).filter(Boolean);
}
const body = [
  `## v${next}`,
  "",
  ...(changelog.length ? changelog : ["- 常规更新。"]),
].join("\n");

run(["add", "--", "package.json"]);
run(["commit", "-m", `chore(release): v${next}`]);
run(["tag", "-a", `v${next}`, "-m", `v${next}`]);

const pushUrl = `https://${token}@github.com/deronghe/dsh-skills-manager.git`;
try {
  run(["push", pushUrl, "HEAD:main", "--tags"]);
} catch (error) {
  // Windows schannel 偶发 HTTP/2 握手失败：退回 HTTP/1.1 重试一次。
  console.warn("首次推送失败，改用 HTTP/1.1 重试：", error.message.split("\n")[0]);
  run(["-c", "http.version=HTTP/1.1", "push", pushUrl, "HEAD:main", "--tags"]);
}

let releaseUrl = "";
try {
  const response = await fetch(`https://api.github.com/repos/deronghe/dsh-skills-manager/releases`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "dsh-skills-manager-release",
    },
    body: JSON.stringify({ tag_name: `v${next}`, name: `v${next}`, body }),
  });
  if (response.status === 422) {
    console.log(`Release v${next} 已存在，跳过创建`);
  } else if (response.ok) {
    const release = await response.json();
    releaseUrl = release.html_url || "";
  } else {
    const text = await response.text();
    console.warn(`创建 Release 失败（HTTP ${response.status}），可在仓库 Releases 页手动创建：${text.slice(0, 300)}`);
  }
} catch (error) {
  console.warn(`创建 Release 失败：${error.message}，可在仓库 Releases 页手动创建`);
}

console.log(`已发布 v${next}`);
console.log(`提交：${run(["rev-parse", "--short", "HEAD"])}`);
console.log(`仓库：https://github.com/deronghe/dsh-skills-manager/releases`);
if (releaseUrl) console.log(`Release：${releaseUrl}`);
