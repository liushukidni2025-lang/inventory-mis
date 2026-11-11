import { nowISO, todayISO, tx, audit, addStock } from "./db.js";
import { hashPasswordSync } from "./auth.js";

export const DEMO_KEEPER = { username: "keeper", password: "keeper123", display: "库管演示" };
export const DEMO_VIEWER = { username: "viewer", password: "viewer123", display: "只读演示" };

function uidName() { return nowISO(); }

export function loadDemo(db, user) {
  return tx(db, () => {
    // Ensure demo users (do not overwrite admin or existing passwords)
    ensureDemoUser(db, DEMO_KEEPER.username, DEMO_KEEPER.display, DEMO_KEEPER.password, "keeper");
    ensureDemoUser(db, DEMO_VIEWER.username, DEMO_VIEWER.display, DEMO_VIEWER.password, "viewer");

    const now = nowISO();

    // Clear business data only (keep users/sessions)
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

    const insWh = db.prepare("INSERT INTO warehouses (name, note, created_at) VALUES (?, ?, ?)");
    insWh.run("主仓库", "总部仓储", now);
    insWh.run("门店仓", "零售门店后仓", now);
    insWh.run("备用仓", "安全库存备货", now);
    const wh = Object.fromEntries(
      db.prepare("SELECT id, name FROM warehouses").all().map((r) => [r.name, r.id])
    );

    const insSup = db.prepare(
      "INSERT INTO suppliers (name, contact, phone, note, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    insSup.run("华科电子商行", "赵明", "13800001111", "电子配件主供应商", now);
    insSup.run("文峰办公批发", "孙倩", "13900002222", "纸笔文件夹等", now);
    insSup.run("清源日配", "周强", "13700003333", "饮料与清洁用品", now);
    const sup = Object.fromEntries(
      db.prepare("SELECT id, name FROM suppliers").all().map((r) => [r.name, r.id])
    );

    const insCat = db.prepare("INSERT INTO categories (name) VALUES (?)");
    ["电子配件", "办公用品", "食品饮料", "清洁日用"].forEach((n) => insCat.run(n));
    const cat = Object.fromEntries(
      db.prepare("SELECT id, name FROM categories").all().map((r) => [r.name, r.id])
    );

    function P(sku, name, category, unit, cost, sale, safety, note) {
      const info = db.prepare(`
        INSERT INTO products (sku, name, category_id, unit, cost_price, sale_price, safety_stock, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sku, name, cat[category], unit, cost, sale, safety, note || "", now, now);
      return { id: Number(info.lastInsertRowid), sku, name, unit };
    }

    const products = [
      P("E-001", "USB-C 数据线", "电子配件", "条", 8, 19.9, 30, "1米编织线"),
      P("E-002", "无线鼠标", "电子配件", "个", 35, 69, 20, ""),
      P("E-003", "机械键盘", "电子配件", "台", 180, 299, 10, "青轴，需补货"),
      P("E-004", "插座转换器", "电子配件", "个", 25, 49, 10, ""),
      P("O-001", "A4 复印纸", "办公用品", "包", 18, 28, 20, "500张/包"),
      P("O-002", "中性笔", "办公用品", "支", 0.8, 2, 100, "0.5mm 黑色"),
      P("O-003", "文件夹", "办公用品", "个", 3.5, 8, 20, ""),
      P("O-004", "订书机", "办公用品", "个", 12, 22, 5, "缺货"),
      P("F-001", "矿泉水", "食品饮料", "箱", 18, 28, 15, "24瓶/箱"),
      P("F-002", "精选咖啡豆", "食品饮料", "袋", 68, 128, 8, "227g/袋"),
      P("C-001", "洗衣液", "清洁日用", "瓶", 22, 39.9, 12, "3kg"),
      P("C-002", "抽纸", "清洁日用", "提", 15, 25, 10, "10包/提")
    ];
    const bySku = Object.fromEntries(products.map((p) => [p.sku, p]));

    // Final intended stocks per warehouse (reconciled with movements below)
    const stocks = {
      "E-001": { "主仓库": 80, "门店仓": 30, "备用仓": 10 },
      "E-002": { "主仓库": 30, "门店仓": 15, "备用仓": 0 },
      "E-003": { "主仓库": 6, "门店仓": 2, "备用仓": 0 },
      "E-004": { "主仓库": 14, "门店仓": 8, "备用仓": 0 },
      "O-001": { "主仓库": 50, "门店仓": 20, "备用仓": 10 },
      "O-002": { "主仓库": 300, "门店仓": 150, "备用仓": 50 },
      "O-003": { "主仓库": 10, "门店仓": 5, "备用仓": 0 },
      "O-004": { "主仓库": 0, "门店仓": 0, "备用仓": 0 },
      "F-001": { "主仓库": 24, "门店仓": 16, "备用仓": 0 },
      "F-002": { "主仓库": 3, "门店仓": 2, "备用仓": 0 },
      "C-001": { "主仓库": 18, "门店仓": 12, "备用仓": 0 },
      "C-002": { "主仓库": 2, "门店仓": 1, "备用仓": 0 }
    };
    const insSt = db.prepare("INSERT INTO stock (product_id, warehouse_id, qty) VALUES (?, ?, ?)");
    for (const [sku, map] of Object.entries(stocks)) {
      for (const [wn, qty] of Object.entries(map)) {
        if (qty > 0) insSt.run(bySku[sku].id, wh[wn], qty);
      }
    }

    const insMv = db.prepare(`
      INSERT INTO movements (
        type, product_id, sku, product_name, unit,
        warehouse_id, warehouse_name, from_warehouse_id, from_warehouse_name,
        to_warehouse_id, to_warehouse_name, quantity, date, operator, user_id,
        supplier_id, supplier_name, note, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?)
    `);

    function hoursAgo(h) {
      return new Date(Date.now() - h * 3600 * 1000).toISOString();
    }
    const keeperUser = db.prepare("SELECT id FROM users WHERE username = 'keeper'").get();
    const uid = (user && user.id) || (keeperUser && keeperUser.id) || null;

    function mv(type, sku, qty, date, operator, opt = {}) {
      const p = bySku[sku];
      const wname = opt.warehouse || "主仓库";
      insMv.run(
        type, p.id, p.sku, p.name, p.unit,
        type === "transfer" ? null : wh[wname],
        type === "transfer" ? null : wname,
        type === "transfer" ? wh[opt.from] : null,
        type === "transfer" ? opt.from : null,
        type === "transfer" ? wh[opt.to] : null,
        type === "transfer" ? opt.to : null,
        qty, date, operator, uid,
        opt.supplier ? sup[opt.supplier] : null,
        opt.supplier || null,
        opt.note || "",
        hoursAgo(opt.ago || 24)
      );
    }

    // Inbound receipts then some outbound / transfers (narrative, not a full ledger of current stock)
    mv("in", "E-001", 150, "2026-10-08", "张伟", { supplier: "华科电子商行", note: "采购入库", warehouse: "主仓库", ago: 24 * 34 });
    mv("transfer", "E-001", 30, "2026-10-20", "李娜", { from: "主仓库", to: "门店仓", note: "门店补货", ago: 24 * 22 });
    mv("in", "E-002", 60, "2026-10-08", "张伟", { supplier: "华科电子商行", warehouse: "主仓库", ago: 24 * 34 });
    mv("out", "E-002", 15, "2026-11-02", "李娜", { warehouse: "门店仓", note: "零售出库", ago: 24 * 9 });
    mv("in", "E-003", 20, "2026-10-12", "张伟", { supplier: "华科电子商行", warehouse: "主仓库", ago: 24 * 30 });
    mv("out", "E-003", 12, "2026-11-05", "王强", { warehouse: "主仓库", note: "客户订单", ago: 24 * 6 });
    mv("in", "E-004", 30, "2026-11-07", "张伟", { supplier: "华科电子商行", warehouse: "主仓库", note: "配件补货", ago: 24 * 4 + 3 });
    mv("out", "E-004", 8, "2026-11-08", "李娜", { warehouse: "门店仓", ago: 24 * 3 });
    mv("in", "O-001", 100, "2026-10-10", "张伟", { supplier: "文峰办公批发", warehouse: "主仓库", note: "办公采购", ago: 24 * 32 });
    mv("transfer", "O-001", 20, "2026-11-01", "王强", { from: "主仓库", to: "门店仓", note: "门店领用", ago: 24 * 10 });
    mv("in", "O-002", 600, "2026-10-10", "张伟", { supplier: "文峰办公批发", warehouse: "主仓库", ago: 24 * 32 });
    mv("out", "O-002", 100, "2026-10-28", "李娜", { warehouse: "门店仓", note: "活动赠品", ago: 24 * 14 });
    mv("in", "O-003", 40, "2026-10-18", "张伟", { supplier: "文峰办公批发", warehouse: "主仓库", ago: 24 * 24 });
    mv("out", "O-003", 25, "2026-11-06", "王强", { warehouse: "主仓库", note: "部门领用", ago: 24 * 5 });
    mv("in", "O-004", 10, "2026-10-18", "张伟", { supplier: "文峰办公批发", warehouse: "主仓库", ago: 24 * 24 });
    mv("out", "O-004", 10, "2026-11-09", "李娜", { warehouse: "主仓库", note: "已售罄", ago: 24 * 2 });
    mv("in", "F-001", 50, "2026-11-06", "陈敏", { supplier: "清源日配", warehouse: "主仓库", note: "饮用水补货", ago: 24 * 5 + 2 });
    mv("out", "F-001", 10, "2026-11-07", "李娜", { warehouse: "门店仓", ago: 24 * 4 });
    mv("in", "F-002", 12, "2026-10-22", "陈敏", { supplier: "清源日配", warehouse: "主仓库", ago: 24 * 20 });
    mv("out", "F-002", 7, "2026-11-10", "王强", { warehouse: "门店仓", note: "咖啡角补给", ago: 24 * 1 });
    mv("in", "C-001", 36, "2026-10-25", "陈敏", { supplier: "清源日配", warehouse: "主仓库", ago: 24 * 17 });
    mv("out", "C-001", 6, "2026-11-04", "李娜", { warehouse: "门店仓", ago: 24 * 7 });
    mv("in", "C-002", 20, "2026-10-25", "陈敏", { supplier: "清源日配", warehouse: "主仓库", ago: 24 * 17 });
    mv("out", "C-002", 17, "2026-11-11", "王强", { warehouse: "门店仓", note: "库存偏低", ago: 5 });

    audit(db, user, "加载演示数据", "已写入演示仓库、供应商、商品、库存与出入库记录，并确保演示账号 keeper / viewer 可用");
    return {
      products: products.length,
      warehouses: 3,
      suppliers: 3,
      demo_users: [DEMO_KEEPER.username, DEMO_VIEWER.username]
    };
  });
}

function ensureDemoUser(db, username, display, password, role) {
  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (exists) return;
  const { salt, hash } = hashPasswordSync(password);
  const t = nowISO();
  db.prepare(`
    INSERT INTO users (username, display_name, password_salt, password_hash, role, disabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(username, display, salt, hash, role, t, t);
}

export function clearBusinessData(db, user) {
  return tx(db, () => {
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
    // Recreate a default warehouse so the system remains usable
    db.prepare("INSERT INTO warehouses (name, note, created_at) VALUES (?, ?, ?)")
      .run("主仓库", "", nowISO());
    audit(db, user, "清空业务数据", "已清空商品、库存、出入库、分类、供应商与仓库（保留用户账号），并重建默认「主仓库」");
  });
}
