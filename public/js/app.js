(function () {
  "use strict";

  var PAGE_TITLES = {
    dashboard: "仪表盘", products: "商品管理", movements: "出入库",
    transfers: "仓库调拨", stocktake: "盘点", warehouses: "仓库管理",
    suppliers: "供应商", categories: "分类管理", audit: "操作日志",
    users: "用户管理", data: "数据"
  };
  var NAV = [
    { view: "dashboard", label: "仪表盘", icon: "grid" },
    { view: "products", label: "商品管理", icon: "box" },
    { view: "movements", label: "出入库", icon: "swap" },
    { view: "transfers", label: "仓库调拨", icon: "transfer", write: true },
    { view: "stocktake", label: "盘点", icon: "check", write: true },
    { view: "warehouses", label: "仓库管理", icon: "home" },
    { view: "suppliers", label: "供应商", icon: "truck" },
    { view: "categories", label: "分类管理", icon: "tag" },
    { view: "audit", label: "操作日志", icon: "log" },
    { view: "users", label: "用户管理", icon: "users", admin: true },
    { view: "data", label: "数据", icon: "data" }
  ];
  var state = {
    user: null, view: "dashboard", productQuery: "", productCategory: "",
    productSort: { key: "sku", dir: "asc" },
    moveFilter: { type: "", product_id: "", warehouse_id: "", status: "", from: "", to: "" }
  };
  var cache = { products: [], warehouses: [], suppliers: [], categories: [] };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function formatDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function formatMoney(n) {
    var v = Number(n); if (!isFinite(v)) v = 0;
    return "¥" + v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function formatQty(n) {
    var v = Number(n); if (!isFinite(v)) v = 0;
    if (Math.abs(v - Math.round(v)) < 1e-9) return Math.round(v).toLocaleString("zh-CN");
    return v.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  }
  function cmp(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), "zh-CN", { numeric: true, sensitivity: "base" });
  }
  function iconSearch() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>';
  }
  function emptySvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';
  }
  function isAdmin() { return state.user && state.user.role === "admin"; }
  function canWrite() { return state.user && (state.user.role === "admin" || state.user.role === "keeper"); }
  function typeBadge(t, status) {
    if (status === "voided") return '<span class="badge badge-void">已作废</span>';
    if (t === "in") return '<span class="badge badge-in">入库</span>';
    if (t === "out") return '<span class="badge badge-out">出库</span>';
    if (t === "transfer") return '<span class="badge badge-transfer">调拨</span>';
    if (t === "adjust") return '<span class="badge badge-adjust">盘点调整</span>';
    return escapeHtml(t);
  }
  function option(value, label, cur) {
    return '<option value="' + escapeHtml(value) + '"' + (String(cur) === String(value) ? " selected" : "") + ">" + escapeHtml(label) + "</option>";
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.body && !opts.raw) headers["Content-Type"] = "application/json";
    var res = await fetch(path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      credentials: "same-origin",
      headers: headers,
      body: opts.body && !opts.raw ? JSON.stringify(opts.body) : opts.body
    });
    if (opts.download) {
      if (!res.ok) {
        var errd = await res.json().catch(function () { return {}; });
        throw new Error(errd.error || "下载失败");
      }
      var blob = await res.blob();
      var dispo = res.headers.get("Content-Disposition") || "";
      var name = opts.filename || "download";
      var mm = /filename\*=UTF-8''([^;]+)/.exec(dispo);
      if (mm) name = decodeURIComponent(mm[1]);
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
      return;
    }
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401 && path !== "/api/login" && path !== "/api/me") {
      state.user = null;
      showLogin();
    }
    if (!res.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  async function refreshRefs() {
    var cats = await api("/api/categories");
    var wh = await api("/api/warehouses");
    var sup = await api("/api/suppliers");
    var prod = await api("/api/products");
    cache.categories = cats.categories || [];
    cache.warehouses = wh.warehouses || [];
    cache.suppliers = sup.suppliers || [];
    cache.products = prod.products || [];
  }

  function toast(msg, type) {
    var box = document.getElementById("toasts");
    var el = document.createElement("div");
    el.className = "toast " + (type || "success");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      el.style.transition = "opacity .2s";
      setTimeout(function () { el.remove(); }, 220);
    }, 3200);
  }
  var modalResolver = null;
  function openModal(opts) {
    document.getElementById("modalTitle").textContent = opts.title || "";
    document.getElementById("modalBody").innerHTML = opts.body || "";
    document.getElementById("modalFoot").innerHTML = opts.foot || "";
    document.getElementById("modalBox").className = "modal" + (opts.size ? " " + opts.size : "");
    document.getElementById("modalRoot").classList.add("open");
    var first = document.getElementById("modalBody").querySelector("input, select, textarea, button");
    if (first) setTimeout(function () { first.focus(); }, 30);
  }
  function closeModal(result) {
    document.getElementById("modalRoot").classList.remove("open");
    document.getElementById("modalBody").innerHTML = "";
    document.getElementById("modalFoot").innerHTML = "";
    var r = modalResolver;
    modalResolver = null;
    if (r) r(result);
  }
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      modalResolver = resolve;
      openModal({
        title: opts.title || "请确认",
        size: "narrow",
        body: '<p style="color:var(--text-secondary);line-height:1.7">' + (opts.message || "") + "</p>" +
          (opts.input ? '<label class="field" style="margin-top:12px">' + opts.inputLabel +
            '<input type="text" id="confirmInput" maxlength="200" required /></label>' : ""),
        foot: '<button type="button" class="btn btn-secondary" data-act="cancel">' + (opts.cancelText || "取消") + "</button>" +
          '<button type="button" class="btn ' + (opts.danger ? "btn-danger" : "btn-primary") + '" data-act="ok">' +
          (opts.confirmText || "确定") + "</button>"
      });
      document.getElementById("modalFoot").addEventListener("click", function onClick(e) {
        var btn = e.target.closest("[data-act]");
        if (!btn) return;
        if (btn.getAttribute("data-act") === "ok") {
          if (opts.input) {
            var v = (document.getElementById("confirmInput").value || "").trim();
            if (!v) { toast("请填写" + (opts.inputLabel || "原因"), "error"); return; }
            document.getElementById("modalFoot").removeEventListener("click", onClick);
            closeModal(v);
          } else {
            document.getElementById("modalFoot").removeEventListener("click", onClick);
            closeModal(true);
          }
        } else {
          document.getElementById("modalFoot").removeEventListener("click", onClick);
          closeModal(false);
        }
      });
    });
  }

  function iconSvg(name) {
    var p = {
      grid: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
      box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
      swap: '<path d="M7 10V3l-4 4 4 4"/><path d="M3 7h11a4 4 0 0 1 0 8h-1"/><path d="M17 14v7l4-4-4-4"/><path d="M21 17H10a4 4 0 0 1 0-8h1"/>',
      transfer: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
      check: '<path d="M9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
      home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
      truck: '<path d="M3 7h11v10H3z"/><path d="M14 10h4l3 3v4h-7z"/><circle cx="7" cy="17" r="2"/><circle cx="18" cy="17" r="2"/>',
      tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
      log: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
      users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
      data: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
    };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (p[name] || "") + "</svg>";
  }
  function renderNav() {
    document.getElementById("nav").innerHTML = NAV.filter(function (n) {
      if (n.admin && !isAdmin()) return false;
      if (n.write && !canWrite()) return false;
      return true;
    }).map(function (n) {
      return '<button type="button" data-view="' + n.view + '"' + (state.view === n.view ? ' class="active"' : "") + ">" +
        iconSvg(n.icon) + escapeHtml(n.label) + "</button>";
    }).join("");
  }
  function showLogin() {
    document.getElementById("appShell").hidden = true;
    document.getElementById("loginScreen").hidden = false;
    document.getElementById("loginError").classList.remove("show");
  }
  function showApp() {
    document.getElementById("loginScreen").hidden = true;
    document.getElementById("appShell").hidden = false;
    document.getElementById("userName").textContent = state.user.display_name || state.user.username;
    document.getElementById("userRole").textContent = state.user.role_label || "";
    renderNav();
    render();
  }
  async function render() {
    document.getElementById("pageTitle").textContent = PAGE_TITLES[state.view] || "";
    renderNav();
    var el = document.getElementById("content");
    el.innerHTML = '<div class="empty">加载中…</div>';
    try {
      var html = "";
      if (state.view === "dashboard") html = await renderDashboard();
      else if (state.view === "products") html = await renderProducts();
      else if (state.view === "movements") html = await renderMovements();
      else if (state.view === "transfers") html = await renderTransfers();
      else if (state.view === "stocktake") html = await renderStocktake();
      else if (state.view === "warehouses") html = await renderWarehouses();
      else if (state.view === "suppliers") html = await renderSuppliers();
      else if (state.view === "categories") html = await renderCategories();
      else if (state.view === "audit") html = await renderAudit();
      else if (state.view === "users") html = await renderUsers();
      else if (state.view === "data") html = renderData();
      el.innerHTML = html;
      afterRender();
    } catch (e) {
      el.innerHTML = '<div class="empty"><h4>加载失败</h4><p>' + escapeHtml(e.message) + "</p></div>";
    }
  }
  function closeSidebar() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("overlay").classList.remove("show");
  }
  function statIcon(name) {
    if (name === "box") return iconSvg("box");
    if (name === "stack") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>';
    if (name === "coin") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
  }
  function statCard(color, label, value, icon) {
    return '<article class="stat-card"><div class="stat-icon ' + color + '">' + statIcon(icon) +
      "</div><div><div class=\"stat-label\">" + label + "</div><div class=\"stat-value\">" + value + "</div></div></article>";
  }

  async function renderDashboard() {
    var d = await api("/api/dashboard");
    var banner = "";
    if (!d.sku) {
      banner = '<div class="banner"><div><h3>系统暂无商品数据</h3><p>' +
        (isAdmin() ? "管理员可以在「数据」页加载演示数据，或直接添加仓库与商品。" : "请联系管理员添加商品或加载演示数据。") +
        "</p></div>" +
        (isAdmin() ? '<button type="button" class="btn btn-primary" id="btnDemo">加载演示数据</button>' : "") +
        "</div>";
    }
    var whCards = (d.warehouses || []).map(function (w) {
      return '<article class="stat-card"><div class="stat-icon teal">' + iconSvg("home") + "</div><div>" +
        '<div class="stat-label">' + escapeHtml(w.name) + "</div>" +
        '<div class="stat-value" style="font-size:20px">' + formatQty(w.qty) + "</div>" +
        '<div class="muted" style="font-size:12px;margin-top:4px">成本 ' + formatMoney(w.value) + " · " + formatQty(w.sku) + " 种有库存</div></div></article>";
    }).join("");
    var lowRows = d.low_items.length
      ? d.low_items.map(function (p) {
          var tag = Number(p.stock_total) <= 0
            ? '<span class="badge badge-outstock">缺货</span>'
            : '<span class="badge badge-low">低于安全库存</span>';
          var br = (p.stocks || []).filter(function (s) { return s.qty; }).map(function (s) {
            return escapeHtml(s.warehouse_name) + " " + formatQty(s.qty);
          }).join("，");
          return "<tr class='" + (Number(p.stock_total) <= 0 ? "out-stock" : "low-stock") + "'>" +
            '<td class="mono">' + escapeHtml(p.sku) + "</td><td>" + escapeHtml(p.name) + "</td>" +
            '<td class="num">' + formatQty(p.stock_total) + " " + escapeHtml(p.unit) + "</td>" +
            '<td class="num">' + formatQty(p.safety_stock) + "</td>" +
            "<td class='muted'>" + (br || "—") + "</td><td>" + tag + "</td></tr>";
        }).join("")
      : '<tr><td colspan="6"><div class="empty" style="padding:28px 12px">' + (d.sku ? "当前没有低于安全库存的商品" : "暂无商品") + "</div></td></tr>";
    var moveRows = d.recent.length ? d.recent.map(moveRowHtml).join("")
      : '<tr><td colspan="6"><div class="empty" style="padding:28px 12px">暂无出入库记录</div></td></tr>';
    return banner +
      '<div class="cards">' +
        statCard("slate", "商品种数（SKU）", formatQty(d.sku), "box") +
        statCard("teal", "库存总量", formatQty(d.qty), "stack") +
        statCard("blue", "库存成本", formatMoney(d.value), "coin") +
        statCard(d.low_count ? "danger" : "warn", "低库存预警", formatQty(d.low_count), "alert") +
      "</div>" +
      (whCards ? '<h3 style="font-size:14px;margin:4px 0 12px">各仓库库存</h3><div class="wh-grid">' + whCards + "</div>" : "") +
      '<div class="grid-2">' +
        '<section class="panel"><div class="panel-hd"><h3>低库存商品</h3><span class="sub">' + d.low_items.length +
        ' 项</span></div><div class="table-wrap"><table class="data"><thead><tr>' +
        "<th>编码</th><th>名称</th><th class=\"num\">合计库存</th><th class=\"num\">安全库存</th><th>分仓</th><th>状态</th>" +
        "</tr></thead><tbody>" + lowRows + "</tbody></table></div></section>" +
        '<section class="panel"><div class="panel-hd"><h3>最近出入库</h3><span class="sub">最近 10 条</span></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' +
        "<th>日期</th><th>类型</th><th>商品</th><th class=\"num\">数量</th><th>仓库</th><th>经办人</th>" +
        "</tr></thead><tbody>" + moveRows + "</tbody></table></div></section></div>";
  }
  function moveRowHtml(m) {
    var wh = m.type === "transfer"
      ? escapeHtml(m.from_warehouse_name || "") + " → " + escapeHtml(m.to_warehouse_name || "")
      : escapeHtml(m.warehouse_name || "—");
    var sign = m.type === "out" ? "−" : (m.type === "in" || (m.type === "adjust" && m.quantity > 0) ? "+" : "");
    return "<tr class='" + (m.status === "voided" ? "voided" : "") + "'>" +
      "<td>" + escapeHtml(m.date) + "</td><td>" + typeBadge(m.type, m.status) + "</td>" +
      "<td><div>" + escapeHtml(m.product_name) + '</div><div class="muted mono">' + escapeHtml(m.sku) + "</div></td>" +
      '<td class="num">' + sign + formatQty(m.quantity) + ' <span class="muted">' + escapeHtml(m.unit || "") + "</span></td>" +
      "<td>" + wh + "</td><td>" + escapeHtml(m.operator || "—") + "</td></tr>";
  }
  function sortMark(key) {
    if (state.productSort.key !== key) return '<span class="sort">↕</span>';
    return '<span class="sort">' + (state.productSort.dir === "asc" ? "↑" : "↓") + "</span>";
  }
  function productOptions(selected) {
    return '<option value="">请选择商品</option>' + cache.products.map(function (p) {
      return '<option value="' + p.id + '"' + (String(selected) === String(p.id) ? " selected" : "") + ">" +
        escapeHtml(p.sku + "  " + p.name + "  （合计 " + formatQty(p.stock_total) + " " + p.unit + "）") + "</option>";
    }).join("");
  }
  function warehouseOptions(selected, emptyLabel) {
    return '<option value="">' + (emptyLabel || "请选择仓库") + "</option>" + cache.warehouses.map(function (w) {
      return '<option value="' + w.id + '"' + (String(selected) === String(w.id) ? " selected" : "") + ">" +
        escapeHtml(w.name) + "</option>";
    }).join("");
  }
  function supplierOptions(selected) {
    return '<option value="">无 / 不指定</option>' + cache.suppliers.map(function (s) {
      return '<option value="' + s.id + '"' + (String(selected) === String(s.id) ? " selected" : "") + ">" +
        escapeHtml(s.name) + "</option>";
    }).join("");
  }
  function findProduct(id) {
    return cache.products.find(function (p) { return String(p.id) === String(id); });
  }

  async function renderProducts() {
    await refreshRefs();
    var list = cache.products.slice();
    var q = (state.productQuery || "").trim().toLowerCase();
    var cat = state.productCategory;
    if (q) list = list.filter(function (p) {
      return String(p.name).toLowerCase().indexOf(q) !== -1 || String(p.sku).toLowerCase().indexOf(q) !== -1;
    });
    if (cat) list = list.filter(function (p) { return String(p.category_id) === String(cat); });
    var key = state.productSort.key;
    var dir = state.productSort.dir === "desc" ? -1 : 1;
    list.sort(function (a, b) {
      var va = key === "stock_total" ? Number(a.stock_total) : a[key];
      var vb = key === "stock_total" ? Number(b.stock_total) : b[key];
      return cmp(va, vb) * dir;
    });
    var catOpts = '<option value="">全部分类</option>' + cache.categories.map(function (c) {
      return '<option value="' + c.id + '"' + (String(state.productCategory) === String(c.id) ? " selected" : "") + ">" +
        escapeHtml(c.name) + "</option>";
    }).join("");
    var rows;
    if (!cache.products.length) {
      rows = '<tr><td colspan="8"><div class="empty">' + emptySvg() + "<h4>还没有商品</h4>" +
        (canWrite() ? '<button type="button" class="btn btn-primary" id="btnAddProduct">新增商品</button>' : "") + "</div></td></tr>";
    } else if (!list.length) {
      rows = '<tr><td colspan="8"><div class="empty"><h4>没有匹配的商品</h4></div></td></tr>';
    } else {
      rows = list.map(function (p) {
        var out = Number(p.stock_total) <= 0;
        var cls = out ? "out-stock" : (p.low_stock ? "low-stock" : "");
        var st = out ? '<span class="badge badge-outstock">缺货</span>'
          : (p.low_stock ? '<span class="badge badge-low">偏低</span>' : '<span class="badge badge-ok">正常</span>');
        var br = (p.stocks || []).filter(function (s) { return Number(s.qty); })
          .map(function (s) { return escapeHtml(s.warehouse_name) + " " + formatQty(s.qty); }).join("<br>");
        return '<tr class="' + cls + '"><td class="mono">' + escapeHtml(p.sku) + "</td><td>" + escapeHtml(p.name) +
          "</td><td>" + (p.category ? '<span class="badge badge-cat">' + escapeHtml(p.category) + "</span>" : "—") +
          "</td><td>" + escapeHtml(p.unit) + '</td><td class="num">' + formatMoney(p.cost_price) +
          '</td><td class="num"><strong>' + formatQty(p.stock_total) + "</strong><div class='muted' style='font-size:11px'>" +
          (br || "—") + '</div></td><td class="num">' + formatQty(p.safety_stock) + " " + st +
          '</td><td class="actions">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="barcode" data-id="' + p.id + '">条码</button>' +
          (canWrite() ? '<button type="button" class="btn btn-ghost btn-sm" data-act="move" data-id="' + p.id + '">出入库</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-id="' + p.id + '">编辑</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="del" data-id="' + p.id + '" style="color:var(--danger)">删除</button>' : "") +
          "</td></tr>";
      }).join("");
    }
    return '<div class="toolbar"><div class="grow search">' + iconSearch() +
      '<input type="search" id="productSearch" placeholder="搜索名称或编码…" value="' + escapeHtml(state.productQuery) + '" /></div>' +
      '<select id="productCatFilter" style="width:auto;min-width:140px">' + catOpts + "</select>" +
      '<button type="button" class="btn btn-secondary" id="btnPrintLabels">打印标签</button>' +
      (canWrite() ? '<button type="button" class="btn btn-primary" id="btnAddProduct">新增商品</button>' : "") +
      '</div><div class="panel"><div class="table-wrap" style="max-height:min(640px, calc(100vh - 220px))"><table class="data" id="productTable"><thead><tr>' +
      '<th class="sortable" data-sort="sku">编码' + sortMark("sku") + "</th>" +
      '<th class="sortable" data-sort="name">名称' + sortMark("name") + "</th>" +
      "<th>分类</th><th>单位</th>" +
      '<th class="num sortable" data-sort="cost_price">进价' + sortMark("cost_price") + "</th>" +
      '<th class="num sortable" data-sort="stock_total">库存' + sortMark("stock_total") + "</th>" +
      '<th class="num sortable" data-sort="safety_stock">安全库存' + sortMark("safety_stock") + "</th>" +
      '<th class="num">操作</th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
  }

  async function renderMovements() {
    await refreshRefs();
    var f = state.moveFilter;
    var qs = new URLSearchParams();
    Object.keys(f).forEach(function (k) { if (f[k]) qs.set(k, f[k]); });
    var data = await api("/api/movements?" + qs.toString());
    var list = data.movements || [];
    var rows = !list.length
      ? '<tr><td colspan="10"><div class="empty">' + emptySvg() + "<h4>没有出入库记录</h4></div></td></tr>"
      : list.map(function (m) {
          var wh = m.type === "transfer"
            ? escapeHtml(m.from_warehouse_name || "") + " → " + escapeHtml(m.to_warehouse_name || "")
            : escapeHtml(m.warehouse_name || "—");
          var voidBtn = (isAdmin() && m.status === "normal")
            ? '<button type="button" class="btn btn-ghost btn-sm" data-act="void" data-id="' + m.id + '" style="color:var(--danger)">作废</button>'
            : "";
          return "<tr class='" + (m.status === "voided" ? "voided" : "") + "'><td>" + m.id + "</td><td>" +
            escapeHtml(m.date) + "</td><td>" + typeBadge(m.type, m.status) + '</td><td class="mono">' +
            escapeHtml(m.sku) + "</td><td>" + escapeHtml(m.product_name) + '</td><td class="num">' +
            formatQty(m.quantity) + " " + escapeHtml(m.unit || "") + "</td><td>" + wh + "</td><td>" +
            escapeHtml(m.supplier_name || "—") + "</td><td>" + escapeHtml(m.operator || "—") +
            '</td><td class="actions">' + voidBtn + "</td></tr>";
        }).join("");
    return '<div class="toolbar">' +
      '<select id="moveTypeFilter" style="width:auto;min-width:110px">' +
        option("", "全部类型", f.type) + option("in", "入库", f.type) + option("out", "出库", f.type) +
        option("transfer", "调拨", f.type) + option("adjust", "盘点调整", f.type) + "</select>" +
      '<select id="moveProductFilter" style="width:auto;min-width:180px"><option value="">全部商品</option>' +
        cache.products.map(function (p) {
          return '<option value="' + p.id + '"' + (String(f.product_id) === String(p.id) ? " selected" : "") + ">" +
            escapeHtml(p.sku + " " + p.name) + "</option>";
        }).join("") + "</select>" +
      '<select id="moveWhFilter" style="width:auto;min-width:120px">' + warehouseOptions(f.warehouse_id, "全部仓库") + "</select>" +
      '<select id="moveStatusFilter" style="width:auto;min-width:110px">' +
        option("", "全部状态", f.status) + option("normal", "正常", f.status) + option("voided", "已作废", f.status) + "</select>" +
      '<input type="date" id="moveFrom" value="' + escapeHtml(f.from) + '" style="width:auto" />' +
      '<input type="date" id="moveTo" value="' + escapeHtml(f.to) + '" style="width:auto" />' +
      '<div class="grow"></div>' +
      (canWrite() ? '<button type="button" class="btn btn-primary" id="btnAddMove">登记出入库</button>' : "") +
      '</div><div class="panel"><div class="table-wrap" style="max-height:min(640px, calc(100vh - 220px))"><table class="data"><thead><tr>' +
      "<th>单号</th><th>日期</th><th>类型</th><th>编码</th><th>商品</th><th class=\"num\">数量</th><th>仓库</th><th>供应商</th><th>经办人</th><th></th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  async function renderTransfers() {
    await refreshRefs();
    var data = await api("/api/movements?type=transfer");
    var list = data.movements || [];
    var rows = list.length ? list.map(function (m) {
      return "<tr class='" + (m.status === "voided" ? "voided" : "") + "'><td>" + escapeHtml(m.date) +
        "</td><td class='mono'>" + escapeHtml(m.sku) + "</td><td>" + escapeHtml(m.product_name) +
        "</td><td>" + escapeHtml(m.from_warehouse_name) + "</td><td>" + escapeHtml(m.to_warehouse_name) +
        '</td><td class="num">' + formatQty(m.quantity) + " " + escapeHtml(m.unit) + "</td><td>" +
        escapeHtml(m.operator) + "</td><td>" + typeBadge("transfer", m.status) + "</td></tr>";
    }).join("") : '<tr><td colspan="8"><div class="empty">暂无调拨记录</div></td></tr>';
    return (canWrite() ? '<div class="panel" style="margin-bottom:16px"><div class="panel-hd"><h3>新建调拨</h3></div><div class="panel-bd pad">' +
      '<form id="transferForm" class="form-grid">' +
        '<label class="field span-2">商品<span class="req">*</span><select name="product_id" required>' + productOptions() + "</select></label>" +
        '<label class="field">调出仓库<span class="req">*</span><select name="from_warehouse_id" required>' + warehouseOptions() + "</select></label>" +
        '<label class="field">调入仓库<span class="req">*</span><select name="to_warehouse_id" required>' + warehouseOptions() + "</select></label>" +
        '<label class="field">数量<span class="req">*</span><input type="number" name="quantity" min="0.001" step="0.001" required /></label>' +
        '<label class="field">日期<span class="req">*</span><input type="date" name="date" required value="' + todayISO() + '" /></label>' +
        '<label class="field span-2">备注<input type="text" name="note" maxlength="100" /></label>' +
        '<div class="span-2"><button type="submit" class="btn btn-primary">确认调拨</button></div></form></div></div>' : "") +
      '<div class="panel"><div class="panel-hd"><h3>调拨历史</h3></div><div class="table-wrap"><table class="data"><thead><tr>' +
      "<th>日期</th><th>编码</th><th>商品</th><th>调出</th><th>调入</th><th class=\"num\">数量</th><th>经办人</th><th>状态</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  async function renderStocktake() {
    await refreshRefs();
    var hist = await api("/api/stocktakes");
    var histRows = (hist.stocktakes || []).length
      ? hist.stocktakes.map(function (s) {
          return "<tr><td>" + s.id + "</td><td>" + escapeHtml(s.date) + "</td><td>" + escapeHtml(s.warehouse_name) +
            "</td><td>" + escapeHtml(s.operator) + "</td><td>" + escapeHtml(s.note || "—") +
            '</td><td class="actions"><button type="button" class="btn btn-ghost btn-sm" data-act="view-st" data-id="' + s.id + '">查看</button></td></tr>';
        }).join("")
      : '<tr><td colspan="6"><div class="empty">暂无盘点单</div></td></tr>';
    var form = canWrite()
      ? '<div class="panel" style="margin-bottom:16px"><div class="panel-hd"><h3>新建盘点</h3><span class="sub">选择仓库后录入实盘数量，提交后系统按差异自动调整库存</span></div>' +
        '<div class="panel-bd pad"><div class="toolbar" style="margin:0 0 12px">' +
          '<label class="field" style="flex-direction:row;align-items:center;gap:8px">仓库<select id="stWarehouse" style="width:auto;min-width:160px">' +
          warehouseOptions() + "</select></label>" +
          '<label class="field" style="flex-direction:row;align-items:center;gap:8px">日期<input type="date" id="stDate" value="' + todayISO() + '" style="width:auto" /></label>' +
          '<input type="text" id="stNote" placeholder="备注（选填）" style="max-width:240px" /></div>' +
        '<div id="stTableWrap" class="muted">请先选择仓库</div>' +
        '<div style="margin-top:12px"><button type="button" class="btn btn-primary" id="btnSubmitStocktake" disabled>提交盘点</button></div></div></div>'
      : "";
    return form + '<div class="panel"><div class="panel-hd"><h3>盘点历史</h3></div><div class="table-wrap"><table class="data"><thead><tr>' +
      "<th>单号</th><th>日期</th><th>仓库</th><th>操作人</th><th>备注</th><th></th></tr></thead><tbody>" + histRows + "</tbody></table></div></div>";
  }

  async function renderWarehouses() {
    var data = await api("/api/warehouses");
    cache.warehouses = data.warehouses;
    var rows = data.warehouses.map(function (w) {
      return "<tr><td>" + escapeHtml(w.name) + "</td><td>" + escapeHtml(w.note || "—") +
        '</td><td class="num">' + formatQty(w.sku) + '</td><td class="num">' + formatQty(w.qty) +
        '</td><td class="actions">' + (canWrite()
          ? '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-wh" data-id="' + w.id + '">编辑</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="del-wh" data-id="' + w.id + '" style="color:var(--danger)">删除</button>'
          : "") + "</td></tr>";
    }).join("");
    return (canWrite() ? '<div class="toolbar"><button type="button" class="btn btn-primary" id="btnAddWh">新增仓库</button></div>' : "") +
      '<div class="panel"><div class="table-wrap"><table class="data"><thead><tr>' +
      "<th>名称</th><th>备注</th><th class=\"num\">有库存品种</th><th class=\"num\">库存总量</th><th></th>" +
      "</tr></thead><tbody>" + (rows || '<tr><td colspan="5"><div class="empty">暂无仓库</div></td></tr>') + "</tbody></table></div></div>";
  }

  async function renderSuppliers() {
    var data = await api("/api/suppliers");
    cache.suppliers = data.suppliers;
    var rows = data.suppliers.map(function (s) {
      return "<tr><td>" + escapeHtml(s.name) + "</td><td>" + escapeHtml(s.contact || "—") +
        "</td><td>" + escapeHtml(s.phone || "—") + "</td><td>" + escapeHtml(s.note || "—") +
        '</td><td class="actions">' + (canWrite()
          ? '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-sup" data-id="' + s.id + '">编辑</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="del-sup" data-id="' + s.id + '" style="color:var(--danger)">删除</button>'
          : "") + "</td></tr>";
    }).join("");
    return (canWrite() ? '<div class="toolbar"><button type="button" class="btn btn-primary" id="btnAddSup">新增供应商</button></div>' : "") +
      '<div class="panel"><div class="table-wrap"><table class="data"><thead><tr>' +
      "<th>名称</th><th>联系人</th><th>电话</th><th>备注</th><th></th></tr></thead><tbody>" +
      (rows || '<tr><td colspan="5"><div class="empty">暂无供应商</div></td></tr>') + "</tbody></table></div></div>";
  }

  async function renderCategories() {
    var data = await api("/api/categories");
    cache.categories = data.categories;
    var add = canWrite()
      ? '<div class="toolbar"><form id="catForm" class="toolbar" style="width:100%;margin:0"><div class="grow">' +
        '<input type="text" id="catName" placeholder="输入新分类名称" maxlength="30" /></div>' +
        '<button type="submit" class="btn btn-primary">添加分类</button></form></div>'
      : "";
    if (!data.categories.length) {
      return add + '<div class="panel"><div class="empty">' + emptySvg() + "<h4>还没有分类</h4></div></div>";
    }
    var items = data.categories.map(function (c) {
      var n = Number(c.product_count) || 0;
      return '<div class="cat-item"><div><div class="cat-name">' + escapeHtml(c.name) +
        '</div><div class="cat-count">已关联 ' + n + " 个商品</div></div>" +
        (canWrite() ? '<button type="button" class="btn btn-soft-danger btn-sm" data-act="del-cat" data-id="' + c.id + '"' +
          (n ? " disabled title=\"该分类下还有商品，无法删除\"" : "") + ">删除</button>" : "") + "</div>";
    }).join("");
    return add + '<div class="panel"><div class="cat-list">' + items + "</div></div>";
  }

  async function renderAudit() {
    var data = await api("/api/audit-logs?limit=300");
    var rows = (data.logs || []).map(function (l) {
      return "<tr><td>" + escapeHtml(formatDateTime(l.created_at)) + "</td><td>" + escapeHtml(l.username) +
        "</td><td>" + escapeHtml(l.action) + "</td><td>" + escapeHtml(l.detail || "") + "</td></tr>";
    }).join("");
    return '<div class="panel"><div class="panel-hd"><h3>操作日志</h3><span class="sub">共 ' + data.total +
      " 条，显示最近 " + (data.logs || []).length + ' 条</span></div><div class="table-wrap" style="max-height:min(680px, calc(100vh - 200px))">' +
      '<table class="data"><thead><tr><th>时间</th><th>用户</th><th>动作</th><th>详情</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4"><div class="empty">暂无日志</div></td></tr>') + "</tbody></table></div></div>";
  }

  async function renderUsers() {
    var data = await api("/api/users");
    var rows = data.users.map(function (u) {
      var badge = u.role === "admin" ? "badge-admin" : (u.role === "keeper" ? "badge-keeper" : "badge-viewer");
      return "<tr class='" + (u.disabled ? "voided" : "") + "'><td class='mono'>" + escapeHtml(u.username) +
        "</td><td>" + escapeHtml(u.display_name) + "</td><td><span class='badge " + badge + "'>" +
        escapeHtml(u.role_label) + "</span></td><td>" + (u.disabled ? "已禁用" : "正常") +
        "</td><td>" + escapeHtml(formatDateTime(u.created_at)) + '</td><td class="actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-user" data-id="' + u.id + '">编辑</button>' +
        (u.id !== state.user.id ? '<button type="button" class="btn btn-ghost btn-sm" data-act="del-user" data-id="' + u.id + '" style="color:var(--danger)">删除</button>' : "") +
        "</td></tr>";
    }).join("");
    return '<div class="toolbar"><button type="button" class="btn btn-primary" id="btnAddUser">新增用户</button></div>' +
      '<div class="panel"><div class="table-wrap"><table class="data"><thead><tr>' +
      "<th>用户名</th><th>显示名称</th><th>角色</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody>" + rows + "</tbody></table></div></div>";
  }

  function renderData() {
    return '<div class="data-grid">' +
      '<div class="data-card"><h3>导出商品 CSV</h3><p>导出全部商品及分仓库存，UTF-8（含 BOM），可用 Excel 直接打开。</p>' +
        '<button type="button" class="btn btn-primary" id="btnExportProducts">导出商品 CSV</button></div>' +
      '<div class="data-card"><h3>导出出入库 CSV</h3><p>导出全部出入库、调拨、盘点调整与作废记录。</p>' +
        '<button type="button" class="btn btn-primary" id="btnExportMoves">导出出入库 CSV</button></div>' +
      (isAdmin()
        ? '<div class="data-card"><h3>备份全部数据（JSON）</h3><p>完整备份仓库、商品、库存与单据。恢复时默认不会覆盖现有用户。</p>' +
          '<button type="button" class="btn btn-secondary" id="btnExportJson">导出 JSON 备份</button></div>' +
          '<div class="data-card"><h3>从备份恢复</h3><p>导入此前导出的 JSON。<strong>将覆盖</strong>当前业务数据。</p>' +
          '<button type="button" class="btn btn-secondary" id="btnImportJson">导入 JSON 备份</button>' +
          '<input type="file" id="importFile" accept="application/json,.json" hidden /></div>' +
          '<div class="data-card"><h3>加载演示数据</h3><p>覆盖当前业务数据，并创建演示账号 keeper / viewer（若不存在）。</p>' +
          '<button type="button" class="btn btn-primary" id="btnDemo">加载演示数据</button></div>' +
          '<div class="data-card danger-zone"><h3>清空业务数据</h3><p>删除全部商品、库存与单据，保留用户账号，并重建默认主仓库。</p>' +
          '<button type="button" class="btn btn-danger" id="btnClearAll">清空业务数据</button></div>'
        : '<div class="data-card"><h3>完整备份</h3><p>JSON 备份与恢复仅限管理员操作。</p></div>') +
      "</div>";
  }

  function afterRender() {
    var stWh = document.getElementById("stWarehouse");
    if (stWh) stWh.addEventListener("change", loadStocktakeTable);
  }
  async function loadStocktakeTable() {
    var whId = document.getElementById("stWarehouse").value;
    var wrap = document.getElementById("stTableWrap");
    var btn = document.getElementById("btnSubmitStocktake");
    if (!whId) { wrap.innerHTML = '<span class="muted">请先选择仓库</span>'; if (btn) btn.disabled = true; return; }
    var data = await api("/api/products");
    var rows = data.products.map(function (p) {
      var st = (p.stocks || []).find(function (s) { return String(s.warehouse_id) === String(whId); });
      var book = st ? Number(st.qty) : 0;
      return '<tr data-pid="' + p.id + '" data-book="' + book + '"><td class="mono">' + escapeHtml(p.sku) +
        "</td><td>" + escapeHtml(p.name) + '</td><td class="num book">' + formatQty(book) +
        '</td><td><input type="number" class="counted" min="0" step="0.001" value="' + book +
        '" style="width:120px;margin-left:auto;display:block;text-align:right" /></td>' +
        '<td class="num diff muted">0</td></tr>';
    }).join("");
    wrap.innerHTML = '<div class="table-wrap" style="max-height:420px"><table class="data" id="stTable"><thead><tr>' +
      "<th>编码</th><th>名称</th><th class=\"num\">账存</th><th class=\"num\">实盘</th><th class=\"num\">差异</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";
    wrap.querySelectorAll(".counted").forEach(function (inp) {
      inp.addEventListener("input", function () {
        var tr = inp.closest("tr");
        var book = Number(tr.getAttribute("data-book"));
        var counted = Number(inp.value);
        var diff = (Number.isFinite(counted) ? counted : 0) - book;
        var cell = tr.querySelector(".diff");
        cell.textContent = (diff > 0 ? "+" : "") + formatQty(diff);
        cell.style.color = diff === 0 ? "" : (diff > 0 ? "var(--success)" : "var(--danger)");
      });
    });
    if (btn) btn.disabled = false;
  }

  function openProductForm(p) {
    var isEdit = !!p;
    var catOpts = '<option value="">请选择分类</option>' + cache.categories.map(function (c) {
      return '<option value="' + c.id + '"' + (p && String(p.category_id) === String(c.id) ? " selected" : "") + ">" +
        escapeHtml(c.name) + "</option>";
    }).join("");
    var stockField = isEdit
      ? '<label class="field span-2">当前库存（各仓）<div class="hint" style="padding:8px 0;color:var(--text)">' +
        (p.stocks || []).map(function (s) { return escapeHtml(s.warehouse_name) + "：" + formatQty(s.qty) + " " + escapeHtml(p.unit); }).join("；") +
        "；合计 " + formatQty(p.stock_total) + '</div><span class="hint">库存请通过出入库、调拨或盘点调整。</span></label>'
      : '<label class="field">期初库存<input type="number" name="stock" min="0" step="0.001" value="0" /></label>' +
        '<label class="field">期初仓库<select name="warehouse_id">' + warehouseOptions(cache.warehouses[0] && cache.warehouses[0].id) +
        '</select><span class="hint">若填写期初库存，将记为该仓库的入库。</span></label>';
    openModal({
      title: isEdit ? "编辑商品" : "新增商品",
      body: '<form id="productForm" class="form-grid" autocomplete="off">' +
        '<label class="field">编码（SKU）<span class="req">*</span><input type="text" name="sku" required maxlength="40" value="' + escapeHtml(p && p.sku || "") + '" /></label>' +
        '<label class="field">名称<span class="req">*</span><input type="text" name="name" required maxlength="80" value="' + escapeHtml(p && p.name || "") + '" /></label>' +
        '<label class="field">分类<select name="category_id">' + catOpts + "</select></label>" +
        '<label class="field">单位<span class="req">*</span><input type="text" name="unit" required list="unitList" value="' + escapeHtml(p && p.unit || "个") + '" />' +
        '<datalist id="unitList"><option value="个"><option value="件"><option value="台"><option value="套"><option value="箱"><option value="盒"><option value="包"><option value="袋"><option value="瓶"><option value="支"><option value="条"><option value="提"><option value="kg"></datalist></label>' +
        '<label class="field">进价（元）<input type="number" name="cost_price" min="0" step="0.01" value="' + escapeHtml(p ? p.cost_price : "") + '" /></label>' +
        '<label class="field">售价（元）<input type="number" name="sale_price" min="0" step="0.01" value="' + escapeHtml(p ? p.sale_price : "") + '" /></label>' +
        stockField +
        '<label class="field">安全库存<input type="number" name="safety_stock" min="0" step="0.001" value="' + escapeHtml(p ? p.safety_stock : 0) + '" /><span class="hint">按全部仓库合计库存预警。</span></label>' +
        '<label class="field span-2">备注<textarea name="note" maxlength="200">' + escapeHtml(p && p.note || "") + "</textarea></label></form>",
      foot: '<button type="button" class="btn btn-secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn-primary" id="btnSaveProduct">' + (isEdit ? "保存修改" : "添加商品") + "</button>"
    });
    document.querySelector("#modalFoot [data-act=cancel]").onclick = function () { closeModal(); };
    document.getElementById("btnSaveProduct").onclick = function () { saveProduct(p && p.id); };
    document.getElementById("productForm").onsubmit = function (e) { e.preventDefault(); saveProduct(p && p.id); };
  }

  async function saveProduct(id) {
    var fd = new FormData(document.getElementById("productForm"));
    var body = {
      sku: fd.get("sku"), name: fd.get("name"), unit: fd.get("unit"),
      category_id: fd.get("category_id") ? Number(fd.get("category_id")) : null,
      cost_price: fd.get("cost_price"), sale_price: fd.get("sale_price"),
      safety_stock: fd.get("safety_stock"), note: fd.get("note")
    };
    if (!id) {
      body.stock = fd.get("stock");
      body.warehouse_id = fd.get("warehouse_id") ? Number(fd.get("warehouse_id")) : null;
    }
    try {
      if (id) await api("/api/products/" + id, { method: "PUT", body: body });
      else await api("/api/products", { method: "POST", body: body });
      closeModal();
      toast(id ? "商品已更新" : "商品已添加");
      render();
    } catch (e) { toast(e.message, "error"); }
  }

  function openMoveForm(presetId) {
    if (!cache.products.length) { toast("请先添加商品", "error"); return; }
    if (!cache.warehouses.length) { toast("请先添加仓库", "error"); return; }
    openModal({
      title: "登记出入库",
      body: '<form id="moveForm" class="form-grid" autocomplete="off">' +
        '<div class="field span-2">类型<div class="type-switch" style="margin-top:6px">' +
          '<label class="in"><input type="radio" name="type" value="in" checked /> 入库</label>' +
          '<label class="out"><input type="radio" name="type" value="out" /> 出库</label></div></div>' +
        '<label class="field span-2">商品<span class="req">*</span><select name="product_id" id="mvProduct" required>' + productOptions(presetId) + '</select><div class="stock-hint" id="mvStockHint"></div></label>' +
        '<label class="field">仓库<span class="req">*</span><select name="warehouse_id" id="mvWh" required>' + warehouseOptions(cache.warehouses[0] && cache.warehouses[0].id) + "</select></label>" +
        '<label class="field" id="mvSupWrap">供应商<select name="supplier_id">' + supplierOptions() + "</select></label>" +
        '<label class="field">数量<span class="req">*</span><input type="number" name="quantity" id="mvQty" min="0.001" step="0.001" required /><div class="field-error" id="mvQtyErr"></div></label>' +
        '<label class="field">日期<span class="req">*</span><input type="date" name="date" required value="' + todayISO() + '" /></label>' +
        '<label class="field">经办人<input type="text" name="operator" maxlength="20" value="' + escapeHtml(state.user.display_name) + '" /></label>' +
        '<label class="field">备注<input type="text" name="note" maxlength="100" /></label></form>',
      foot: '<button type="button" class="btn btn-secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn-primary" id="btnSaveMove">确认登记</button>'
    });
    document.querySelector("#modalFoot [data-act=cancel]").onclick = function () { closeModal(); };
    document.getElementById("btnSaveMove").onclick = saveMove;
    document.getElementById("moveForm").onsubmit = function (e) { e.preventDefault(); saveMove(); };
    function hint() {
      var p = findProduct(document.getElementById("mvProduct").value);
      var w = document.getElementById("mvWh").value;
      var typ = (document.querySelector("#moveForm [name=type]:checked") || {}).value;
      document.getElementById("mvSupWrap").style.display = typ === "in" ? "" : "none";
      var box = document.getElementById("mvStockHint");
      if (!p) { box.textContent = ""; return; }
      var st = (p.stocks || []).find(function (s) { return String(s.warehouse_id) === String(w); });
      var qv = st ? st.qty : 0;
      box.innerHTML = "本仓库存 <strong>" + formatQty(qv) + " " + escapeHtml(p.unit) + "</strong>，全部仓库合计 " +
        formatQty(p.stock_total) + "，安全库存 " + formatQty(p.safety_stock);
      var qty = Number(document.getElementById("mvQty").value);
      var err = document.getElementById("mvQtyErr");
      err.textContent = (typ === "out" && qty > qv) ? ("出库数量不能超过本仓库存（" + formatQty(qv) + "）") : "";
    }
    document.getElementById("mvProduct").addEventListener("change", hint);
    document.getElementById("mvWh").addEventListener("change", hint);
    document.getElementById("mvQty").addEventListener("input", hint);
    document.querySelectorAll("#moveForm [name=type]").forEach(function (r) { r.addEventListener("change", hint); });
    hint();
  }

  async function saveMove() {
    var fd = new FormData(document.getElementById("moveForm"));
    var body = {
      type: fd.get("type"), product_id: Number(fd.get("product_id")), warehouse_id: Number(fd.get("warehouse_id")),
      quantity: fd.get("quantity"), date: fd.get("date"), operator: fd.get("operator"), note: fd.get("note"),
      supplier_id: fd.get("supplier_id") ? Number(fd.get("supplier_id")) : null
    };
    try {
      var r = await api("/api/movements", { method: "POST", body: body });
      closeModal();
      toast(body.type === "in" ? "入库成功，库存已增加" : "出库成功，库存已扣减");
      if (r.low_stock) setTimeout(function () { toast("该商品合计库存已达到或低于安全库存", "info"); }, 400);
      render();
    } catch (e) { toast(e.message, "error"); }
  }

  function showBarcode(p) {
    var svg = "";
    try { svg = window.Code128.svg(p.sku, { height: 72, scale: 2 }); }
    catch (e) { svg = '<p class="muted">' + escapeHtml(e.message) + "</p>"; }
    openModal({
      title: "商品条码", size: "narrow",
      body: '<div class="barcode-box">' + svg + '<div class="sku">' + escapeHtml(p.sku) + "</div><div>" + escapeHtml(p.name) + "</div></div>",
      foot: '<button type="button" class="btn btn-secondary" data-act="cancel">关闭</button>' +
        '<button type="button" class="btn btn-primary" id="btnPrintOne">打印此标签</button>'
    });
    document.querySelector("#modalFoot [data-act=cancel]").onclick = function () { closeModal(); };
    document.getElementById("btnPrintOne").onclick = function () { closeModal(); printLabels([p]); };
  }
  function openPrintLabels() {
    var items = cache.products.map(function (p) {
      return '<label class="cat-item" style="cursor:pointer"><div><input type="checkbox" name="pid" value="' + p.id +
        '" checked style="margin-right:8px" />' + escapeHtml(p.sku) + " " + escapeHtml(p.name) + "</div></label>";
    }).join("");
    openModal({
      title: "打印条码标签",
      body: '<p class="hint" style="margin-bottom:10px">勾选要打印的商品，将打开打印预览（Code 128）。</p>' +
        '<div style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:8px">' + items + "</div>",
      foot: '<button type="button" class="btn btn-secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn-primary" id="btnDoPrint">预览并打印</button>'
    });
    document.querySelector("#modalFoot [data-act=cancel]").onclick = function () { closeModal(); };
    document.getElementById("btnDoPrint").onclick = function () {
      var ids = Array.prototype.map.call(document.querySelectorAll("#modalBody input[name=pid]:checked"), function (i) { return i.value; });
      closeModal();
      printLabels(cache.products.filter(function (p) { return ids.indexOf(String(p.id)) !== -1; }));
    };
  }
  function printLabels(list) {
    if (!list.length) { toast("请选择商品", "error"); return; }
    var html = '<div class="label-sheet">' + list.map(function (p) {
      var svg = "";
      try { svg = window.Code128.svg(p.sku, { height: 70, scale: 2 }); }
      catch (e) { svg = "<div>" + escapeHtml(e.message) + "</div>"; }
      return '<div class="label-item"><div class="n">' + escapeHtml(p.name) + "</div>" + svg +
        '<div class="s">' + escapeHtml(p.sku) + "</div></div>";
    }).join("") + "</div>";
    openModal({
      title: "打印预览", size: "wide",
      body: '<div class="label-preview">' + html + "</div>",
      foot: '<button type="button" class="btn btn-secondary" data-act="cancel">关闭</button>' +
        '<button type="button" class="btn btn-primary" id="btnWindowPrint">打印</button>'
    });
    document.querySelector("#modalFoot [data-act=cancel]").onclick = function () { closeModal(); };
    document.getElementById("btnWindowPrint").onclick = function () {
      document.getElementById("labelPage").innerHTML = html;
      window.print();
    };
  }
  function openSimpleForm(opts) {
    openModal({
      title: opts.title, size: "narrow",
      body: '<form id="simpleForm" class="form-grid" style="grid-template-columns:1fr">' + opts.fields + "</form>",
      foot: '<button type="button" class="btn btn-secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn-primary" id="btnSimpleSave">保存</button>'
    });
    document.querySelector("#modalFoot [data-act=cancel]").onclick = function () { closeModal(); };
    document.getElementById("btnSimpleSave").onclick = opts.onSave;
    document.getElementById("simpleForm").onsubmit = function (e) { e.preventDefault(); opts.onSave(); };
  }
  function formObj(id) {
    var fd = new FormData(document.getElementById(id));
    var o = {};
    fd.forEach(function (v, k) { o[k] = v; });
    return o;
  }

  document.getElementById("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var err = document.getElementById("loginError");
    err.classList.remove("show");
    var btn = document.getElementById("loginBtn");
    btn.disabled = true;
    try {
      var data = await api("/api/login", {
        method: "POST",
        body: { username: document.getElementById("loginUser").value, password: document.getElementById("loginPass").value }
      });
      state.user = data.user;
      document.getElementById("loginPass").value = "";
      showApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.add("show");
    } finally { btn.disabled = false; }
  });

  document.getElementById("btnLogout").onclick = async function () {
    try { await api("/api/logout", { method: "POST", body: {} }); } catch (e) { /* ignore */ }
    state.user = null;
    showLogin();
  };
  document.getElementById("btnPassword").onclick = function () {
    openModal({
      title: "修改密码", size: "narrow",
      body: '<form id="pwdForm"><label class="field">当前密码<input type="password" name="current_password" required /></label>' +
        '<label class="field" style="margin-top:10px">新密码（至少 6 位）<input type="password" name="new_password" required minlength="6" /></label></form>',
      foot: '<button type="button" class="btn btn-secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn-primary" id="btnSavePwd">保存</button>'
    });
    document.querySelector("#modalFoot [data-act=cancel]").onclick = function () { closeModal(); };
    document.getElementById("btnSavePwd").onclick = async function () {
      try {
        await api("/api/me/password", { method: "POST", body: formObj("pwdForm") });
        closeModal(); toast("密码已修改");
      } catch (e) { toast(e.message, "error"); }
    };
  };

  document.getElementById("nav").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-view]");
    if (!btn) return;
    state.view = btn.getAttribute("data-view");
    closeSidebar();
    render();
  });
  document.getElementById("menuBtn").onclick = function () {
    var sb = document.getElementById("sidebar");
    if (sb.classList.contains("open")) closeSidebar();
    else { sb.classList.add("open"); document.getElementById("overlay").classList.add("show"); }
  };
  document.getElementById("overlay").onclick = closeSidebar;
  document.getElementById("modalClose").onclick = function () { closeModal(false); };
  document.getElementById("modalBackdrop").onclick = function () { closeModal(false); };
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (document.getElementById("modalRoot").classList.contains("open")) closeModal(false);
      else closeSidebar();
    }
  });

  document.getElementById("scanForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var sku = document.getElementById("scanInput").value.trim();
    if (!sku) return;
    try {
      var data = await api("/api/products?sku=" + encodeURIComponent(sku));
      document.getElementById("scanInput").select();
      if (!data.product) { toast("未找到编码：" + sku, "error"); return; }
      state.view = "products";
      state.productQuery = sku;
      await render();
      showBarcode(data.product);
    } catch (ex) { toast(ex.message, "error"); }
  });

  document.getElementById("content").addEventListener("click", async function (e) {
    var t = e.target.closest("[data-act], button, .sortable");
    if (!t || !document.getElementById("content").contains(t)) return;
    var act = t.getAttribute("data-act");
    var id = t.getAttribute("data-id");

    if (t.id === "btnAddProduct") { openProductForm(null); return; }
    if (t.id === "btnAddMove") { openMoveForm(null); return; }
    if (t.id === "btnPrintLabels") { openPrintLabels(); return; }
    if (t.id === "btnAddWh") {
      openSimpleForm({
        title: "新增仓库",
        fields: '<label class="field">名称<span class="req">*</span><input name="name" required maxlength="40" /></label><label class="field">备注<input name="note" maxlength="200" /></label>',
        onSave: async function () {
          try { await api("/api/warehouses", { method: "POST", body: formObj("simpleForm") }); closeModal(); toast("仓库已添加"); render(); }
          catch (ex) { toast(ex.message, "error"); }
        }
      });
      return;
    }
    if (t.id === "btnAddSup") {
      openSimpleForm({
        title: "新增供应商",
        fields: '<label class="field">名称<span class="req">*</span><input name="name" required maxlength="80" /></label><label class="field">联系人<input name="contact" maxlength="40" /></label><label class="field">电话<input name="phone" maxlength="30" /></label><label class="field">备注<input name="note" maxlength="200" /></label>',
        onSave: async function () {
          try { await api("/api/suppliers", { method: "POST", body: formObj("simpleForm") }); closeModal(); toast("供应商已添加"); render(); }
          catch (ex) { toast(ex.message, "error"); }
        }
      });
      return;
    }
    if (t.id === "btnAddUser") {
      openSimpleForm({
        title: "新增用户",
        fields: '<label class="field">用户名<span class="req">*</span><input name="username" required maxlength="30" /></label><label class="field">显示名称<input name="display_name" maxlength="40" /></label><label class="field">角色<select name="role"><option value="keeper">库管员</option><option value="viewer">只读</option><option value="admin">管理员</option></select></label><label class="field">初始密码<span class="req">*</span><input name="password" type="password" required minlength="6" /></label>',
        onSave: async function () {
          try { await api("/api/users", { method: "POST", body: formObj("simpleForm") }); closeModal(); toast("用户已创建"); render(); }
          catch (ex) { toast(ex.message, "error"); }
        }
      });
      return;
    }
    if (t.id === "btnExportProducts") { try { await api("/api/export/products.csv", { download: true, filename: "商品清单.csv" }); toast("已导出商品 CSV"); } catch (ex) { toast(ex.message, "error"); } return; }
    if (t.id === "btnExportMoves") { try { await api("/api/export/movements.csv", { download: true, filename: "出入库记录.csv" }); toast("已导出出入库 CSV"); } catch (ex) { toast(ex.message, "error"); } return; }
    if (t.id === "btnExportJson") { try { await api("/api/export/backup.json", { download: true, filename: "库存备份.json" }); toast("已导出 JSON 备份"); } catch (ex) { toast(ex.message, "error"); } return; }
    if (t.id === "btnImportJson") { document.getElementById("importFile").click(); return; }
    if (t.id === "btnDemo") {
      var ok = await confirmDialog({ title: "加载演示数据", message: "将<strong>覆盖</strong>当前全部业务数据（商品、库存、单据等），用户账号会保留。是否继续？", confirmText: "覆盖并加载", danger: true });
      if (!ok) return;
      try { var r = await api("/api/demo", { method: "POST", body: {} }); toast(r.message || "已加载演示数据"); state.view = "dashboard"; render(); }
      catch (ex) { toast(ex.message, "error"); }
      return;
    }
    if (t.id === "btnClearAll") {
      var ok2 = await confirmDialog({ title: "清空业务数据", message: "将删除全部商品、库存与单据，且无法恢复。用户账号会保留。确定清空吗？", confirmText: "确认清空", danger: true });
      if (!ok2) return;
      try { await api("/api/clear", { method: "POST", body: {} }); toast("已清空业务数据"); state.view = "dashboard"; render(); }
      catch (ex) { toast(ex.message, "error"); }
      return;
    }
    if (t.id === "btnSubmitStocktake") {
      var wrap = document.getElementById("stTable");
      if (!wrap) return;
      var lines = Array.prototype.map.call(wrap.querySelectorAll("tbody tr"), function (tr) {
        return { product_id: Number(tr.getAttribute("data-pid")), counted_qty: tr.querySelector(".counted").value };
      });
      try {
        await api("/api/stocktakes", { method: "POST", body: {
          warehouse_id: Number(document.getElementById("stWarehouse").value),
          date: document.getElementById("stDate").value,
          note: document.getElementById("stNote").value,
          lines: lines
        }});
        toast("盘点已提交，库存已按差异调整");
        render();
      } catch (ex) { toast(ex.message, "error"); }
      return;
    }
    if (t.classList.contains("sortable")) {
      var key = t.getAttribute("data-sort");
      if (state.productSort.key === key) state.productSort.dir = state.productSort.dir === "asc" ? "desc" : "asc";
      else state.productSort = { key: key, dir: "asc" };
      render();
      return;
    }
    if (act === "edit") { openProductForm(findProduct(id)); return; }
    if (act === "move") { openMoveForm(id); return; }
    if (act === "barcode") { showBarcode(findProduct(id)); return; }
    if (act === "del") {
      var p = findProduct(id);
      var okd = await confirmDialog({ title: "删除商品", message: "确定删除「" + escapeHtml(p && p.name || "") + "」吗？有库存或历史单据的商品不能删除。", confirmText: "删除", danger: true });
      if (!okd) return;
      try { await api("/api/products/" + id, { method: "DELETE" }); toast("商品已删除"); render(); }
      catch (ex) { toast(ex.message, "error"); }
      return;
    }
    if (act === "void") {
      var reason = await confirmDialog({ title: "作废单据", message: "作废后将回滚该单据对库存的影响，且不可恢复。请填写作废原因。", input: true, inputLabel: "作废原因", confirmText: "确认作废", danger: true });
      if (!reason) return;
      try { await api("/api/movements/" + id + "/void", { method: "POST", body: { reason: reason } }); toast("单据已作废，库存已回滚"); render(); }
      catch (ex) { toast(ex.message, "error"); }
      return;
    }
    if (act === "del-cat") {
      try { await api("/api/categories/" + id, { method: "DELETE" }); toast("分类已删除"); render(); }
      catch (ex) { toast(ex.message, "error"); }
      return;
    }
    if (act === "edit-wh" || act === "del-wh") {
      var listW = (await api("/api/warehouses")).warehouses;
      cache.warehouses = listW;
      var wh = listW.find(function (w) { return String(w.id) === String(id); });
      if (act === "del-wh") {
        var okw = await confirmDialog({ title: "删除仓库", message: "确定删除仓库「" + escapeHtml(wh && wh.name || "") + "」吗？有库存时不能删除。", confirmText: "删除", danger: true });
        if (!okw) return;
        try { await api("/api/warehouses/" + id, { method: "DELETE" }); toast("仓库已删除"); render(); }
        catch (ex) { toast(ex.message, "error"); }
        return;
      }
      openSimpleForm({
        title: "编辑仓库",
        fields: '<label class="field">名称<span class="req">*</span><input name="name" required value="' + escapeHtml(wh.name) + '" /></label><label class="field">备注<input name="note" value="' + escapeHtml(wh.note || "") + '" /></label>',
        onSave: async function () {
          try { await api("/api/warehouses/" + id, { method: "PUT", body: formObj("simpleForm") }); closeModal(); toast("仓库已更新"); render(); }
          catch (ex) { toast(ex.message, "error"); }
        }
      });
      return;
    }
    if (act === "edit-sup" || act === "del-sup") {
      var sups = (await api("/api/suppliers")).suppliers;
      var s = sups.find(function (x) { return String(x.id) === String(id); });
      if (act === "del-sup") {
        var oks = await confirmDialog({ title: "删除供应商", message: "确定删除「" + escapeHtml(s.name) + "」吗？", confirmText: "删除", danger: true });
        if (!oks) return;
        try { await api("/api/suppliers/" + id, { method: "DELETE" }); toast("供应商已删除"); render(); }
        catch (ex) { toast(ex.message, "error"); }
        return;
      }
      openSimpleForm({
        title: "编辑供应商",
        fields: '<label class="field">名称<span class="req">*</span><input name="name" required value="' + escapeHtml(s.name) + '" /></label><label class="field">联系人<input name="contact" value="' + escapeHtml(s.contact || "") + '" /></label><label class="field">电话<input name="phone" value="' + escapeHtml(s.phone || "") + '" /></label><label class="field">备注<input name="note" value="' + escapeHtml(s.note || "") + '" /></label>',
        onSave: async function () {
          try { await api("/api/suppliers/" + id, { method: "PUT", body: formObj("simpleForm") }); closeModal(); toast("供应商已更新"); render(); }
          catch (ex) { toast(ex.message, "error"); }
        }
      });
      return;
    }
    if (act === "edit-user") {
      var users = (await api("/api/users")).users;
      var u = users.find(function (x) { return String(x.id) === String(id); });
      openSimpleForm({
        title: "编辑用户 " + u.username,
        fields: '<label class="field">显示名称<input name="display_name" value="' + escapeHtml(u.display_name) + '" /></label><label class="field">角色<select name="role">' +
          option("admin", "管理员", u.role) + option("keeper", "库管员", u.role) + option("viewer", "只读", u.role) +
          '</select></label><label class="field">状态<select name="disabled">' +
          option("0", "正常", u.disabled ? "1" : "0") + option("1", "禁用", u.disabled ? "1" : "0") +
          '</select></label><label class="field">重置密码（留空则不改）<input name="password" type="password" minlength="6" /></label>',
        onSave: async function () {
          var o = formObj("simpleForm");
          o.disabled = o.disabled === "1";
          if (!o.password) delete o.password;
          try { await api("/api/users/" + id, { method: "PUT", body: o }); closeModal(); toast("用户已更新"); render(); }
          catch (ex) { toast(ex.message, "error"); }
        }
      });
      return;
    }
    if (act === "del-user") {
      var oku = await confirmDialog({ title: "删除用户", message: "确定删除该用户吗？其登录会话将立即失效。", confirmText: "删除", danger: true });
      if (!oku) return;
      try { await api("/api/users/" + id, { method: "DELETE" }); toast("用户已删除"); render(); }
      catch (ex) { toast(ex.message, "error"); }
      return;
    }
    if (act === "view-st") {
      try {
        var st = await api("/api/stocktakes/" + id);
        var lines = (st.lines || []).map(function (l) {
          return "<tr><td class='mono'>" + escapeHtml(l.sku) + "</td><td>" + escapeHtml(l.product_name) +
            "</td><td class='num'>" + formatQty(l.book_qty) + "</td><td class='num'>" + formatQty(l.counted_qty) +
            "</td><td class='num'>" + (l.adjust_qty > 0 ? "+" : "") + formatQty(l.adjust_qty) + "</td></tr>";
        }).join("");
        openModal({
          title: "盘点单 #" + st.stocktake.id + " · " + st.stocktake.warehouse_name, size: "wide",
          body: '<div class="muted" style="margin-bottom:10px">日期 ' + escapeHtml(st.stocktake.date) +
            " · " + escapeHtml(st.stocktake.operator) + " · " + escapeHtml(st.stocktake.note || "无备注") + "</div>" +
            '<div class="table-wrap"><table class="data"><thead><tr><th>编码</th><th>名称</th><th class="num">账存</th><th class="num">实盘</th><th class="num">调整</th></tr></thead><tbody>' +
            lines + "</tbody></table></div>",
          foot: '<button type="button" class="btn btn-secondary" data-act="cancel">关闭</button>'
        });
        document.querySelector("#modalFoot [data-act=cancel]").onclick = function () { closeModal(); };
      } catch (ex) { toast(ex.message, "error"); }
    }
  });

  document.getElementById("content").addEventListener("change", function (e) {
    var el = e.target;
    if (el.id === "productCatFilter") { state.productCategory = el.value; render(); }
    else if (el.id === "moveTypeFilter") { state.moveFilter.type = el.value; render(); }
    else if (el.id === "moveProductFilter") { state.moveFilter.product_id = el.value; render(); }
    else if (el.id === "moveWhFilter") { state.moveFilter.warehouse_id = el.value; render(); }
    else if (el.id === "moveStatusFilter") { state.moveFilter.status = el.value; render(); }
    else if (el.id === "moveFrom") { state.moveFilter.from = el.value; render(); }
    else if (el.id === "moveTo") { state.moveFilter.to = el.value; render(); }
    else if (el.id === "importFile") {
      var f = el.files && el.files[0];
      el.value = "";
      if (!f) return;
      f.text().then(async function (text) {
        var data;
        try { data = JSON.parse(text); } catch (err) { toast("文件不是有效的 JSON", "error"); return; }
        var ok = await confirmDialog({ title: "导入备份", message: "导入将<strong>覆盖</strong>当前业务数据。是否继续？", confirmText: "覆盖并导入", danger: true });
        if (!ok) return;
        try { await api("/api/import/backup", { method: "POST", body: data }); toast("备份已导入"); state.view = "dashboard"; render(); }
        catch (ex) { toast(ex.message, "error"); }
      });
    }
  });

  var searchTimer = null;
  document.getElementById("content").addEventListener("input", function (e) {
    if (e.target.id !== "productSearch") return;
    state.productQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { render(); }, 220);
  });

  document.getElementById("content").addEventListener("submit", async function (e) {
    if (e.target.id === "catForm") {
      e.preventDefault();
      try {
        await api("/api/categories", { method: "POST", body: { name: document.getElementById("catName").value } });
        toast("分类已添加"); render();
      } catch (ex) { toast(ex.message, "error"); }
    }
    if (e.target.id === "transferForm") {
      e.preventDefault();
      var o = formObj("transferForm");
      o.product_id = Number(o.product_id);
      o.from_warehouse_id = Number(o.from_warehouse_id);
      o.to_warehouse_id = Number(o.to_warehouse_id);
      try {
        await api("/api/transfers", { method: "POST", body: o });
        toast("调拨成功，库存已更新");
        render();
      } catch (ex) { toast(ex.message, "error"); }
    }
  });

  async function boot() {
    try {
      var me = await api("/api/me");
      if (me.user) { state.user = me.user; showApp(); }
      else showLogin();
    } catch (e) { showLogin(); }
  }
  boot();
})();
