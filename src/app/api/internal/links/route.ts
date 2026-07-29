import { NextResponse } from "next/server";
import { internalSecretOk, unauthorized } from "@/lib/internal-auth";
import { confirmLink, linkTransactionToMeal, rejectLink, setManualCost, unlink } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The single write surface for links, shared by the UI and the MCP connector.
 *
 * WHY THIS EXISTS RATHER THAN THE MCP TALKING TO POSTGRES DIRECTLY: confirming a
 * link is not one UPDATE. It settles the row, stamps `reviewed_at`, and teaches
 * `food_alias` — and rejecting teaches a *negative* alias, without which the
 * matcher re-proposes the same wrong pair forever. Two implementations of that
 * would drift, and the drift would be silent and only visible weeks later as a
 * queue that stopped converging. So there is one implementation, in
 * `src/lib/actions.ts`, and the connector reaches it through here.
 *
 * The MCP reads straight from Postgres (fast, and read-only can't drift). Only
 * writes come through this door.
 */
export async function POST(req: Request): Promise<Response> {
  if (!internalSecretOk(req)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const action = String(body.action ?? "");

  try {
    switch (action) {
      case "confirm": {
        const id = Number(body.link_id);
        if (!Number.isFinite(id)) return NextResponse.json({ error: "link_id must be a number" }, { status: 400 });
        await confirmLink(id);
        return NextResponse.json({ ok: true, action, link_id: id });
      }
      case "reject": {
        const id = Number(body.link_id);
        if (!Number.isFinite(id)) return NextResponse.json({ error: "link_id must be a number" }, { status: 400 });
        await rejectLink(id);
        return NextResponse.json({ ok: true, action, link_id: id });
      }
      case "unlink": {
        const id = Number(body.link_id);
        if (!Number.isFinite(id)) return NextResponse.json({ error: "link_id must be a number" }, { status: 400 });
        await unlink(id);
        return NextResponse.json({ ok: true, action, link_id: id });
      }
      case "link_transaction": {
        const mealId = Number(body.meal_id);
        const txId = String(body.transaction_id ?? "");
        if (!Number.isFinite(mealId) || !txId) {
          return NextResponse.json({ error: "meal_id and transaction_id are required" }, { status: 400 });
        }
        await linkTransactionToMeal(mealId, txId);
        return NextResponse.json({ ok: true, action, meal_id: mealId, transaction_id: txId });
      }
      case "manual_cost": {
        const mealId = Number(body.meal_id);
        const amount = Number(body.amount);
        if (!Number.isFinite(mealId) || !Number.isFinite(amount) || amount <= 0) {
          return NextResponse.json({ error: "meal_id and a positive amount are required" }, { status: 400 });
        }
        await setManualCost(mealId, amount, body.note ? String(body.note) : null);
        return NextResponse.json({ ok: true, action, meal_id: mealId, amount });
      }
      default:
        return NextResponse.json(
          { error: `Unknown action "${action}". Expected confirm, reject, unlink, link_transaction or manual_cost.` },
          { status: 400 }
        );
    }
  } catch (e) {
    console.error("[food-cost] link write failed:", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
