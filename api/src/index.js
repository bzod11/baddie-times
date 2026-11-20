// Baddie Times short links API (api.baddietimes.com).
//
//   GET  /check/:name   -> { name, available, reason? }
//   GET  /papers/:name  -> { name, cfg, updatedAt }            (404 if unclaimed)
//   POST /papers        { name, cfg }            -> { name, editCode }   (409 if taken)
//   PUT  /papers/:name  { cfg, editCode }        -> { name, updatedAt }  (403 on wrong code)
//   DELETE /papers/:name   header X-Admin-Key    -> { deleted }          (owner cleanup)
//
// Names are unique (PRIMARY KEY), so two people can never hold the same one,
// even if they claim it in the same second. Edit codes are stored only as hashes.

const ALLOWED_ORIGINS = [
  "https://baddietimes.com",
  "https://www.baddietimes.com",
  "https://bzod11.github.io",
];
const RESERVED = new Set([
  "api", "admin", "about", "help", "faq", "contact", "privacy", "terms",
  "bank", "index", "www", "mail", "email", "static", "assets", "img", "images",
  "css", "js", "fonts", "cname", "readme", "robots", "sitemap", "favicon",
  "edit", "new", "create", "claim", "login", "logout", "signin", "signup", "settings",
  "customize", "customizer", "setup", "paper", "papers", "link", "links", "check",
  "baddie", "baddies", "baddietimes", "the-baddie-times", "thebaddietimes", "baddie-times",
  "ben", "maddie", "claude", "anthropic", "null", "undefined", "test", "404",
]);
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const CLAIMS_PER_DAY = 10;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS papers (
      name TEXT PRIMARY KEY, cfg TEXT NOT NULL, code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ip_hash TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS papers_ip_day ON papers (ip_hash, created_at)`),
  ]);
  schemaReady = true;
}

function cors(req) {
  const o = req.headers.get("Origin") || "";
  const ok = ALLOWED_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    "Access-Control-Allow-Origin": ok ? o : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(req, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(req) },
  });
}
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const c = [...r].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return c.slice(0, 4) + "-" + c.slice(4);
}
function normCode(c) {
  return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function nameProblem(name) {
  if (!NAME_RE.test(name)) return "Use 3 to 30 lowercase letters, numbers or hyphens, starting and ending with a letter or number.";
  if (RESERVED.has(name)) return "That name is reserved.";
  return null;
}
function cfgProblem(cfg) {
  if (typeof cfg !== "string" || !cfg.startsWith("#n=") || cfg.length > 1500) return "Invalid paper settings.";
  return null;
}
async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p).toLowerCase());
    try {
      await ensureSchema(env.DB);
      const now = new Date().toISOString();

      if (req.method === "GET" && parts[0] === "check" && parts.length === 2) {
        const name = parts[1];
        const bad = nameProblem(name);
        if (bad) return json(req, 200, { name, available: false, reason: bad });
        const row = await env.DB.prepare("SELECT 1 FROM papers WHERE name = ?").bind(name).first();
        return json(req, 200, row ? { name, available: false, reason: "That link is taken." } : { name, available: true });
      }

      if (parts[0] === "papers" && parts.length === 2 && req.method === "GET") {
        const row = await env.DB.prepare("SELECT name, cfg, updated_at FROM papers WHERE name = ?").bind(parts[1]).first();
        if (!row) return json(req, 404, { error: "not_found" });
        return json(req, 200, { name: row.name, cfg: row.cfg, updatedAt: row.updated_at });
      }

      if (parts[0] === "papers" && parts.length === 1 && req.method === "POST") {
        const b = await readBody(req);
        const name = String((b && b.name) || "").toLowerCase();
        const bad = nameProblem(name) || cfgProblem(b && b.cfg);
        if (bad) return json(req, 400, { error: "invalid", reason: bad });
        const ipHash = await sha256((req.headers.get("CF-Connecting-IP") || "local") + "|baddie");
        const since = new Date(Date.now() - 864e5).toISOString();
        const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM papers WHERE ip_hash = ? AND created_at > ?").bind(ipHash, since).first();
        if (n && n.n >= CLAIMS_PER_DAY) return json(req, 429, { error: "too_many", reason: "Too many new links today. Try again tomorrow." });
        const code = newCode();
        const res = await env.DB.prepare(
          "INSERT INTO papers (name, cfg, code_hash, created_at, updated_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING"
        ).bind(name, b.cfg, await sha256(normCode(code)), now, now, ipHash).run();
        if (!res.meta || res.meta.changes !== 1) return json(req, 409, { error: "taken", reason: "That link is taken." });
        return json(req, 201, { name, editCode: code });
      }

      if (parts[0] === "papers" && parts.length === 2 && req.method === "PUT") {
        const b = await readBody(req);
        const bad = cfgProblem(b && b.cfg);
        if (bad) return json(req, 400, { error: "invalid", reason: bad });
        const res = await env.DB.prepare("UPDATE papers SET cfg = ?, updated_at = ? WHERE name = ? AND code_hash = ?")
          .bind(b.cfg, now, parts[1], await sha256(normCode(b.editCode))).run();
        if (!res.meta || res.meta.changes !== 1) {
          const exists = await env.DB.prepare("SELECT 1 FROM papers WHERE name = ?").bind(parts[1]).first();
          return json(req, exists ? 403 : 404, { error: exists ? "wrong_code" : "not_found", reason: exists ? "That edit code doesn't match this link." : "No paper at this link." });
        }
        return json(req, 200, { name: parts[1], updatedAt: now });
      }

      if (parts[0] === "papers" && parts.length === 2 && req.method === "DELETE") {
        if (!env.ADMIN_KEY || req.headers.get("X-Admin-Key") !== env.ADMIN_KEY) return json(req, 403, { error: "forbidden" });
        const res = await env.DB.prepare("DELETE FROM papers WHERE name = ?").bind(parts[1]).run();
        return json(req, 200, { deleted: (res.meta && res.meta.changes) || 0 });
      }

      if (parts.length === 0) return json(req, 200, { ok: true, service: "baddie-links" });
      return json(req, 404, { error: "not_found" });
    } catch (e) {
      return json(req, 500, { error: "server_error" });
    }
  },
};
