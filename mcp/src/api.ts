/**
 * Thin client over the food-cost web app's internal write surface.
 *
 * Every mutation the connector performs goes through here rather than through
 * SQL, so the alias-teaching that rides along with a confirm/reject has exactly
 * one implementation. See src/app/api/internal/links/route.ts.
 */

const base = () => {
  const b = process.env.FOOD_COST_APP_URL;
  if (!b) throw new Error("FOOD_COST_APP_URL is not set");
  return b.replace(/\/$/, "");
};

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) throw new Error("MCP_INTERNAL_SECRET is not set");

  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": secret },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* fall through to the status-based error below */
  }
  if (!res.ok) {
    throw new Error(String(parsed.error ?? `app responded ${res.status}`));
  }
  return parsed;
}

export function linkAction(body: Record<string, unknown>) {
  return post("/api/internal/links", body);
}

/**
 * Trigger a sync + match run.
 *
 * Guarded by CRON_SECRET rather than the internal secret because it is the same
 * endpoint the scheduler hits — one job, one door.
 */
export async function triggerSync(days: number, match: boolean): Promise<Record<string, unknown>> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not set");
  const url = `${base()}/api/cron/sync?days=${days}${match ? "" : "&match=0"}`;
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`sync endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }
}
