/**
 * 启动包装：在 Node 22 上 node:sqlite 仍是实验特性，需要 --experimental-sqlite；
 * Node 24+ 默认可用，不必加该参数。根据探测结果选择正确的启动参数。
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(__dirname, "server.js");

function canUseSqlite(flags) {
  const r = spawnSync(
    process.execPath,
    [...flags, "--input-type=module", "-e", "import 'node:sqlite'"],
    { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] }
  );
  return r.status === 0;
}

const flags = [];
if (canUseSqlite([])) {
  // Node 24+ 或已默认启用
} else if (canUseSqlite(["--experimental-sqlite"])) {
  flags.push("--experimental-sqlite");
  console.log("已启用 --experimental-sqlite（当前 Node " + process.versions.node + " 需要该参数才能使用 node:sqlite）");
} else {
  console.error("当前 Node.js " + process.versions.node + " 无法使用 node:sqlite。");
  console.error("请使用 Node.js 22.5 或更高版本（Render 上请设置 NODE_VERSION=22）。");
  process.exit(1);
}

const child = spawn(process.execPath, [...flags, server], {
  stdio: "inherit",
  env: process.env
});

function forward(signal) {
  if (child.exitCode === null && !child.killed) child.kill(signal);
}
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
