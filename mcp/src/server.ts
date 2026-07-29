/**
 * HTTP entrypoint for the food-cost MCP connector (stateless Streamable HTTP).
 * Routes: OAuth discovery + register/authorize/token, and POST /mcp (bearer-gated).
 * Behind Coolify's Traefik (TLS terminated), so we trust X-Forwarded-* for the issuer.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleRpc } from "./rpc.js";
import { ensureSchemaReady } from "./db.js";
import {
  ensureOAuthTables, asMetadata, resourceMetadata, registerClient,
  authorizePage, authorizeSubmit, tokenExchange, verifyToken,
} from "./oauth.js";

const PORT = Number(process.env.PORT || 3000);

function issuerOf(req: IncomingMessage): string {
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  return `${proto}://${host}`;
}
function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
}
function json(res: ServerResponse, status: number, body: unknown) {
  cors(res); res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
}
function html(res: ServerResponse, status: number, body: string) {
  cors(res); res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }); res.end(body);
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", (c) => { d += c; if (d.length > 20 * 1024 * 1024) req.destroy(); });
    req.on("end", () => resolve(d)); req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", issuerOf(req));
    const path = url.pathname;
    if (method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }
    const issuer = issuerOf(req);

    // ---- Discovery ----
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      return json(res, 200, asMetadata(issuer));
    }
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, resourceMetadata(issuer));
    }

    // ---- OAuth ----
    if (path === "/oauth/register" && method === "POST") {
      const body = await readBody(req);
      let parsed: Record<string, unknown> = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* tolerate */ }
      return json(res, 201, await registerClient(parsed));
    }
    if (path === "/oauth/authorize" && method === "GET") {
      return html(res, 200, authorizePage(url.searchParams));
    }
    if (path === "/oauth/authorize" && method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const redirect = await authorizeSubmit(form);
      if (!redirect) return html(res, 401, authorizePage(form, "Wrong passphrase — try again."));
      cors(res); res.writeHead(302, { Location: redirect }); res.end(); return;
    }
    if (path === "/oauth/token" && method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const r = await tokenExchange(form);
      return r.ok ? json(res, 200, r.body) : json(res, 400, { error: r.error });
    }

    // ---- MCP ----
    if (path === "/mcp") {
      if (method === "GET") { cors(res); res.writeHead(405).end(); return; } // no SSE; POST only
      if (method !== "POST") { cors(res); res.writeHead(405).end(); return; }
      if (!(await verifyToken(req.headers.authorization ?? null))) {
        cors(res);
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      const raw = await readBody(req);
      let msg: unknown;
      try { msg = JSON.parse(raw); } catch { return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      // Batch or single.
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map((m) => handleRpc(m as Record<string, unknown>)))).filter(Boolean);
        if (out.length === 0) { cors(res); res.writeHead(202).end(); return; }
        return json(res, 200, out);
      }
      const out = await handleRpc(msg as Record<string, unknown>);
      if (out === null) { cors(res); res.writeHead(202).end(); return; } // notification
      return json(res, 200, out);
    }

    if (path === "/healthz") return json(res, 200, { ok: true });
    if (path === "/") return html(res, 200, "<h1>Food Cost MCP</h1><p>Add this URL as a custom connector in Claude.</p>");
    return json(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("[food-cost-mcp] unhandled:", e);
    json(res, 500, { error: "server_error" });
  }
});

Promise.all([ensureOAuthTables(), ensureSchemaReady()])
  .then(() => server.listen(PORT, () => console.log(`[food-cost-mcp] listening on :${PORT}`)))
  .catch((e) => { console.error("[food-cost-mcp] startup failed:", e); process.exit(1); });
