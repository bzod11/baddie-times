var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var ALLOWED_ORIGINS = [
  "https://baddietimes.com",
  "https://www.baddietimes.com",
  "https://bzod11.github.io"
];
var RESERVED = /* @__PURE__ */ new Set([
  "api",
  "admin",
  "about",
  "help",
  "faq",
  "contact",
  "privacy",
  "terms",
  "bank",
  "index",
  "www",
  "mail",
  "email",
  "static",
  "assets",
  "img",
  "images",
  "css",
  "js",
  "fonts",
  "cname",
  "readme",
  "robots",
  "sitemap",
  "favicon",
  "edit",
  "new",
  "create",
  "claim",
  "login",
  "logout",
  "signin",
  "signup",
  "settings",
  "customize",
  "customizer",
  "setup",
  "paper",
  "papers",
  "link",
  "links",
  "check",
  "baddie",
  "baddies",
  "baddietimes",
  "the-baddie-times",
  "thebaddietimes",
  "baddie-times",
  "ben",
  "maddie",
  "claude",
  "anthropic",
  "null",
  "undefined",
  "test",
  "404"
]);
var NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
var CLAIMS_PER_DAY = 10;
var CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
var schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS papers (
      name TEXT PRIMARY KEY, cfg TEXT NOT NULL, code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ip_hash TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS papers_ip_day ON papers (ip_hash, created_at)`)
  ]);
  schemaReady = true;
}
__name(ensureSchema, "ensureSchema");
function cors(req) {
  const o = req.headers.get("Origin") || "";
  const ok = ALLOWED_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    "Access-Control-Allow-Origin": ok ? o : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
__name(cors, "cors");
function json(req, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(req) }
  });
}
__name(json, "json");
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const c = [...r].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return c.slice(0, 4) + "-" + c.slice(4);
}
__name(newCode, "newCode");
function normCode(c) {
  return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
__name(normCode, "normCode");
function nameProblem(name) {
  if (!NAME_RE.test(name)) return "Use 3 to 30 lowercase letters, numbers or hyphens, starting and ending with a letter or number.";
  if (RESERVED.has(name)) return "That name is reserved.";
  return null;
}
__name(nameProblem, "nameProblem");
function cfgProblem(cfg) {
  if (typeof cfg !== "string" || !cfg.startsWith("#n=") || cfg.length > 1500) return "Invalid paper settings.";
  return null;
}
__name(cfgProblem, "cfgProblem");
async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
__name(readBody, "readBody");
var src_default = {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p).toLowerCase());
    try {
      await ensureSchema(env.DB);
      const now = (/* @__PURE__ */ new Date()).toISOString();
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
        const name = String(b && b.name || "").toLowerCase();
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
        const res = await env.DB.prepare("UPDATE papers SET cfg = ?, updated_at = ? WHERE name = ? AND code_hash = ?").bind(b.cfg, now, parts[1], await sha256(normCode(b.editCode))).run();
        if (!res.meta || res.meta.changes !== 1) {
          const exists = await env.DB.prepare("SELECT 1 FROM papers WHERE name = ?").bind(parts[1]).first();
          return json(req, exists ? 403 : 404, { error: exists ? "wrong_code" : "not_found", reason: exists ? "That edit code doesn't match this link." : "No paper at this link." });
        }
        return json(req, 200, { name: parts[1], updatedAt: now });
      }
      if (parts[0] === "papers" && parts.length === 2 && req.method === "DELETE") {
        if (!env.ADMIN_KEY || req.headers.get("X-Admin-Key") !== env.ADMIN_KEY) return json(req, 403, { error: "forbidden" });
        const res = await env.DB.prepare("DELETE FROM papers WHERE name = ?").bind(parts[1]).run();
        return json(req, 200, { deleted: res.meta && res.meta.changes || 0 });
      }
      if (parts.length === 0) return json(req, 200, { ok: true, service: "baddie-links" });
      return json(req, 404, { error: "not_found" });
    } catch (e) {
      return json(req, 500, { error: "server_error" });
    }
  }
};

// ../../../../tmp/claude-0/-home-claude/0994df58-38a9-56e1-a8e0-8002987a268f/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../tmp/claude-0/-home-claude/0994df58-38a9-56e1-a8e0-8002987a268f/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-8O3NJE/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../tmp/claude-0/-home-claude/0994df58-38a9-56e1-a8e0-8002987a268f/scratchpad/wr/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-8O3NJE/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
