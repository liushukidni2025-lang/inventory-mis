import { StringDecoder } from "node:string_decoder";

export function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

export function sendText(res, status, text, type = "text/plain; charset=utf-8", extra = {}) {
  const buf = Buffer.from(text);
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": buf.length,
    ...extra
  });
  res.end(buf);
}

export function sendCsv(res, filename, text) {
  sendText(res, 200, text, "text/csv; charset=utf-8", {
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  });
}

export function toCSV(rows) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求体过大"), { status: 413 }));
        req.destroy();
        return;
      }
      raw += decoder.write(chunk);
    });
    req.on("end", () => resolve(raw + decoder.end()));
    req.on("error", reject);
  });
}

export async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("请求不是有效的 JSON");
    err.status = 400;
    throw err;
  }
}

export function parseQuery(url) {
  const q = {};
  for (const [k, v] of url.searchParams) q[k] = v;
  return q;
}

export function matchPath(pattern, pathname) {
  const pSeg = pattern.split("/").filter(Boolean);
  const aSeg = pathname.split("/").filter(Boolean);
  if (pSeg.length !== aSeg.length) return null;
  const params = {};
  for (let i = 0; i < pSeg.length; i++) {
    if (pSeg[i].startsWith(":")) params[pSeg[i].slice(1)] = decodeURIComponent(aSeg[i]);
    else if (pSeg[i] !== aSeg[i]) return null;
  }
  return params;
}

export function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
