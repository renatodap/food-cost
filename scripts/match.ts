import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { runMatcher } from "../src/lib/match";
import { sql } from "../src/db/client";

/** `npm run match [days]` — propose links over the mirrored data. */
async function main() {
  const days = Number(process.argv[2]) || 60;
  console.log(`matching over the last ${days} days…`);

  const r = await runMatcher(days);
  console.log(`  lots resolved to a food     ${r.lotsResolved}`);
  console.log(`  direct links auto-confirmed ${r.directConfirmed}`);
  console.log(`  direct links proposed       ${r.directProposed}`);
  console.log(`  pantry draws proposed       ${r.drawsProposed}`);
  console.log(`  entries with no lot to draw ${r.skippedNoCandidate}`);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
