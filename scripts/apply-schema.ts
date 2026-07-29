import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { sql } from "../src/db/client";

/**
 * `npm run db:push` — apply db/schema.sql.
 *
 * The schema is idempotent (every object is IF NOT EXISTS or guarded), so this
 * doubles as the migration runner: edit the file, re-run, done. A single-user
 * app with one deploy target does not need a migration ledger, and pretending
 * otherwise would add a moving part with nothing to gain.
 */
async function main() {
  const path = join(process.cwd(), "db", "schema.sql");
  console.log(`applying ${path}…`);
  await sql.unsafe(readFileSync(path, "utf8"));
  console.log("✓ schema applied");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
