// FigBridge relay: Figma uploads a design, gets a 6-character code; the Studio plugin downloads it by code.
// No dependencies. Run: node server.js   (port via PORT env, default 7777)
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 7777;
// HOSTED mode (public server, e.g. Render) turns on automatically when the RENDER env var exists, or set HOSTED=1.
const HOSTED = !!(process.env.RENDER || process.env.HOSTED);
const HOST = process.env.HOST || (HOSTED ? "0.0.0.0" : "127.0.0.1"); // locally only this PC can connect
const MB = 1024 * 1024;
const MAX_BODY = (Number(process.env.MAX_BODY_MB) || (HOSTED ? 30 : 100)) * MB; // reject larger uploads
const MAX_TOTAL = (Number(process.env.MAX_TOTAL_MB) || (HOSTED ? 300 : 2000)) * MB; // all designs together
const MAX_ENTRIES = HOSTED ? 200 : 50; // keep at most this many designs in memory
const TTL_MS = 6 * 60 * 60 * 1000; // codes live 6 hours
const store = new Map(); // code -> { doc, images, created, ready }

// ---------- Roblox Open Cloud image upload ----------
// server/config.json: { "apiKey": "...", "userId": 123 }  (or "groupId" instead of userId)
const CONFIG_PATH = path.join(__dirname, "config.json");
const CACHE_PATH = path.join(__dirname, "asset-cache.json"); // image hash -> decal asset id
function loadJSON(p, fallback) {
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { return fallback; } // missing file is fine
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); } // PowerShell 5.1 writes a BOM
  catch (e) { console.log("WARNING: could not parse " + path.basename(p) + ": " + e.message); return fallback; }
}
const config = loadJSON(CONFIG_PATH, null);
const assetCache = loadJSON(CACHE_PATH, {});
if (config && config.apiKey && (config.userId || config.groupId)) console.log("Open Cloud upload: enabled");
else console.log("Open Cloud upload: disabled (create server/config.json, see README)");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadDecal(id, pngBase64) {
  const creator = config.groupId ? { groupId: String(config.groupId) } : { userId: String(config.userId) };
  const form = new FormData();
  form.append("request", JSON.stringify({
    assetType: "Decal",
    displayName: "FigBridge " + id.slice(0, 8),
    description: "Uploaded by FigBridge",
    creationContext: { creator },
  }));
  form.append("fileContent", new Blob([Buffer.from(pngBase64, "base64")], { type: "image/png" }), "image.png");
  let res;
  for (let attempt = 0; attempt < 4; attempt++) { // back off on rate limits / transient errors
    res = await fetch("https://apis.roblox.com/assets/v1/assets", { method: "POST", headers: { "x-api-key": config.apiKey }, body: form });
    if (res.status !== 429 && res.status < 500) break;
    await sleep(1500 * (attempt + 1));
  }
  const op = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("upload " + res.status + " " + JSON.stringify(op).slice(0, 200));
  let result = op;
  for (let i = 0; i < 30 && !(result.done && result.response); i++) {
    await sleep(1000);
    const opId = String(op.path || op.operationId || "").replace(/^operations\//, "");
    const r = await fetch("https://apis.roblox.com/assets/v1/operations/" + opId, { headers: { "x-api-key": config.apiKey } });
    result = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("operation " + r.status + " " + JSON.stringify(result).slice(0, 200));
  }
  const assetId = result.response && result.response.assetId;
  if (!assetId) throw new Error("upload timed out");
  return String(assetId);
}

async function uploadAll(entry) {
  if (!config || !config.apiKey) return;
  for (const [id, img] of Object.entries(entry.images)) {
    if (!img.png) continue;
    if (assetCache[id]) { img.decal = assetCache[id]; continue; }
    try {
      img.decal = await uploadDecal(id, img.png);
      assetCache[id] = img.decal;
      fs.writeFileSync(CACHE_PATH, JSON.stringify(assetCache, null, 1));
      console.log("[asset] " + id.slice(0, 8) + " -> decal " + img.decal);
    } catch (e) {
      img.uploadError = String(e.message || e);
      console.log("[asset] " + id.slice(0, 8) + " FAILED: " + img.uploadError);
    }
  }
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
function newCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  } while (store.has(code));
  return code;
}

function send(res, status, body) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(data);
}

function cleanup() {
  const now = Date.now();
  for (const [code, entry] of store) if (now - entry.created > TTL_MS) store.delete(code);
}
setInterval(cleanup, 10 * 60 * 1000).unref();
function totalBytes() { let n = 0; for (const e of store.values()) n += e.bytes || 0; return n; }
function evictOldest() {
  while (store.size > MAX_ENTRIES || (store.size > 1 && totalBytes() > MAX_TOTAL)) {
    let oldest = null;
    for (const [code, e] of store) if (!oldest || e.created < store.get(oldest).created) oldest = code;
    store.delete(oldest);
  }
}

