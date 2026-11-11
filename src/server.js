import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { openDatabase, nowISO } from "./db.js";
import { hashPasswordSync, generatePassword, getUserFromRequest, purgeExpiredSessions } from "./auth.js";
import { handleApi } from "./api.js";
import { json } from "./http-util.js";
import { loadDemo, DEMO_KEEPER, DEMO_VIEWER } from "./demo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "data");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json"
};

function ensureAdmin(db) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (n > 0) return null;
  const username = (process.env.ADMIN_USERNAME || "admin").trim() || "admin";
  const fromEnv = !!(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length > 0);
  const password = fromEnv ? process.env.ADMIN_PASSWORD : generatePassword(12);
  if (fromEnv && password.length < 6) {
    console.error("ADMIN_PASSWORD 至少需要 6 位");
    process.exit(1);
  }
  const { salt, hash } = hashPasswordSync(password);
  const t = nowISO();
  db.prepare(`
    INSERT INTO users (username, display_name, password_salt, password_hash, role, disabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'admin', 0, ?, ?)
  `).run(username, "系统管理员", salt, hash, t, t);
  const defaultWh = db.prepare("SELECT COUNT(*) AS n FROM warehouses").get().n;
  if (defaultWh === 0) {
    db.prepare("INSERT INTO warehouses (name, note, created_at) VALUES (?, ?, ?)")
      .run("主仓库", "系统默认仓库", t);
  }
  return { username, password, fromEnv };
}

function lanIPs() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) ips.push(a.address);
    }
  }
  return ips;
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split("?")[0]);
  const rel = decoded.replace(/^\/+/, "");
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root)) return null;
  return full;
}

function serveStatic(req, res, url) {
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = safeJoin(PUBLIC, rel);
  if (!file) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback
      const index = path.join(PUBLIC, "index.html");
      if (url.pathname.startsWith("/api")) {
        json(res, 404, { error: "接口不存在" });
        return;
      }
      fs.readFile(index, (e2, buf) => {
        if (e2) {
          res.writeHead(404).end("Not Found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buf);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=86400"
    });
    fs.createReadStream(file).pipe(res);
  });
}

function isBusinessEmpty(db) {
  const products = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
  const movements = db.prepare("SELECT COUNT(*) AS n FROM movements").get().n;
  return products === 0 && movements === 0;
}

function maybeAutoDemo(db) {
  if (String(process.env.AUTO_DEMO || "") !== "1") return false;
  if (!isBusinessEmpty(db)) {
    console.log("AUTO_DEMO=1：数据库已有业务数据，跳过自动加载演示数据。");
    return false;
  }
  const admin = db.prepare("SELECT id, username, display_name FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  const actor = admin || { id: null, username: "系统", display_name: "系统" };
  loadDemo(db, actor);
  console.log("AUTO_DEMO=1：数据库为空，已自动加载演示数据。");
  console.log(`  演示账号 库管员: ${DEMO_KEEPER.username} / ${DEMO_KEEPER.password}`);
  console.log(`  演示账号 只读:   ${DEMO_VIEWER.username} / ${DEMO_VIEWER.password}`);
  return true;
}

const db = openDatabase(DATA_DIR);
const bootstrap = ensureAdmin(db);
const autoDemo = maybeAutoDemo(db);
purgeExpiredSessions(db);
setInterval(() => {
  try { purgeExpiredSessions(db); } catch (e) { console.error(e); }
}, 60 * 60 * 1000).unref();

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  let url;
  try {
    url = new URL(req.url, `http://${host}`);
  } catch {
    res.writeHead(400).end("Bad Request");
    return;
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    try {
      const user = getUserFromRequest(db, req);
      await handleApi(db, req, res, url, user);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: err.message || "服务器内部错误" });
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("==============================================");
  console.log("  库存管理系统（多人版）已启动");
  console.log(`  本地访问:  http://127.0.0.1:${PORT}`);
  for (const ip of lanIPs()) {
    console.log(`  局域网访问: http://${ip}:${PORT}`);
  }
  console.log(`  数据文件:  ${path.join(DATA_DIR, "inventory.db")}`);
  if (bootstrap) {
    console.log("----------------------------------------------");
    console.log("  首次启动：已创建管理员账号");
    console.log(`  用户名: ${bootstrap.username}`);
    if (bootstrap.fromEnv) {
      console.log("  密码:  （来自环境变量 ADMIN_PASSWORD）");
    } else {
      console.log(`  初始密码: ${bootstrap.password}`);
      console.log("  请登录后立即修改密码，并妥善保管。");
    }
  }
  if (autoDemo) {
    console.log("----------------------------------------------");
    console.log("  AUTO_DEMO=1：已自动加载演示数据");
    console.log(`  库管员: ${DEMO_KEEPER.username} / ${DEMO_KEEPER.password}`);
    console.log(`  只读:   ${DEMO_VIEWER.username} / ${DEMO_VIEWER.password}`);
  }
  console.log("==============================================");
  console.log("");
});

function shutdown() {
  console.log("正在关闭…");
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
