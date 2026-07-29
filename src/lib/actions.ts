"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/db/client";

/**
 * The write surface. Everything a human decides goes through here.
 *
 * The invariant that matters: `reviewed_at` is set ONLY in this file, and only
 * by a function a person triggered. The matcher may reach `status='confirmed'`
 * on an unambiguous match, but it never claims the match was reviewed. That
 * distinction is what makes "68% coverage" mean something — it separates
 * "a machine is fairly sure" from "I looked at it and it's right".
 */

function revalidateAll() {
  for (const p of ["/", "/review", "/meals", "/spend", "/pantry"]) revalidatePath(p);
}

/**
 * Accept a proposed link.
 *
 * Confirming also teaches `food_alias`, which is what stops the same fuzzy
 * decision being re-made next week. A confirmed pantry draw says "this printed
 * receipt text IS this food" — a labelled example, and the reason the review
 * queue gets quieter over time rather than staying the same size forever.
 */
export async function confirmLink(id: number): Promise<void> {
  const [link] = await sql<{ pantry_lot_id: number | null; meal_entry_id: number | null }[]>`
    UPDATE cost_link
       SET status = 'confirmed', reviewed_at = now(), origin = 'user'
     WHERE id = ${id} AND status = 'proposed'
    RETURNING pantry_lot_id, meal_entry_id
  `;
  if (!link) return;

  if (link.pantry_lot_id != null && link.meal_entry_id != null) {
    await sql`
      INSERT INTO food_alias (normalized_text, food_id, food_name, origin, hits)
      SELECT normalize_food_text(l.label), e.food_id, e.food_name, 'user', 1
        FROM pantry_lot l
        JOIN mirror_meal_entry e ON e.id = ${link.meal_entry_id}
       WHERE l.id = ${link.pantry_lot_id}
         AND e.food_id IS NOT NULL
         AND normalize_food_text(l.label) IS NOT NULL
      ON CONFLICT (normalized_text, coalesce(food_id, -1), is_negative)
      DO UPDATE SET hits = food_alias.hits + 1, origin = 'user', updated_at = now()
    `;
  }
  revalidateAll();
}

/**
 * Reject a proposed link.
 *
 * A rejection is kept, not deleted — it is a negative label. Without it the
 * matcher would cheerfully re-propose the same wrong pair on the next run, and
 * the queue would never converge.
 */
export async function rejectLink(id: number): Promise<void> {
  const [link] = await sql<{ pantry_lot_id: number | null; meal_entry_id: number | null }[]>`
    UPDATE cost_link
       SET status = 'rejected', reviewed_at = now(), origin = 'user'
     WHERE id = ${id} AND status IN ('proposed', 'confirmed')
    RETURNING pantry_lot_id, meal_entry_id
  `;
  if (!link) return;

  if (link.pantry_lot_id != null && link.meal_entry_id != null) {
    await sql`
      INSERT INTO food_alias (normalized_text, food_id, food_name, origin, is_negative, hits)
      SELECT normalize_food_text(l.label), e.food_id, e.food_name, 'user', TRUE, 1
        FROM pantry_lot l
        JOIN mirror_meal_entry e ON e.id = ${link.meal_entry_id}
       WHERE l.id = ${link.pantry_lot_id}
         AND e.food_id IS NOT NULL
         AND normalize_food_text(l.label) IS NOT NULL
      ON CONFLICT (normalized_text, coalesce(food_id, -1), is_negative)
      DO UPDATE SET hits = food_alias.hits + 1, updated_at = now()
    `;
  }
  revalidateAll();
}

/** Accept every proposal at or above a confidence bar, in one go. */
export async function confirmAllAbove(threshold: number): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM cost_link WHERE status = 'proposed' AND confidence >= ${threshold}
  `;
  for (const r of rows) await confirmLink(r.id);
  return rows.length;
}

/**
 * Attach a whole charge to a whole meal by hand — the "I know what this was"
 * path when the matcher couldn't work it out.
 */
export async function linkTransactionToMeal(mealId: number, transactionId: string): Promise<void> {
  await sql`
    INSERT INTO cost_link
      (meal_id, method, transaction_id, allocated_amount, currency, status, origin, reviewed_at, evidence)
    SELECT ${mealId}, 'direct_transaction', t.id, ABS(t.amount), t.currency, 'confirmed', 'user', now(),
           jsonb_build_object('rule', 'manual/v1', 'merchant', t.merchant)
      FROM mirror_transaction t
     WHERE t.id = ${transactionId}::uuid
    ON CONFLICT DO NOTHING
  `;
  revalidateAll();
}

/** Undo a link entirely. Used when a manual link turns out to be the wrong meal. */
export async function unlink(id: number): Promise<void> {
  await sql`UPDATE cost_link SET status = 'superseded', reviewed_at = now() WHERE id = ${id}`;
  revalidateAll();
}

/**
 * Cost a meal by hand when there is genuinely no row to point at — cash at a
 * market stall, a meal someone else paid for and you reimbursed.
 *
 * `manual_amount` is the only method with no source FK, which is why the schema
 * makes that an explicit case rather than allowing any link to dangle.
 */
export async function setManualCost(mealId: number, amount: number, note: string | null): Promise<void> {
  await sql`
    INSERT INTO cost_link
      (meal_id, method, allocated_amount, currency, status, origin, reviewed_at, note, evidence)
    VALUES (${mealId}, 'manual_amount', ${amount}, 'USD', 'confirmed', 'user', now(), ${note},
            '{"rule":"manual_amount/v1"}'::jsonb)
  `;
  revalidateAll();
}
