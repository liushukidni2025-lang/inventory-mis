import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "inventory.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','keeper','viewer')),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      contact TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      category_id INTEGER REFERENCES categories(id),
      unit TEXT NOT NULL DEFAULT '个',
      cost_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      safety_stock REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock (
      product_id INTEGER NOT NULL REFERENCES products(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      qty REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (product_id, warehouse_id)
    );

    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('in','out','transfer','adjust')),
      product_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      product_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      warehouse_id INTEGER,
      warehouse_name TEXT,
      from_warehouse_id INTEGER,
      from_warehouse_name TEXT,
      to_warehouse_id INTEGER,
      to_warehouse_name TEXT,
      quantity REAL NOT NULL,
      date TEXT NOT NULL,
      operator TEXT NOT NULL DEFAULT '',
      user_id INTEGER,
      supplier_id INTEGER,
      supplier_name TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'normal' CHECK(status IN ('normal','voided')),
      void_reason TEXT,
      voided_by INTEGER,
      voided_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stocktakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL,
      warehouse_name TEXT NOT NULL,
      date TEXT NOT NULL,
      user_id INTEGER,
      operator TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stocktake_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      product_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      book_qty REAL NOT NULL,
      counted_qty REAL NOT NULL,
      adjust_qty REAL NOT NULL,
      movement_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_movements_date ON movements(date);
    CREATE INDEX IF NOT EXISTS idx_movements_product ON movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_movements_status ON movements(status);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_stock_wh ON stock(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
  `);
}

export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}

export function nowISO() {
  return new Date().toISOString();
}

export function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function roundQty(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

export function getStock(db, productId, warehouseId) {
  const row = db.prepare(
    "SELECT qty FROM stock WHERE product_id = ? AND warehouse_id = ?"
  ).get(productId, warehouseId);
  return row ? Number(row.qty) : 0;
}

/** Adjust stock inside a transaction. Rejects negative resulting qty. */
export function addStock(db, productId, warehouseId, delta) {
  const cur = getStock(db, productId, warehouseId);
  const next = roundQty(cur + Number(delta));
  if (next < -1e-9) {
    const err = new Error("库存不足，无法完成本次操作");
    err.status = 400;
    err.code = "INSUFFICIENT_STOCK";
    throw err;
  }
  db.prepare(`
    INSERT INTO stock (product_id, warehouse_id, qty) VALUES (?, ?, ?)
    ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty = excluded.qty
  `).run(productId, warehouseId, next);
  return next;
}

export function totalStock(db, productId) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(qty), 0) AS qty FROM stock WHERE product_id = ?"
  ).get(productId);
  return Number(row.qty) || 0;
}

export function audit(db, user, action, detail) {
  db.prepare(`
    INSERT INTO audit_logs (user_id, username, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    user && user.id || null,
    user && (user.username || user.display_name) || "系统",
    action,
    detail || "",
    nowISO()
  );
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
