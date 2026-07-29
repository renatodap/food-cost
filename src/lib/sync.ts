import { sql } from "@/db/client";
import { fetchMeals, fetchReceipts, fetchTransactions } from "@/lib/federation";
import { isStockable, parseQuantity } from "@/lib/quantity";

/**
 * Pull source rows into the local mirrors.
 *
 * Sync is by DATE WINDOW rather than by a high-water mark, on purpose. A
 * watermark only sees inserts; meals get retimed, portions get corrected and
 * receipts get re-categorized days later, and a watermark would never notice.
 * Re-pulling a window and upserting is cheap here (hundreds of rows) and is
 * correct under edits, which a watermark is not.
 */

export interface SyncResult {
  source: "finance" | "fitness";
  fetched: number;
  upserted: number;
  error?: string;
}

/** Default look-back. Wide enough to catch late receipt entry and edits. */
export const DEFAULT_SYNC_DAYS = 45;

export function windowStart(days = DEFAULT_SYNC_DAYS): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function openRun(source: "finance" | "fitness", since: string, until?: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO sync_run (source, since_date, until_date)
    VALUES (${source}, ${since}::date, ${until ?? null}::date)
    RETURNING id
  `;
  return row.id;
}

async function closeRun(id: number, r: { fetched: number; upserted: number; error?: string }) {
  await sql`
    UPDATE sync_run
       SET status = ${r.error ? "error" : "ok"},
           rows_fetched = ${r.fetched},
           rows_upserted = ${r.upserted},
           error = ${r.error ?? null},
           finished_at = now()
     WHERE id = ${id}
  `;
}

/* -------------------------------------------------------------------------- */
/* fitness → meals                                                             */
/* -------------------------------------------------------------------------- */

export async function syncMeals(since: string, until?: string): Promise<SyncResult> {
  const runId = await openRun("fitness", since, until);
  try {
    const { meals } = await fetchMeals(since, until);
    let upserted = 0;

    for (const m of meals) {
      await sql`
        INSERT INTO mirror_meal (id, meal_date, meal_time, meal_type, meal_type_slug, note, photo_urls, source, created_at, synced_at)
        VALUES (${m.id}, ${m.meal_date}::date, ${m.meal_time}::time, ${m.meal_type}, ${m.meal_type_slug},
                ${m.note}, ${m.photo_urls}, ${m.source}, ${m.created_at}::timestamptz, now())
        ON CONFLICT (id) DO UPDATE SET
          meal_date = EXCLUDED.meal_date, meal_time = EXCLUDED.meal_time,
          meal_type = EXCLUDED.meal_type, meal_type_slug = EXCLUDED.meal_type_slug,
          note = EXCLUDED.note, photo_urls = EXCLUDED.photo_urls, synced_at = now()
      `;

      for (const e of m.entries) {
        await sql`
          INSERT INTO mirror_meal_entry
            (id, meal_id, food_id, food_name, brand, restaurant, quantity_g,
             energy_kcal, protein_g, carbs_g, fat_g, order_index, entry_time, synced_at)
          VALUES (${e.id}, ${m.id}, ${e.food_id}, ${e.food_name}, ${e.brand}, ${e.restaurant}, ${e.quantity_g},
                  ${e.energy_kcal}, ${e.protein_g}, ${e.carbs_g}, ${e.fat_g}, ${e.order_index}, ${e.entry_time}::time, now())
          ON CONFLICT (id) DO UPDATE SET
            meal_id = EXCLUDED.meal_id, food_id = EXCLUDED.food_id, food_name = EXCLUDED.food_name,
            brand = EXCLUDED.brand, restaurant = EXCLUDED.restaurant, quantity_g = EXCLUDED.quantity_g,
            energy_kcal = EXCLUDED.energy_kcal, protein_g = EXCLUDED.protein_g,
            carbs_g = EXCLUDED.carbs_g, fat_g = EXCLUDED.fat_g,
            order_index = EXCLUDED.order_index, entry_time = EXCLUDED.entry_time, synced_at = now()
        `;
        upserted++;

        if (e.food_id != null) {
          await sql`
            INSERT INTO mirror_food_item (id, name, brand, restaurant, food_category, is_beverage, is_recipe, serving_g, synced_at)
            VALUES (${e.food_id}, ${e.food_name}, ${e.brand}, ${e.restaurant}, ${e.food_category},
                    ${e.is_beverage}, ${e.is_recipe}, ${e.serving_g}, now())
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name, brand = EXCLUDED.brand, restaurant = EXCLUDED.restaurant,
              food_category = EXCLUDED.food_category, is_beverage = EXCLUDED.is_beverage,
              is_recipe = EXCLUDED.is_recipe, serving_g = EXCLUDED.serving_g, synced_at = now()
          `;
        }
      }
      upserted++;
    }

    // A meal entry deleted upstream must disappear here, or it stays forever as
    // an unattributable row nagging in the review queue.
    const ids = meals.map((m) => m.id);
    if (ids.length) {
      await sql`
        DELETE FROM mirror_meal_entry
         WHERE meal_id = ANY(${ids}::bigint[])
           AND id <> ALL(${meals.flatMap((m) => m.entries.map((e) => e.id))}::bigint[])
      `;
    }

    await closeRun(runId, { fetched: meals.length, upserted });
    return { source: "fitness", fetched: meals.length, upserted };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await closeRun(runId, { fetched: 0, upserted: 0, error });
    return { source: "fitness", fetched: 0, upserted: 0, error };
  }
}

/* -------------------------------------------------------------------------- */
/* finance → transactions, receipts, pantry lots                               */
/* -------------------------------------------------------------------------- */

export async function syncFinance(since: string, until?: string): Promise<SyncResult> {
  const runId = await openRun("finance", since, until);
  try {
    const { transactions } = await fetchTransactions(since, until);
    let upserted = 0;

    for (const t of transactions) {
      await sql`
        INSERT INTO mirror_transaction
          (id, posted_date, amount, currency, merchant, description, kind,
           account_name, category_name, category_slug, is_food, is_split, has_receipt, reviewed, synced_at)
        VALUES (${t.id}::uuid, ${t.posted_date}::date, ${t.food_amount ?? t.amount}, ${t.currency},
                ${t.merchant}, ${t.description}, ${t.kind}, ${t.account}, ${t.category}, ${t.category_slug},
                TRUE, ${t.is_split}, ${t.has_receipt}, ${t.reviewed}, now())
        ON CONFLICT (id) DO UPDATE SET
          posted_date = EXCLUDED.posted_date, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
          merchant = EXCLUDED.merchant, description = EXCLUDED.description, kind = EXCLUDED.kind,
          account_name = EXCLUDED.account_name, category_name = EXCLUDED.category_name,
          category_slug = EXCLUDED.category_slug, is_split = EXCLUDED.is_split,
          has_receipt = EXCLUDED.has_receipt, reviewed = EXCLUDED.reviewed, synced_at = now()
      `;
      upserted++;
    }

    const { receipts } = await fetchReceipts(since, until);
    // Which transaction a receipt belongs to decides how its lines are treated:
    // groceries become stock to draw from, a restaurant bill does not.
    const categoryOf = new Map(transactions.map((t) => [t.id, t.category_slug]));

    for (const r of receipts) {
      // A receipt whose transaction we didn't mirror (not food) would violate
      // the FK; drop the link rather than the receipt.
      const txId = r.transaction_id && categoryOf.has(r.transaction_id) ? r.transaction_id : null;

      await sql`
        INSERT INTO mirror_receipt
          (id, transaction_id, store, purchased_on, purchased_at, subtotal, tax, tip, total, currency, status, synced_at)
        VALUES (${r.id}::uuid, ${txId}::uuid, ${r.store}, ${r.purchased_on}::date, ${r.purchased_at}::timestamptz,
                ${r.subtotal}, ${r.tax}, ${r.tip}, ${r.total}, ${r.currency}, ${r.status}, now())
        ON CONFLICT (id) DO UPDATE SET
          transaction_id = EXCLUDED.transaction_id, store = EXCLUDED.store,
          purchased_on = EXCLUDED.purchased_on, purchased_at = EXCLUDED.purchased_at,
          subtotal = EXCLUDED.subtotal, tax = EXCLUDED.tax, tip = EXCLUDED.tip,
          total = EXCLUDED.total, currency = EXCLUDED.currency, status = EXCLUDED.status, synced_at = now()
      `;
      upserted++;

      const isGrocery = txId ? categoryOf.get(txId) === "groceries" : false;

      for (const it of r.items) {
        await sql`
          INSERT INTO mirror_receipt_item
            (id, receipt_id, name, raw_name, quantity, unit_price, amount, category_name, food_tags, sort_order, synced_at)
          VALUES (${it.id}::uuid, ${r.id}::uuid, ${it.name}, ${it.raw_name}, ${it.quantity},
                  ${it.unit_price}, ${it.amount}, ${it.category}, ${it.food_tags}, ${it.sort_order}, now())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, raw_name = EXCLUDED.raw_name, quantity = EXCLUDED.quantity,
            unit_price = EXCLUDED.unit_price, amount = EXCLUDED.amount,
            category_name = EXCLUDED.category_name, food_tags = EXCLUDED.food_tags,
            sort_order = EXCLUDED.sort_order, synced_at = now()
        `;
        upserted++;

        // Only groceries become stock. You do not draw grams from a restaurant
        // bill — that meal is costed whole, by its transaction.
        if (!isGrocery) continue;
        if (!isStockable(it.name, it.raw_name, it.food_tags)) continue;
        if (it.amount <= 0) continue; // discounts and returns aren't stock

        const q = parseQuantity(it.raw_name ?? it.name, it.quantity);
        const purchasedOn = r.purchased_on ?? new Date().toISOString().slice(0, 10);

        await sql`
          INSERT INTO pantry_lot
            (receipt_item_id, label, purchased_on, basis, qty_total_g, qty_total_units, total_cost, currency, note)
          VALUES (${it.id}::uuid, ${it.name}, ${purchasedOn}::date, ${q.basis},
                  ${q.basis === "mass" ? (q.grams ?? null) : null}, ${q.basis === "unit" ? (q.units ?? null) : null},
                  ${Math.abs(it.amount)}, ${r.currency}, ${q.matched ? `parsed "${q.matched}"` : "no printed quantity — unit basis"})
          ON CONFLICT (receipt_item_id) DO UPDATE SET
            label = EXCLUDED.label, purchased_on = EXCLUDED.purchased_on, basis = EXCLUDED.basis,
            qty_total_g = EXCLUDED.qty_total_g, qty_total_units = EXCLUDED.qty_total_units,
            total_cost = EXCLUDED.total_cost, currency = EXCLUDED.currency, note = EXCLUDED.note
        `;
      }
    }

    const fetched = transactions.length + receipts.length;
    await closeRun(runId, { fetched, upserted });
    return { source: "finance", fetched, upserted };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await closeRun(runId, { fetched: 0, upserted: 0, error });
    return { source: "finance", fetched: 0, upserted: 0, error };
  }
}

export async function syncAll(days = DEFAULT_SYNC_DAYS): Promise<SyncResult[]> {
  const since = windowStart(days);
  // Sequential, not parallel: finance rows are the FK targets that meals'
  // candidate links will point at, and a half-populated mirror produces
  // candidates that reference nothing.
  const finance = await syncFinance(since);
  const fitness = await syncMeals(since);
  return [finance, fitness];
}
