import { scryptSync, randomBytes, timingSafeEqual, createHash, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { nowISO, httpError } from "./db.js";

const scryptAsync = promisify(scrypt);

const SCRYPT_KEYLEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const COOKIE = "sid";

export function hashPasswordSync(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return { salt: salt.toString("hex"), hash: Buffer.from(hash).toString("hex") };
}

export async function verifyPassword(password, saltHex, hashHex) {
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const hash = Buffer.from(await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS));
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(hash, expected);
}

export function generatePassword(len = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function cookieHeader(token, { maxAge, secure, clear } = {}) {
  if (clear) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge || 7 * 24 * 3600}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function isSecureRequest(req) {
  if (process.env.FORCE_SECURE_COOKIE === "1") return true;
  const xf = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (xf === "https") return true;
  return !!(req.socket && req.socket.encrypted);
}

export function sessionDays() {
  const n = Number(process.env.SESSION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export function createSession(db, user, req) {
  const token = newSessionToken();
  const days = sessionDays();
  const expires = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sha256(token),
    user.id,
    expires,
    nowISO(),
    clientIp(req),
    String(req.headers["user-agent"] || "").slice(0, 200)
  );
  return { token, maxAge: days * 24 * 3600 };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function purgeExpiredSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowISO());
}

export function getUserFromRequest(db, req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.disabled, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < nowISO()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    return null;
  }
  if (row.disabled) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role
  };
}

export function requireUser(user) {
  if (!user) throw httpError(401, "请先登录");
  return user;
}

export function requireRole(user, ...roles) {
  requireUser(user);
  if (!roles.includes(user.role)) throw httpError(403, "没有权限执行此操作");
  return user;
}

export function canWrite(user) {
  return user && (user.role === "admin" || user.role === "keeper");
}

export function requireWrite(user) {
  requireUser(user);
  if (!canWrite(user)) throw httpError(403, "只读账号不能修改数据");
  return user;
}

export function requireAdmin(user) {
  return requireRole(user, "admin");
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    role_label: roleLabel(u.role)
  };
}

export function roleLabel(role) {
  if (role === "admin") return "管理员";
  if (role === "keeper") return "库管员";
  if (role === "viewer") return "只读";
  return role;
}

export function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (xf) return xf;
  return (req.socket && req.socket.remoteAddress) || "";
}

/** Simple in-memory login rate limiter: 10 attempts / 10 min per ip+username. */
const attempts = new Map();
export function checkLoginRate(ip, username) {
  const key = `${ip}|${(username || "").toLowerCase()}`;
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  let rec = attempts.get(key);
  if (!rec || now - rec.start > windowMs) {
    rec = { start: now, count: 0 };
    attempts.set(key, rec);
  }
  rec.count += 1;
  if (rec.count > 10) throw httpError(429, "尝试次数过多，请稍后再试");
}
export function clearLoginRate(ip, username) {
  attempts.delete(`${ip}|${(username || "").toLowerCase()}`);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) {
    if (now - v.start > 15 * 60 * 1000) attempts.delete(k);
  }
}, 60 * 1000).unref();