// Only the Figma plugin (Origin "null" or none), Studio (no Origin) and localhost pages may talk to us.
// This stops ordinary websites you visit from posting to the server or reading designs.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function allowed(req) {
  const host = req.headers.host || "";
  if (!HOSTED && !LOCAL_HOST.test(host)) return false; // local server: also blocks DNS-rebinding
  const origin = req.headers.origin;
  if (!origin || origin === "null") return true; // Figma plugin (null) and Studio (none)
  if (HOSTED) return false; // a public server never needs to be called from a normal website
  try { return LOCAL_HOST.test(new URL(origin).host); } catch { return false; }
}

// Simple per-IP rate limits, only on a public server.
const hits = new Map(); // "bucket|ip" -> timestamps
function clientIp(req) { return (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?"; }
function count(req, bucket, windowMs) {
  const key = bucket + "|" + clientIp(req), now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  hits.set(key, list);
  return list;
}
function limited(req, bucket, max, windowMs, add = true) {
  if (!HOSTED) return false;
  const list = count(req, bucket, windowMs);
  if (list.length >= max) return true;
  if (add) list.push(Date.now());
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of hits) if (!l.some((t) => now - t < 3600e3)) hits.delete(k); }, 10 * 60 * 1000).unref();

const server = http.createServer((req, res) => {
  if (!allowed(req)) return send(res, 403, { error: "Forbidden origin" });
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // api, ...

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><meta charset=utf-8><title>FigBridge server</title><body style=\"font-family:sans-serif;padding:2rem\"><h1>FigBridge server is running</h1><p>Use the FigBridge plugins in Figma and Roblox Studio.</p>");
  }
  if (req.method === "GET" && url.pathname === "/api/ping") return send(res, 200, { ok: true, app: "figbridge" });

  if (req.method === "POST" && url.pathname === "/api/upload") {
    if (limited(req, "up", 30, 10 * 60 * 1000)) return send(res, 429, { error: "Too many uploads. Wait a few minutes and try again." });
    const chunks = [];
    let size = 0, tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; return; }
      if (!tooBig) chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return send(res, 413, { error: "Design too large (max " + (MAX_BODY >> 20) + " MB)" });
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, { error: "Invalid JSON" });
      }
      if (!payload || !payload.doc) return send(res, 400, { error: "Missing doc" });
      // live sync reuses one code ("channel") and bumps its version on every update
      const channel = typeof payload.channel === "string" && /^[A-Z0-9]{6}$/.test(payload.channel) ? payload.channel : null;
      const code = channel || newCode();
      const prev = store.get(code);
      const entry = { doc: payload.doc, images: payload.images || {}, created: Date.now(), bytes: size, version: ((prev && prev.version) || 0) + 1 };
      entry.ready = uploadAll(entry); // Studio waits for this before downloading
      entry.ready.then(() => { entry.readyVersion = entry.version; });
      store.set(code, entry);
      evictOldest();
      // Keep the latest design (without pixels) on disk to debug conversions.
      if (!HOSTED) try { fs.writeFileSync(path.join(__dirname, "last-upload.json"), JSON.stringify(payload.doc, null, 1)); } catch {}
      const kb = Math.round(Buffer.concat(chunks).length / 1024);
      console.log(`[upload] ${code} v${entry.version}  ${HOSTED ? "" : (payload.doc.name || "?") + "  "}${Object.keys(payload.images || {}).length} images  ${kb} KB`);
      send(res, 200, { code, version: entry.version });
    });
    return;
  }

  // GET /api/v/CODE -> { version } of the latest ready upload (cheap poll for live sync)
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "v" && parts[2]) {
    if (limited(req, "miss", 30, 60 * 1000, false)) return send(res, 429, { error: "Too many wrong codes. Wait a minute." });
    const entry = store.get(parts[2].toUpperCase());
    if (!entry) { limited(req, "miss", 30, 60 * 1000); return send(res, 404, { error: "Code not found or expired" }); }
    return send(res, 200, { version: entry.readyVersion || 0 });
  }

  // GET /api/c/CODE  -> doc + image list (without pixels)
  // GET /api/c/CODE/img/ID -> { w, h, data }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "c" && parts[2]) {
    if (limited(req, "miss", 30, 60 * 1000, false)) return send(res, 429, { error: "Too many wrong codes. Wait a minute." });
    const entry = store.get(parts[2].toUpperCase());
    if (!entry) { limited(req, "miss", 30, 60 * 1000); return send(res, 404, { error: "Code not found or expired" }); }
    if (parts[3] === "img" && parts[4]) {
      const img = entry.images[parts[4]];
      if (!img) return send(res, 404, { error: "Image not found" });
      return send(res, 200, img);
    }
    entry.ready.then(() => {
      const images = Object.entries(entry.images).map(([id, im]) => ({ id, w: im.w, h: im.h, decal: im.decal, uploadError: im.uploadError }));
      console.log(`[download] ${parts[2].toUpperCase()}`);
      send(res, 200, { doc: entry.doc, images, version: entry.version });
    });
    return;
  }

  send(res, 404, { error: "Not found" });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.log(`Port ${PORT} is already in use. Is another FigBridge window open? Close it, or set PORT to another number.`);
  else console.log("Server error: " + e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`FigBridge server running on port ${PORT} (${HOSTED ? "hosted mode" : "local mode, " + HOST})`));
