import {
  nowISO, todayISO, tx, getStock, addStock, totalStock, audit, httpError, roundQty
} from "./db.js";
import {
  hashPassword, verifyPassword, generatePassword, hashPasswordSync,
  createSession, destroySession, parseCookies, cookieHeader, isSecureRequest,
  requireUser, requireWrite, requireAdmin, publicUser, roleLabel,
  checkLoginRate, clearLoginRate, clientIp, canWrite
} from "./auth.js";
import { loadDemo, clearBusinessData, DEMO_KEEPER, DEMO_VIEWER } from "./demo.js";
import { json, sendCsv, toCSV, readJson, parseQuery, formatDateTime } from "./http-util.js";

function num(v, def) {
  if (v === "" || v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function requireStr(v, name, max = 200) {
  const s = String(v == null ? "" : v).trim();
  if (!s) throw httpError(400, `请填写${name}`);
  if (s.length > max) throw httpError(400, `${name}过长`);
  return s;
}

function optStr(v, max = 200) {
  const s = String(v == null ? "" : v).trim();
  if (s.length > max) throw httpError(400, "文本过长");
  return s;
}

function productPayload(db, p) {
  if (!p) return null;
  const stocks = db.prepare(`
    SELECT s.warehouse_id, w.name AS warehouse_name, s.qty
    FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
    WHERE s.product_id = ?
    ORDER BY w.id
  `).all(p.id);
  const stock_total = stocks.reduce((a, r) => a + Number(r.qty), 0);
  let category = null;
  if (p.category_id) {
    const c = db.prepare("SELECT id, name FROM categories WHERE id = ?").get(p.category_id);
    category = c || null;
  }
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    category_id: p.category_id,
    category: category ? category.name : "",
    unit: p.unit,
    cost_price: p.cost_price,
    sale_price: p.sale_price,
    safety_stock: p.safety_stock,
    note: p.note,
    stock_total: roundQty(stock_total),
    stocks,
    low_stock: stock_total <= Number(p.safety_stock),
    created_at: p.created_at,
    updated_at: p.updated_at
  };
}

function getProduct(db, id) {
  return db.prepare("SELECT * FROM products WHERE id = ?").get(id);
}

function getWarehouse(db, id) {
  return db.prepare("SELECT * FROM warehouses WHERE id = ?").get(id);
}

export async function handleApi(db, req, res, url, user) {
  const method = req.method;
  const path = url.pathname;
  const q = parseQuery(url);
  const p = (pat) => {
    const a = path.split("/").filter(Boolean);
    const b = pat.split("/").filter(Boolean);
    if (a.length !== b.length) return null;
    const params = {};
    for (let i = 0; i < b.length; i++) {
      if (b[i].startsWith(":")) params[b[i].slice(1)] = a[i];
      else if (b[i] !== a[i]) return null;
    }
    return params;
  };

  // ---------- auth ----------
  if (path === "/api/login" && method === "POST") {
    const body = await readJson(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) throw httpError(400, "请输入用户名和密码");
    checkLoginRate(clientIp(req), username);
    const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    const ok = row && !row.disabled && await verifyPassword(password, row.password_salt, row.password_hash);
    if (!ok) throw httpError(401, "用户名或密码错误");
    clearLoginRate(clientIp(req), username);
    const sess = createSession(db, row, req);
    audit(db, row, "登录", "");
    res.setHeader("Set-Cookie", cookieHeader(sess.token, {
      maxAge: sess.maxAge,
      secure: isSecureRequest(req)
    }));
    return json(res, 200, { user: publicUser(row) });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = parseCookies(req).sid;
    if (user) audit(db, user, "退出登录", "");
    destroySession(db, token);
    res.setHeader("Set-Cookie", cookieHeader("", { clear: true }));
    return json(res, 200, { ok: true });
  }

  if (path === "/api/me" && method === "GET") {
    if (!user) return json(res, 200, { user: null });
    return json(res, 200, { user: publicUser(user) });
  }

  if (path === "/api/health" && method === "GET") {
    return json(res, 200, { ok: true });
  }

  // Everything else requires login
  requireUser(user);

  if (path === "/api/me/password" && method === "POST") {
    const body = await readJson(req);
    const current = String(body.current_password || "");
    const next = String(body.new_password || "");
    if (next.length < 6) throw httpError(400, "新密码至少 6 位");
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    const ok = await verifyPassword(current, row.password_salt, row.password_hash);
    if (!ok) throw httpError(400, "当前密码不正确");
    const { salt, hash } = await hashPassword(next);
    db.prepare("UPDATE users SET password_salt=?, password_hash=?, updated_at=? WHERE id=?")
      .run(salt, hash, nowISO(), user.id);
    audit(db, user, "修改自己的密码", "");
    return json(res, 200, { ok: true });
  }

  // ---------- dashboard ----------
  if (path === "/api/dashboard" && method === "GET") {
    const products = db.prepare("SELECT * FROM products").all();
    const warehouses = db.prepare("SELECT * FROM warehouses ORDER BY id").all();
    const stockRows = db.prepare(`
      SELECT s.product_id, s.warehouse_id, s.qty, p.cost_price, p.safety_stock, p.sku, p.name, p.unit, w.name AS warehouse_name
      FROM stock s
      JOIN products p ON p.id = s.product_id
      JOIN warehouses w ON w.id = s.warehouse_id
    `).all();

    let qty = 0, value = 0;
    const byWh = {};
    for (const w of warehouses) byWh[w.id] = { id: w.id, name: w.name, qty: 0, value: 0, sku: 0 };
    const totalsByProduct = {};
    for (const r of stockRows) {
      const qn = Number(r.qty) || 0;
      const val = qn * (Number(r.cost_price) || 0);
      qty += qn;
      value += val;
      totalsByProduct[r.product_id] = (totalsByProduct[r.product_id] || 0) + qn;
      if (byWh[r.warehouse_id]) {
        byWh[r.warehouse_id].qty += qn;
        byWh[r.warehouse_id].value += val;
        if (qn) byWh[r.warehouse_id].sku += 1;
      }
    }
    const low = products.filter((p) => (totalsByProduct[p.id] || 0) <= Number(p.safety_stock)).map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      stock_total: roundQty(totalsByProduct[p.id] || 0),
      safety_stock: p.safety_stock,
      stocks: stockRows.filter((s) => s.product_id === p.id).map((s) => ({
        warehouse_id: s.warehouse_id,
        warehouse_name: s.warehouse_name,
        qty: s.qty
      }))
    })).sort((a, b) => (a.stock_total - a.safety_stock) - (b.stock_total - b.safety_stock));

    const recent = db.prepare(`
      SELECT * FROM movements ORDER BY date DESC, id DESC LIMIT 10
    `).all();

    return json(res, 200, {
      sku: products.length,
      qty: roundQty(qty),
      value: Math.round(value * 100) / 100,
      low_count: low.length,
      low_items: low,
      warehouses: Object.values(byWh).map((w) => ({
        ...w,
        qty: roundQty(w.qty),
        value: Math.round(w.value * 100) / 100
      })),
      recent
    });
  }

  // ---------- categories ----------
  if (path === "/api/categories" && method === "GET") {
    const rows = db.prepare(`
      SELECT c.id, c.name, COUNT(p.id) AS product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id
      GROUP BY c.id
      ORDER BY c.id
    `).all();
    return json(res, 200, { categories: rows });
  }
  if (path === "/api/categories" && method === "POST") {
    requireWrite(user);
    const body = await readJson(req);
    const name = requireStr(body.name, "分类名称", 30);
    const exists = db.prepare("SELECT id FROM categories WHERE name = ?").get(name);
    if (exists) throw httpError(400, "该分类已存在");
    const info = db.prepare("INSERT INTO categories (name) VALUES (?)").run(name);
    audit(db, user, "添加分类", name);
    return json(res, 201, { id: Number(info.lastInsertRowid), name });
  }
  let m = p("/api/categories/:id");
  if (m && method === "DELETE") {
    requireWrite(user);
    const id = Number(m.id);
    const cat = db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
    if (!cat) throw httpError(404, "分类不存在");
    const n = db.prepare("SELECT COUNT(*) AS n FROM products WHERE category_id = ?").get(id).n;
    if (n > 0) throw httpError(400, `该分类下还有 ${n} 个商品，无法删除`);
    db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    audit(db, user, "删除分类", cat.name);
    return json(res, 200, { ok: true });
  }

  // ---------- warehouses ----------
  if (path === "/api/warehouses" && method === "GET") {
    const rows = db.prepare(`
      SELECT w.*, COALESCE(SUM(s.qty), 0) AS qty,
             COUNT(CASE WHEN s.qty != 0 THEN 1 END) AS sku
      FROM warehouses w
      LEFT JOIN stock s ON s.warehouse_id = w.id
      GROUP BY w.id
      ORDER BY w.id
    `).all();
    return json(res, 200, { warehouses: rows });
  }
  if (path === "/api/warehouses" && method === "POST") {
    requireWrite(user);
    const body = await readJson(req);
    const name = requireStr(body.name, "仓库名称", 40);
    if (db.prepare("SELECT id FROM warehouses WHERE name = ?").get(name)) {
      throw httpError(400, "该仓库名称已存在");
    }
    const info = db.prepare("INSERT INTO warehouses (name, note, created_at) VALUES (?, ?, ?)")
      .run(name, optStr(body.note, 200), nowISO());
    audit(db, user, "添加仓库", name);
    return json(res, 201, { id: Number(info.lastInsertRowid) });
  }
  m = p("/api/warehouses/:id");
  if (m && method === "PUT") {
    requireWrite(user);
    const id = Number(m.id);
    const w = getWarehouse(db, id);
    if (!w) throw httpError(404, "仓库不存在");
    const body = await readJson(req);
    const name = requireStr(body.name, "仓库名称", 40);
    const clash = db.prepare("SELECT id FROM warehouses WHERE name = ? AND id != ?").get(name, id);
    if (clash) throw httpError(400, "该仓库名称已存在");
    db.prepare("UPDATE warehouses SET name = ?, note = ? WHERE id = ?").run(name, optStr(body.note, 200), id);
    audit(db, user, "编辑仓库", `${w.name} → ${name}`);
    return json(res, 200, { ok: true });
  }
  if (m && method === "DELETE") {
    requireWrite(user);
    const id = Number(m.id);
    const w = getWarehouse(db, id);
    if (!w) throw httpError(404, "仓库不存在");
    const count = db.prepare("SELECT COUNT(*) AS n FROM warehouses").get().n;
    if (count <= 1) throw httpError(400, "至少需要保留一个仓库");
    const st = db.prepare("SELECT COALESCE(SUM(ABS(qty)),0) AS q FROM stock WHERE warehouse_id = ?").get(id).q;
    if (st > 0) throw httpError(400, "该仓库还有库存，无法删除");
    db.prepare("DELETE FROM stock WHERE warehouse_id = ?").run(id);
    db.prepare("DELETE FROM warehouses WHERE id = ?").run(id);
    audit(db, user, "删除仓库", w.name);
    return json(res, 200, { ok: true });
  }

  // ---------- suppliers ----------
  if (path === "/api/suppliers" && method === "GET") {
    const rows = db.prepare("SELECT * FROM suppliers ORDER BY id").all();
    return json(res, 200, { suppliers: rows });
  }
  if (path === "/api/suppliers" && method === "POST") {
    requireWrite(user);
    const body = await readJson(req);
    const name = requireStr(body.name, "供应商名称", 80);
    if (db.prepare("SELECT id FROM suppliers WHERE name = ?").get(name)) {
      throw httpError(400, "该供应商已存在");
    }
    const info = db.prepare(
      "INSERT INTO suppliers (name, contact, phone, note, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(name, optStr(body.contact, 40), optStr(body.phone, 30), optStr(body.note, 200), nowISO());
    audit(db, user, "添加供应商", name);
    return json(res, 201, { id: Number(info.lastInsertRowid) });
  }
  m = p("/api/suppliers/:id");
  if (m && method === "PUT") {
    requireWrite(user);
    const id = Number(m.id);
    const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(id);
    if (!s) throw httpError(404, "供应商不存在");
    const body = await readJson(req);
    const name = requireStr(body.name, "供应商名称", 80);
    const clash = db.prepare("SELECT id FROM suppliers WHERE name = ? AND id != ?").get(name, id);
    if (clash) throw httpError(400, "该供应商已存在");
    db.prepare("UPDATE suppliers SET name=?, contact=?, phone=?, note=? WHERE id=?")
      .run(name, optStr(body.contact, 40), optStr(body.phone, 30), optStr(body.note, 200), id);
    audit(db, user, "编辑供应商", name);
    return json(res, 200, { ok: true });
  }
  if (m && method === "DELETE") {
    requireWrite(user);
    const id = Number(m.id);
    const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(id);
    if (!s) throw httpError(404, "供应商不存在");
    const n = db.prepare("SELECT COUNT(*) AS n FROM movements WHERE supplier_id = ? AND status = 'normal'").get(id).n;
    if (n > 0) throw httpError(400, "该供应商已有出入库记录，无法删除");
    db.prepare("DELETE FROM suppliers WHERE id = ?").run(id);
    audit(db, user, "删除供应商", s.name);
    return json(res, 200, { ok: true });
  }

  // ---------- products ----------
  if (path === "/api/products" && method === "GET") {
    const rows = db.prepare("SELECT * FROM products ORDER BY sku").all();
    const list = rows.map((r) => productPayload(db, r));
    let filtered = list;
    const query = (q.q || "").trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((x) =>
        x.name.toLowerCase().includes(query) || String(x.sku).toLowerCase().includes(query)
      );
    }
    if (q.sku) {
      const hit = list.find((x) => String(x.sku).toLowerCase() === String(q.sku).toLowerCase());
      return json(res, 200, { product: hit || null, products: hit ? [hit] : [] });
    }
    if (q.category_id) filtered = filtered.filter((x) => String(x.category_id) === String(q.category_id));
    return json(res, 200, { products: filtered });
  }
  if (path === "/api/products" && method === "POST") {
    requireWrite(user);
    const body = await readJson(req);
    const sku = requireStr(body.sku, "商品编码", 40);
    const name = requireStr(body.name, "商品名称", 80);
    if (db.prepare("SELECT id FROM products WHERE sku = ?").get(sku)) {
      throw httpError(400, "编码已存在，请更换一个唯一编码");
    }
    const unit = requireStr(body.unit || "个", "单位", 10);
    const cost = num(body.cost_price, 0);
    const sale = num(body.sale_price, 0);
    const safety = num(body.safety_stock, 0);
    const init = num(body.stock, 0);
    const warehouseId = body.warehouse_id ? Number(body.warehouse_id) : null;
    if (cost < 0 || sale < 0 || safety < 0 || init < 0) throw httpError(400, "价格和库存不能为负数");
    const created = tx(db, () => {
      const t = nowISO();
      const info = db.prepare(`
        INSERT INTO products (sku, name, category_id, unit, cost_price, sale_price, safety_stock, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sku, name, body.category_id || null, unit, cost, sale, safety, optStr(body.note), t, t
      );
      const id = Number(info.lastInsertRowid);
      if (init > 0) {
        const w = warehouseId ? getWarehouse(db, warehouseId) : db.prepare("SELECT * FROM warehouses ORDER BY id LIMIT 1").get();
        if (!w) throw httpError(400, "请先创建仓库，再录入期初库存");
        addStock(db, id, w.id, init);
        db.prepare(`
          INSERT INTO movements (type, product_id, sku, product_name, unit, warehouse_id, warehouse_name,
            quantity, date, operator, user_id, note, status, created_at)
          VALUES ('in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '期初入库', 'normal', ?)
        `).run(id, sku, name, unit, w.id, w.name, init, todayISO(), user.display_name, user.id, t);
      }
      audit(db, user, "新增商品", `${sku} ${name}`);
      return id;
    });
    return json(res, 201, { id: created, product: productPayload(db, getProduct(db, created)) });
  }
  m = p("/api/products/:id");
  if (m && method === "GET") {
    const prod = getProduct(db, Number(m.id));
    if (!prod) throw httpError(404, "商品不存在");
    return json(res, 200, { product: productPayload(db, prod) });
  }
  if (m && method === "PUT") {
    requireWrite(user);
    const id = Number(m.id);
    const prod = getProduct(db, id);
    if (!prod) throw httpError(404, "商品不存在");
    const body = await readJson(req);
    const sku = requireStr(body.sku, "商品编码", 40);
    const name = requireStr(body.name, "商品名称", 80);
    const clash = db.prepare("SELECT id FROM products WHERE sku = ? AND id != ?").get(sku, id);
    if (clash) throw httpError(400, "编码已存在，请更换一个唯一编码");
    const unit = requireStr(body.unit || "个", "单位", 10);
    const cost = num(body.cost_price, 0);
    const sale = num(body.sale_price, 0);
    const safety = num(body.safety_stock, 0);
    if (cost < 0 || sale < 0 || safety < 0) throw httpError(400, "价格和库存不能为负数");
    db.prepare(`
      UPDATE products SET sku=?, name=?, category_id=?, unit=?, cost_price=?, sale_price=?, safety_stock=?, note=?, updated_at=?
      WHERE id=?
    `).run(sku, name, body.category_id || null, unit, cost, sale, safety, optStr(body.note), nowISO(), id);
    audit(db, user, "编辑商品", `${sku} ${name}`);
    return json(res, 200, { product: productPayload(db, getProduct(db, id)) });
  }
  if (m && method === "DELETE") {
    requireWrite(user);
    const id = Number(m.id);
    const prod = getProduct(db, id);
    if (!prod) throw httpError(404, "商品不存在");
    const st = totalStock(db, id);
    if (st > 0) throw httpError(400, "该商品还有库存，无法删除");
    const n = db.prepare("SELECT COUNT(*) AS n FROM movements WHERE product_id = ?").get(id).n;
    if (n > 0) throw httpError(400, "该商品已有出入库记录，无法删除（可保留商品以便对账）");
    tx(db, () => {
      db.prepare("DELETE FROM stock WHERE product_id = ?").run(id);
      db.prepare("DELETE FROM products WHERE id = ?").run(id);
      audit(db, user, "删除商品", `${prod.sku} ${prod.name}`);
    });
    return json(res, 200, { ok: true });
  }

  // ---------- movements ----------
  if (path === "/api/movements" && method === "GET") {
    let sql = "SELECT * FROM movements WHERE 1=1";
    const args = [];
    if (q.type) { sql += " AND type = ?"; args.push(q.type); }
    if (q.product_id) { sql += " AND product_id = ?"; args.push(Number(q.product_id)); }
    if (q.warehouse_id) {
      sql += " AND (warehouse_id = ? OR from_warehouse_id = ? OR to_warehouse_id = ?)";
      args.push(Number(q.warehouse_id), Number(q.warehouse_id), Number(q.warehouse_id));
    }
    if (q.status) { sql += " AND status = ?"; args.push(q.status); }
    if (q.from) { sql += " AND date >= ?"; args.push(q.from); }
    if (q.to) { sql += " AND date <= ?"; args.push(q.to); }
    sql += " ORDER BY date DESC, id DESC LIMIT 2000";
    const rows = db.prepare(sql).all(...args);
    return json(res, 200, { movements: rows });
  }
  if (path === "/api/movements" && method === "POST") {
    requireWrite(user);
    const body = await readJson(req);
    const type = body.type === "out" ? "out" : "in";
    const product = getProduct(db, Number(body.product_id));
    if (!product) throw httpError(400, "请选择商品");
    const warehouse = getWarehouse(db, Number(body.warehouse_id));
    if (!warehouse) throw httpError(400, "请选择仓库");
    const quantity = num(body.quantity, 0);
    if (!(quantity > 0)) throw httpError(400, "数量必须大于 0");
    const date = requireStr(body.date || todayISO(), "日期", 20);
    const operator = optStr(body.operator || user.display_name, 40);
    const note = optStr(body.note, 200);
    let supplier = null;
    if (type === "in" && body.supplier_id) {
      supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(Number(body.supplier_id));
      if (!supplier) throw httpError(400, "供应商不存在");
    }
    const id = tx(db, () => {
      if (type === "in") addStock(db, product.id, warehouse.id, quantity);
      else addStock(db, product.id, warehouse.id, -quantity);
      const info = db.prepare(`
        INSERT INTO movements (type, product_id, sku, product_name, unit, warehouse_id, warehouse_name,
          quantity, date, operator, user_id, supplier_id, supplier_name, note, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?)
      `).run(
        type, product.id, product.sku, product.name, product.unit,
        warehouse.id, warehouse.name, quantity, date, operator, user.id,
        supplier ? supplier.id : null, supplier ? supplier.name : null,
        note, nowISO()
      );
      audit(db, user, type === "in" ? "入库" : "出库",
        `${product.sku} ${product.name} ${type === "in" ? "+" : "−"}${quantity} ${product.unit} @ ${warehouse.name}`);
      return Number(info.lastInsertRowid);
    });
    const leftover = getStock(db, product.id, warehouse.id);
    const total = totalStock(db, product.id);
    return json(res, 201, {
      id,
      stock: leftover,
      stock_total: total,
      low_stock: total <= Number(product.safety_stock)
    });
  }
  m = p("/api/movements/:id/void");
  if (m && method === "POST") {
    requireAdmin(user);
    const body = await readJson(req);
    const reason = requireStr(body.reason, "作废原因", 200);
    const id = Number(m.id);
    tx(db, () => {
      const mv = db.prepare("SELECT * FROM movements WHERE id = ?").get(id);
      if (!mv) throw httpError(404, "记录不存在");
      if (mv.status === "voided") throw httpError(400, "该记录已经作废");
      reverseMovement(db, mv);
      db.prepare(`
        UPDATE movements SET status='voided', void_reason=?, voided_by=?, voided_at=? WHERE id=?
      `).run(reason, user.id, nowISO(), id);
      audit(db, user, "作废出入库", `单号 #${id} ${mv.type} ${mv.sku} ${mv.quantity}；原因：${reason}`);
    });
    return json(res, 200, { ok: true });
  }

  // ---------- transfers ----------
  if (path === "/api/transfers" && method === "POST") {
    requireWrite(user);
    const body = await readJson(req);
    const product = getProduct(db, Number(body.product_id));
    if (!product) throw httpError(400, "请选择商品");
    const from = getWarehouse(db, Number(body.from_warehouse_id));
    const to = getWarehouse(db, Number(body.to_warehouse_id));
    if (!from || !to) throw httpError(400, "请选择调出和调入仓库");
    if (from.id === to.id) throw httpError(400, "调出与调入仓库不能相同");
    const quantity = num(body.quantity, 0);
    if (!(quantity > 0)) throw httpError(400, "数量必须大于 0");
    const date = requireStr(body.date || todayISO(), "日期", 20);
    const operator = optStr(body.operator || user.display_name, 40);
    const note = optStr(body.note, 200);
    const id = tx(db, () => {
      addStock(db, product.id, from.id, -quantity);
      addStock(db, product.id, to.id, quantity);
      const info = db.prepare(`
        INSERT INTO movements (type, product_id, sku, product_name, unit,
          from_warehouse_id, from_warehouse_name, to_warehouse_id, to_warehouse_name,
          quantity, date, operator, user_id, note, status, created_at)
        VALUES ('transfer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?)
      `).run(
        product.id, product.sku, product.name, product.unit,
        from.id, from.name, to.id, to.name, quantity, date, operator, user.id, note, nowISO()
      );
      audit(db, user, "仓库调拨",
        `${product.sku} ${product.name} ${quantity} ${product.unit}：${from.name} → ${to.name}`);
      return Number(info.lastInsertRowid);
    });
    return json(res, 201, { id });
  }

  // ---------- stocktake ----------
  if (path === "/api/stocktakes" && method === "GET") {
    const rows = db.prepare("SELECT * FROM stocktakes ORDER BY id DESC LIMIT 200").all();
    return json(res, 200, { stocktakes: rows });
  }
  if (path === "/api/stocktakes" && method === "POST") {
    requireWrite(user);
    const body = await readJson(req);
    const warehouse = getWarehouse(db, Number(body.warehouse_id));
    if (!warehouse) throw httpError(400, "请选择仓库");
    const date = requireStr(body.date || todayISO(), "日期", 20);
    const note = optStr(body.note, 200);
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (!lines.length) throw httpError(400, "请录入至少一行盘点数量");
    const id = tx(db, () => {
      const info = db.prepare(`
        INSERT INTO stocktakes (warehouse_id, warehouse_name, date, user_id, operator, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(warehouse.id, warehouse.name, date, user.id, user.display_name, note, nowISO());
      const sid = Number(info.lastInsertRowid);
      const insLine = db.prepare(`
        INSERT INTO stocktake_lines (stocktake_id, product_id, sku, product_name, unit, book_qty, counted_qty, adjust_qty, movement_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let adjusted = 0;
      for (const line of lines) {
        const product = getProduct(db, Number(line.product_id));
        if (!product) throw httpError(400, "盘点包含未知商品");
        const book = getStock(db, product.id, warehouse.id);
        const counted = num(line.counted_qty, NaN);
        if (!Number.isFinite(counted) || counted < 0) throw httpError(400, `${product.sku} 的盘点数量无效`);
        const adj = roundQty(counted - book);
        let movementId = null;
        if (adj !== 0) {
          addStock(db, product.id, warehouse.id, adj);
          const mi = db.prepare(`
            INSERT INTO movements (type, product_id, sku, product_name, unit, warehouse_id, warehouse_name,
              quantity, date, operator, user_id, note, status, created_at)
            VALUES ('adjust', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?)
          `).run(
            product.id, product.sku, product.name, product.unit,
            warehouse.id, warehouse.name, adj, date, user.display_name, user.id,
            `盘点调整（账存 ${book}，实盘 ${counted}）` + (note ? `；${note}` : ""),
            nowISO()
          );
          movementId = Number(mi.lastInsertRowid);
          adjusted += 1;
        }
        insLine.run(sid, product.id, product.sku, product.name, product.unit, book, counted, adj, movementId);
      }
      audit(db, user, "盘点", `${warehouse.name} 日期 ${date}，共 ${lines.length} 行，调整 ${adjusted} 项`);
      return sid;
    });
    return json(res, 201, { id });
  }
  m = p("/api/stocktakes/:id");
  if (m && method === "GET") {
    const st = db.prepare("SELECT * FROM stocktakes WHERE id = ?").get(Number(m.id));
    if (!st) throw httpError(404, "盘点单不存在");
    const lines = db.prepare("SELECT * FROM stocktake_lines WHERE stocktake_id = ? ORDER BY sku").all(st.id);
    return json(res, 200, { stocktake: st, lines });
  }

  // ---------- users ----------
  if (path === "/api/users" && method === "GET") {
    requireAdmin(user);
    const rows = db.prepare(`
      SELECT id, username, display_name, role, disabled, created_at, updated_at
      FROM users ORDER BY id
    `).all().map((u) => ({ ...u, role_label: roleLabel(u.role) }));
    return json(res, 200, { users: rows });
  }
  if (path === "/api/users" && method === "POST") {
    requireAdmin(user);
    const body = await readJson(req);
    const username = requireStr(body.username, "用户名", 30);
    if (!/^[A-Za-z0-9_.-]{2,30}$/.test(username)) {
      throw httpError(400, "用户名需为 2–30 位字母、数字或 ._-");
    }
    if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
      throw httpError(400, "用户名已存在");
    }
    const display = requireStr(body.display_name || username, "显示名称", 40);
    const role = body.role;
    if (!["admin", "keeper", "viewer"].includes(role)) throw httpError(400, "角色无效");
    const password = String(body.password || "");
    if (password.length < 6) throw httpError(400, "密码至少 6 位");
    const { salt, hash } = await hashPassword(password);
    const t = nowISO();
    const info = db.prepare(`
      INSERT INTO users (username, display_name, password_salt, password_hash, role, disabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(username, display, salt, hash, role, t, t);
    audit(db, user, "创建用户", `${username}（${roleLabel(role)}）`);
    return json(res, 201, { id: Number(info.lastInsertRowid) });
  }
  m = p("/api/users/:id");
  if (m && method === "PUT") {
    requireAdmin(user);
    const id = Number(m.id);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!row) throw httpError(404, "用户不存在");
    const body = await readJson(req);
    const display = requireStr(body.display_name || row.display_name, "显示名称", 40);
    const role = body.role || row.role;
    if (!["admin", "keeper", "viewer"].includes(role)) throw httpError(400, "角色无效");
    const disabled = body.disabled ? 1 : 0;
    if (id === user.id && disabled) throw httpError(400, "不能禁用当前登录的账号");
    if (id === user.id && role !== "admin") throw httpError(400, "不能取消自己的管理员角色");
    if (row.role === "admin" && role !== "admin") {
      const n = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0 AND id != ?").get(id).n;
      if (n === 0) throw httpError(400, "至少需要保留一名可用的管理员");
    }
    db.prepare("UPDATE users SET display_name=?, role=?, disabled=?, updated_at=? WHERE id=?")
      .run(display, role, disabled, nowISO(), id);
    if (disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    if (body.password) {
      const password = String(body.password);
      if (password.length < 6) throw httpError(400, "密码至少 6 位");
      const { salt, hash } = await hashPassword(password);
      db.prepare("UPDATE users SET password_salt=?, password_hash=?, updated_at=? WHERE id=?")
        .run(salt, hash, nowISO(), id);
    }
    audit(db, user, "更新用户", `${row.username} 角色=${roleLabel(role)} 禁用=${disabled}`);
    return json(res, 200, { ok: true });
  }
  if (m && method === "DELETE") {
    requireAdmin(user);
    const id = Number(m.id);
    if (id === user.id) throw httpError(400, "不能删除当前登录的账号");
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!row) throw httpError(404, "用户不存在");
    if (row.role === "admin") {
      const n = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0 AND id != ?").get(id).n;
      if (n === 0) throw httpError(400, "至少需要保留一名可用的管理员");
    }
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    audit(db, user, "删除用户", row.username);
    return json(res, 200, { ok: true });
  }

  // ---------- audit ----------
  if (path === "/api/audit-logs" && method === "GET") {
    const limit = Math.min(500, Math.max(1, num(q.limit, 200)));
    const offset = Math.max(0, num(q.offset, 0));
    const rows = db.prepare(
      "SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?"
    ).all(limit, offset);
    const total = db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n;
    return json(res, 200, { logs: rows, total });
  }

  // ---------- export / import ----------
  if (path === "/api/export/products.csv" && method === "GET") {
    const rows = [["编码", "名称", "分类", "单位", "进价", "售价", "安全库存", "库存合计", "各仓库库存", "库存成本", "备注"]];
    const products = db.prepare("SELECT * FROM products ORDER BY sku").all();
    for (const p0 of products) {
      const payload = productPayload(db, p0);
      const cost = (Number(p0.cost_price) || 0) * payload.stock_total;
      const br = payload.stocks.map((s) => `${s.warehouse_name}:${s.qty}`).join("；");
      rows.push([
        p0.sku, p0.name, payload.category, p0.unit, p0.cost_price, p0.sale_price,
        p0.safety_stock, payload.stock_total, br, (Math.round(cost * 100) / 100).toFixed(2), p0.note
      ]);
    }
    audit(db, user, "导出商品 CSV", `${products.length} 条`);
    return sendCsv(res, `商品清单_${todayISO()}.csv`, toCSV(rows));
  }
  if (path === "/api/export/movements.csv" && method === "GET") {
    const typeLabel = { in: "入库", out: "出库", transfer: "调拨", adjust: "盘点调整" };
    const list = db.prepare("SELECT * FROM movements ORDER BY date, id").all();
    const rows = [["单号", "日期", "类型", "状态", "商品编码", "商品名称", "数量", "单位", "仓库", "调出仓库", "调入仓库", "供应商", "经办人", "备注", "作废原因", "登记时间"]];
    for (const mv of list) {
      rows.push([
        mv.id, mv.date, typeLabel[mv.type] || mv.type, mv.status === "voided" ? "已作废" : "正常",
        mv.sku, mv.product_name, mv.quantity, mv.unit,
        mv.warehouse_name || "", mv.from_warehouse_name || "", mv.to_warehouse_name || "",
        mv.supplier_name || "", mv.operator || "", mv.note || "", mv.void_reason || "",
        formatDateTime(mv.created_at)
      ]);
    }
    audit(db, user, "导出出入库 CSV", `${list.length} 条`);
    return sendCsv(res, `出入库记录_${todayISO()}.csv`, toCSV(rows));
  }
  if (path === "/api/export/backup.json" && method === "GET") {
    requireAdmin(user);
    const payload = exportBackup(db);
    audit(db, user, "导出 JSON 备份", "");
    const text = JSON.stringify(payload, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("库存备份_" + todayISO() + ".json")}`
    });
    return res.end(text);
  }
  if (path === "/api/import/backup" && method === "POST") {
    requireAdmin(user);
    const body = await readJson(req);
    restoreBackup(db, body, user, !!(body && body.include_users));
    return json(res, 200, { ok: true });
  }
  if (path === "/api/demo" && method === "POST") {
    requireAdmin(user);
    const result = loadDemo(db, user);
    return json(res, 200, {
      ok: true,
      ...result,
      message: `演示数据已加载。演示账号：库管员 ${DEMO_KEEPER.username} / ${DEMO_KEEPER.password}，只读 ${DEMO_VIEWER.username} / ${DEMO_VIEWER.password}（若原先不存在才会创建）。`
    });
  }
  if (path === "/api/clear" && method === "POST") {
    requireAdmin(user);
    clearBusinessData(db, user);
    return json(res, 200, { ok: true });
  }

  throw httpError(404, "接口不存在");
}

function reverseMovement(db, mv) {
  const q = Number(mv.quantity);
  if (mv.type === "in") {
    addStock(db, mv.product_id, mv.warehouse_id, -q);
  } else if (mv.type === "out") {
    addStock(db, mv.product_id, mv.warehouse_id, q);
  } else if (mv.type === "adjust") {
    addStock(db, mv.product_id, mv.warehouse_id, -q);
  } else if (mv.type === "transfer") {
    addStock(db, mv.product_id, mv.to_warehouse_id, -q);
    addStock(db, mv.product_id, mv.from_warehouse_id, q);
  } else {
    throw httpError(400, "无法作废该类型的记录");
  }
}

function exportBackup(db) {
  return {
    app: "inventory-mis-server",
    version: 2,
    exportedAt: nowISO(),
    users: db.prepare("SELECT username, display_name, password_salt, password_hash, role, disabled, created_at, updated_at FROM users").all(),
    warehouses: db.prepare("SELECT * FROM warehouses").all(),
    suppliers: db.prepare("SELECT * FROM suppliers").all(),
    categories: db.prepare("SELECT * FROM categories").all(),
    products: db.prepare("SELECT * FROM products").all(),
    stock: db.prepare("SELECT * FROM stock").all(),
    movements: db.prepare("SELECT * FROM movements").all(),
    stocktakes: db.prepare("SELECT * FROM stocktakes").all(),
    stocktake_lines: db.prepare("SELECT * FROM stocktake_lines").all()
  };
}

function restoreBackup(db, data, user, includeUsers) {
  if (!data || data.app !== "inventory-mis-server" || !Array.isArray(data.products)) {
    throw httpError(400, "备份格式不正确，需要本系统导出的 JSON 文件");
  }
  tx(db, () => {
    db.exec(`
      DELETE FROM stocktake_lines;
      DELETE FROM stocktakes;
      DELETE FROM movements;
      DELETE FROM stock;
      DELETE FROM products;
      DELETE FROM categories;
      DELETE FROM suppliers;
      DELETE FROM warehouses;
    `);
    const runMany = (sql, rows, mapFn) => {
      const stmt = db.prepare(sql);
      for (const r of rows || []) stmt.run(...mapFn(r));
    };
    runMany(
      "INSERT INTO warehouses (id, name, note, created_at) VALUES (?, ?, ?, ?)",
      data.warehouses,
      (r) => [r.id, r.name, r.note || "", r.created_at || nowISO()]
    );
    runMany(
      "INSERT INTO suppliers (id, name, contact, phone, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      data.suppliers,
      (r) => [r.id, r.name, r.contact || "", r.phone || "", r.note || "", r.created_at || nowISO()]
    );
    runMany(
      "INSERT INTO categories (id, name) VALUES (?, ?)",
      data.categories,
      (r) => [r.id, r.name]
    );
    runMany(
      `INSERT INTO products (id, sku, name, category_id, unit, cost_price, sale_price, safety_stock, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.products,
      (r) => [r.id, r.sku, r.name, r.category_id || null, r.unit || "个", r.cost_price || 0, r.sale_price || 0,
        r.safety_stock || 0, r.note || "", r.created_at || nowISO(), r.updated_at || nowISO()]
    );
    runMany(
      "INSERT INTO stock (product_id, warehouse_id, qty) VALUES (?, ?, ?)",
      data.stock,
      (r) => [r.product_id, r.warehouse_id, r.qty || 0]
    );
    runMany(
      `INSERT INTO movements (id, type, product_id, sku, product_name, unit, warehouse_id, warehouse_name,
        from_warehouse_id, from_warehouse_name, to_warehouse_id, to_warehouse_name, quantity, date, operator, user_id,
        supplier_id, supplier_name, note, status, void_reason, voided_by, voided_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.movements,
      (r) => [r.id, r.type, r.product_id, r.sku, r.product_name, r.unit || "", r.warehouse_id, r.warehouse_name,
        r.from_warehouse_id, r.from_warehouse_name, r.to_warehouse_id, r.to_warehouse_name, r.quantity, r.date,
        r.operator || "", r.user_id, r.supplier_id, r.supplier_name, r.note || "", r.status || "normal",
        r.void_reason, r.voided_by, r.voided_at, r.created_at || nowISO()]
    );
    runMany(
      `INSERT INTO stocktakes (id, warehouse_id, warehouse_name, date, user_id, operator, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      data.stocktakes,
      (r) => [r.id, r.warehouse_id, r.warehouse_name, r.date, r.user_id, r.operator || "", r.note || "", r.created_at || nowISO()]
    );
    runMany(
      `INSERT INTO stocktake_lines (id, stocktake_id, product_id, sku, product_name, unit, book_qty, counted_qty, adjust_qty, movement_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.stocktake_lines,
      (r) => [r.id, r.stocktake_id, r.product_id, r.sku, r.product_name, r.unit, r.book_qty, r.counted_qty, r.adjust_qty, r.movement_id]
    );
    // Reset autoincrement sequences (sqlite_sequence may not exist yet)
    try {
      for (const table of ["warehouses", "suppliers", "categories", "products", "movements", "stocktakes", "stocktake_lines"]) {
        const row = db.prepare(`SELECT MAX(id) AS m FROM ${table}`).get();
        db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
        if (row && row.m) {
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, row.m);
        }
      }
    } catch (e) { /* ignore */ }
    if (includeUsers && Array.isArray(data.users) && data.users.length) {
      // Keep current admin so we don't lock ourselves out if missing; merge by username
      for (const u of data.users) {
        if (!u.username || !u.password_hash || !u.password_salt) continue;
        const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(u.username);
        if (exists) continue;
        db.prepare(`
          INSERT INTO users (username, display_name, password_salt, password_hash, role, disabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          u.username, u.display_name || u.username, u.password_salt, u.password_hash,
          u.role || "viewer", u.disabled ? 1 : 0, u.created_at || nowISO(), u.updated_at || nowISO()
        );
      }
    }
    audit(db, user, "导入 JSON 备份", `商品 ${ (data.products||[]).length }，记录 ${ (data.movements||[]).length }`);
  });
}
