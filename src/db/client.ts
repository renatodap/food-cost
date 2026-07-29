import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

/**
 * The Persimmon shared Postgres is a dot-less Docker container name on the
 * internal network and speaks plaintext — forcing ssl:"require" there fails the
 * handshake with ECONNRESET. So TLS is opt-in by shape of the host, matching how
 * dap-finance and dap-fitness both decide it.
 */
const host = (() => {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return "";
  }
})();
const needsSsl = host.includes(".") && host !== "localhost" && !host.endsWith(".internal");

const globalForDb = globalThis as unknown as { _sql?: ReturnType<typeof postgres> };

export const sql =
  globalForDb._sql ??
  postgres(connectionString, {
    ssl: needsSsl ? "require" : false,
    max: 10,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") globalForDb._sql = sql;
