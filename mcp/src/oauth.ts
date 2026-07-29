/**
 * Minimal OAuth 2.1 authorization server for the Claude custom-connector flow.
 * Public client + PKCE (S256), dynamic client registration, single-passphrase
 * consent, long-lived bearer. State (clients/codes/tokens) lives in the same
 * Postgres so it survives restarts. This is the smallest thing the Claude app's
 * connector flow will actually complete against.
 */
import { randomBytes, createHash } from "node:crypto";
import { sql } from "./db.js";

const PASSPHRASE = process.env.MCP_PASSPHRASE || "";
const b64url = (b: Buffer) => b.toString("base64url");
const token = () => b64url(randomBytes(32));

export async function ensureOAuthTables(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS mcp_oauth_client (
    client_id text PRIMARY KEY, redirect_uris text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS mcp_oauth_code (
    code text PRIMARY KEY, client_id text, redirect_uri text, code_challenge text,
    created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS mcp_oauth_token (
    token text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`;
}

/** Authorization-server metadata (/.well-known/oauth-authorization-server). */
export function asMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

/** Protected-resource metadata (/.well-known/oauth-protected-resource). */
export function resourceMetadata(issuer: string) {
  return { resource: `${issuer}/mcp`, authorization_servers: [issuer] };
}

/** Dynamic client registration — accept anyone (single-user), issue a client_id. */
export async function registerClient(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const clientId = `dapfc-${token().slice(0, 24)}`;
  const uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]).filter((u) => typeof u === "string") : [];
  await sql`INSERT INTO mcp_oauth_client (client_id, redirect_uris) VALUES (${clientId}, ${uris})`;
  return {
    client_id: clientId,
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}

/** The consent page (GET /oauth/authorize). One passphrase field; posts back here. */
export function authorizePage(q: URLSearchParams, error?: string): string {
  const carry = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "response_type"]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q.get(k) ?? "")}">`).join("");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Food Cost</title><style>
body{font-family:system-ui;margin:0;background:#0f0f10;color:#eee;display:grid;place-items:center;min-height:100vh}
form{background:#1a1a1c;padding:28px;border-radius:16px;width:min(360px,90vw);box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{font-size:18px;margin:0 0 4px} p{color:#999;font-size:13px;margin:0 0 18px}
input[type=password]{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #333;background:#111;color:#eee;font-size:16px}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:#e0552b;color:#fff;font-size:16px;font-weight:600}
.err{color:#ff7a6b;font-size:13px;margin-top:10px}</style></head>
<body><form method="POST" action="/oauth/authorize">
<h1>Connect Food Cost</h1><p>Enter your connector passphrase to let Claude reconcile meals against spending.</p>
${carry}<input type="password" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password">
<button type="submit">Connect</button>${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
</form></body></html>`;
}

/** Validate the passphrase, mint a code bound to the PKCE challenge + redirect_uri.
 *  Returns the redirect URL to send the browser to, or null on bad passphrase. */
export async function authorizeSubmit(form: URLSearchParams): Promise<string | null> {
  if (!PASSPHRASE || form.get("passphrase") !== PASSPHRASE) return null;
  const redirectUri = form.get("redirect_uri") || "";
  const code = token();
  await sql`INSERT INTO mcp_oauth_code (code, client_id, redirect_uri, code_challenge)
    VALUES (${code}, ${form.get("client_id")}, ${redirectUri}, ${form.get("code_challenge")})`;
  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  if (form.get("state")) u.searchParams.set("state", form.get("state")!);
  return u.toString();
}

/** Exchange an auth code (+ PKCE verifier) for a long-lived bearer. */
export async function tokenExchange(form: URLSearchParams): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  if (form.get("grant_type") !== "authorization_code") return { ok: false, error: "unsupported_grant_type" };
  const code = form.get("code") || "";
  const verifier = form.get("code_verifier") || "";
  const rows = await sql<{ code_challenge: string | null; redirect_uri: string | null }[]>`
    SELECT code_challenge, redirect_uri FROM mcp_oauth_code WHERE code=${code}
      AND created_at > now() - interval '10 minutes'`;
  if (!rows[0]) return { ok: false, error: "invalid_grant" };
  const challenge = rows[0].code_challenge;
  if (challenge) {
    const computed = b64url(createHash("sha256").update(verifier).digest());
    if (computed !== challenge) return { ok: false, error: "invalid_grant" };
  }
  await sql`DELETE FROM mcp_oauth_code WHERE code=${code}`; // one-time use
  const access = token();
  await sql`INSERT INTO mcp_oauth_token (token) VALUES (${access})`;
  return { ok: true, body: { access_token: access, token_type: "Bearer", scope: "mcp" } };
}

/** True if the bearer token is one we issued. */
export async function verifyToken(bearer: string | null): Promise<boolean> {
  if (!bearer) return false;
  const t = bearer.replace(/^Bearer\s+/i, "").trim();
  if (!t) return false;
  const rows = await sql<{ n: number }[]>`SELECT 1 AS n FROM mcp_oauth_token WHERE token=${t} LIMIT 1`;
  return rows.length > 0;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
