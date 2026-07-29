/**
 * DB layer for the food-cost MCP connector.
 *
 * READS come straight from Postgres — fast, and a read cannot drift from the
 * app's semantics. WRITES do not happen here at all: they go through the web
 * app's `/api/internal/links` endpoint (see api.ts), because confirming a link
 * also teaches the alias table, and two implementations of that would diverge
 * silently. One writer, many readers.
 */
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const host = (() => {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return "";
  }
})();
// The Coolify Postgres is a dot-less Docker container name speaking plaintext;
// forcing TLS there fails the handshake with ECONNRESET.
const needsSsl = host.includes(".") && host !== "localhost" && !host.endsWith(".internal");

export const sql = postgres(connectionString, {
  ssl: needsSsl ? "require" : false,
  max: 5,
  prepare: false,
});

/**
 * Separate pool for model-authored SQL (`run_sql`).
 *
 * When READONLY_DATABASE_URL points at a SELECT-only role, read-only becomes a
 * property of the CREDENTIAL rather than of one call site — the prefix check,
 * the keyword scan and the READ ONLY transaction all become defence in depth on
 * top of a role that could not write even if every one of them were bypassed.
 * Falls back to the main pool when unset, keeping the wrapper-only guarantee.
 */
const readonlyUrl = process.env.READONLY_DATABASE_URL;
export const readOnlySql = readonlyUrl
  ? postgres(readonlyUrl, {
      ssl: (() => {
        const h = (() => {
          try {
            return new URL(readonlyUrl).hostname;
          } catch {
            return "";
          }
        })();
        return h.includes(".") && h !== "localhost" && !h.endsWith(".internal") ? ("require" as const) : false;
      })(),
      max: 3,
      prepare: false,
    })
  : sql;

export const hasReadOnlyRole = Boolean(readonlyUrl);

/**
 * Fail fast at boot if the schema isn't there.
 *
 * The connector is deployed separately from the web app, so it is entirely
 * possible to start it against an empty database. Discovering that on the first
 * tool call — as a confusing "relation does not exist" inside a model's
 * reasoning — is much worse than refusing to start.
 */
export async function ensureSchemaReady(): Promise<void> {
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT to_regclass('public.cost_link') IS NOT NULL AS ok
  `;
  if (!row?.ok) {
    throw new Error("food_cost schema is missing — apply db/schema.sql before starting the connector");
  }
}
