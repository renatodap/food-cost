import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { syncAll } from "../src/lib/sync";
import { sql } from "../src/db/client";

/** `npm run sync [days]` — pull both sides into the mirrors. */
async function main() {
  const days = Number(process.argv[2]) || 45;
  console.log(`syncing the last ${days} days…`);

  const results = await syncAll(days);
  for (const r of results) {
    if (r.error) console.error(`  ✗ ${r.source}: ${r.error}`);
    else console.log(`  ✓ ${r.source}: fetched ${r.fetched}, upserted ${r.upserted}`);
  }

  await sql.end();
  process.exit(results.some((r) => r.error) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
