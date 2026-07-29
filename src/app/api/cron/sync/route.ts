import { NextResponse } from "next/server";
import { runMatcher } from "@/lib/match";
import { DEFAULT_SYNC_DAYS, syncAll } from "@/lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Pulling ~45 days of both sides and running the matcher takes longer than the
// default budget on a cold container.
export const maxDuration = 120;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  // No secret configured: allow outside production only, for local runs.
  return process.env.NODE_ENV !== "production";
}

/**
 * Pull both sides, then propose links.
 *
 *   POST /api/cron/sync            → 45-day window
 *   POST /api/cron/sync?days=180   → wider backfill
 *   POST /api/cron/sync?match=0    → mirror only, don't propose
 *
 * Sync errors are reported per-source rather than thrown: if dap-finance is down
 * and dap-fitness isn't, mirroring the half that works is strictly better than
 * mirroring neither, and `sync_run` records what happened either way.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized or CRON_SECRET not configured" }, { status: 401 });
  }

  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || DEFAULT_SYNC_DAYS, 1), 730);
  const shouldMatch = url.searchParams.get("match") !== "0";

  const synced = await syncAll(days);
  const failed = synced.filter((s) => s.error);

  // Matching against a half-populated mirror would propose links to rows that
  // aren't there yet, so it is skipped when either side failed.
  const matched = shouldMatch && failed.length === 0 ? await runMatcher(Math.max(days, 60)) : null;

  return NextResponse.json(
    { days, synced, matched, skipped_match: shouldMatch && failed.length > 0 },
    { status: failed.length ? 207 : 200 }
  );
}
