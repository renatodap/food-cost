import { timingSafeEqual } from "crypto";

/** Shared-secret gate for /api/internal/* — the surface the MCP connector calls. */
const HEADER = "x-internal-secret";

export function internalSecretOk(req: Request): boolean {
  const expected = process.env.MCP_INTERNAL_SECRET ?? "";
  if (!expected) return false; // fail closed
  const got = req.headers.get(HEADER) ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
