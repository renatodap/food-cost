import { sql } from "@/db/client";

/**
 * The matcher.
 *
 * Two mechanisms, because they are two different problems (docs/RESEARCH.md §1
 * and §3):
 *
 *   DIRECT  — one restaurant meal ≈ one card charge. Record linkage, scored on
 *             date proximity, merchant↔restaurant similarity, and how uniquely
 *             the pair picks each other out.
 *   PANTRY  — one grocery line feeds N meals over M days. FIFO depletion: a meal
 *             entry draws grams from the oldest open lot of that food.
 *
 * Everything the matcher writes is `origin='auto'` and `reviewed_at IS NULL`.
 * The machine may reach `status='confirmed'` on an unambiguous match, but it
 * NEVER claims a human reviewed it — that column belongs to the person, exactly
 * as in dap-finance. The UI renders the two states differently.
 *
 * The matcher must also be able to ABSTAIN. Anything below PROPOSE_FLOOR is not
 * written at all: a review queue full of 0.2-confidence noise is worse than an
 * empty one, because it trains you to click through without looking.
 */

/** Thresholds are config, not constants — tune them against real review outcomes. */
export const AUTO_CONFIRM = 0.9;
export const PROPOSE_FLOOR = 0.45;

/** Beyond this, "I bought it then, I ate it now" stops being credible. */
export const MAX_PANTRY_AGE_DAYS = 90;
/** Past this, still plausible but discounted — most fresh food is gone by now. */
export const PANTRY_FRESH_DAYS = 30;

export interface MatchReport {
  directProposed: number;
  directConfirmed: number;
  lotsResolved: number;
  drawsProposed: number;
  skippedNoCandidate: number;
}

/* ========================================================================== */
/* 1. Resolve pantry lots to foods                                            */
/* ========================================================================== */

/**
 * Give each unresolved lot a `food_id`, so meals can draw from it.
 *
 * The candidate set is `mirror_food_item` — which, by construction, only holds
 * foods that have actually appeared in a meal. That is a far stronger prior than
 * the 406k-row upstream library: we are asking "which of the things he eats is
 * this receipt line", not "which of every food on earth".
 *
 * Aliases are checked first and win outright. Every confirmation teaches one, so
 * the common basket stops being a fuzzy-match problem after a few weeks.
 */
export async function resolveLotFoods(): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    WITH unresolved AS (
      SELECT id, normalize_food_text(label) AS norm
      FROM pantry_lot
      WHERE food_id IS NULL AND closed_at IS NULL
    ),
    -- An alias hit is a decision already made by hand. It wins, and it is not
    -- re-litigated by similarity.
    by_alias AS (
      SELECT u.id, a.food_id, 1.0::numeric AS score
      FROM unresolved u
      JOIN food_alias a
        ON a.normalized_text = u.norm
       AND a.is_negative = FALSE
       AND a.food_id IS NOT NULL
    ),
    by_trigram AS (
      SELECT DISTINCT ON (u.id)
             u.id,
             f.id AS food_id,
             word_similarity(u.norm, normalize_food_text(f.name)) AS score
      FROM unresolved u
      JOIN mirror_food_item f
        ON normalize_food_text(f.name) %> u.norm
      WHERE NOT EXISTS (SELECT 1 FROM by_alias b WHERE b.id = u.id)
        -- Never resolve to something a human has explicitly rejected.
        AND NOT EXISTS (
          SELECT 1 FROM food_alias na
          WHERE na.is_negative AND na.normalized_text = u.norm AND na.food_id = f.id
        )
      ORDER BY u.id, word_similarity(u.norm, normalize_food_text(f.name)) DESC
    ),
    picked AS (
      SELECT * FROM by_alias
      UNION ALL
      SELECT * FROM by_trigram WHERE score >= 0.5
    )
    UPDATE pantry_lot l
       SET food_id = p.food_id
      FROM picked p
     WHERE l.id = p.id
    RETURNING l.id
  `;

  // Alias hit counts are how the learning loop makes itself visible.
  await sql`
    UPDATE food_alias a
       SET hits = a.hits + 1
      FROM pantry_lot l
     WHERE l.food_id = a.food_id
       AND a.normalized_text = normalize_food_text(l.label)
       AND a.is_negative = FALSE
  `;

  return rows.length;
}

/* ========================================================================== */
/* 2. Direct links: a meal eaten out ↔ the charge that paid for it            */
/* ========================================================================== */

interface DirectCandidate {
  meal_id: number;
  transaction_id: string;
  amount: string;
  currency: string;
  day_gap: number;
  name_score: string | null;
  meal_type_slug: string;
  merchant: string | null;
  meal_date: string;
}

/**
 * Date proximity. A card charge posts on or after the meal, rarely more than a
 * couple of days later, so the window is asymmetric — a charge posting BEFORE
 * the meal it paid for is not a thing.
 */
function dateScore(gap: number): number {
  if (gap === 0) return 1;
  if (gap === 1) return 0.85;
  if (gap === 2) return 0.6;
  if (gap === 3) return 0.35;
  return 0;
}

export async function proposeDirectLinks(sinceDays = 60): Promise<{ proposed: number; confirmed: number }> {
  const candidates = await sql<DirectCandidate[]>`
    WITH open_tx AS (
      SELECT t.id, t.posted_date, t.amount, t.currency, t.merchant
      FROM mirror_transaction t
      WHERE t.category_slug IN ('dining', 'coffee')
        AND t.posted_date >= CURRENT_DATE - ${sinceDays}::int
        AND NOT EXISTS (
          SELECT 1 FROM cost_link cl
          WHERE cl.transaction_id = t.id AND cl.status IN ('confirmed', 'proposed')
        )
    ),
    open_meal AS (
      SELECT m.id, m.meal_date, m.meal_type_slug,
             (SELECT string_agg(DISTINCT e.restaurant, ' ')
                FROM mirror_meal_entry e
               WHERE e.meal_id = m.id AND e.restaurant IS NOT NULL) AS restaurant_text,
             (SELECT string_agg(DISTINCT coalesce(e.brand, e.food_name), ' ')
                FROM mirror_meal_entry e WHERE e.meal_id = m.id) AS entry_text
      FROM mirror_meal m
      WHERE m.meal_date >= CURRENT_DATE - ${sinceDays}::int
        AND NOT EXISTS (
          SELECT 1 FROM cost_link cl
          WHERE cl.meal_id = m.id AND cl.method = 'direct_transaction'
            AND cl.status IN ('confirmed', 'proposed')
        )
        AND EXISTS (SELECT 1 FROM mirror_meal_entry e WHERE e.meal_id = m.id)
    )
    SELECT om.id            AS meal_id,
           ot.id            AS transaction_id,
           ot.amount,
           ot.currency,
           (ot.posted_date - om.meal_date) AS day_gap,
           GREATEST(
             word_similarity(normalize_food_text(om.restaurant_text), normalize_food_text(ot.merchant)),
             word_similarity(normalize_food_text(ot.merchant), normalize_food_text(om.entry_text))
           )                AS name_score,
           om.meal_type_slug,
           ot.merchant,
           om.meal_date::text AS meal_date
    FROM open_tx ot
    JOIN open_meal om
      ON om.meal_date BETWEEN ot.posted_date - 3 AND ot.posted_date
  `;

  // Uniqueness is a real signal and it can only be computed once the whole
  // candidate set is in hand: a charge that could be any of four meals that day
  // is genuinely more ambiguous than one with a single plausible meal.
  const byTx = new Map<string, number>();
  const byMeal = new Map<number, number>();
  for (const c of candidates) {
    byTx.set(c.transaction_id, (byTx.get(c.transaction_id) ?? 0) + 1);
    byMeal.set(c.meal_id, (byMeal.get(c.meal_id) ?? 0) + 1);
  }

  const scored = candidates
    .map((c) => {
      const d = dateScore(Number(c.day_gap));
      const name = c.name_score != null ? Number(c.name_score) : 0;
      const competition = Math.max(byTx.get(c.transaction_id) ?? 1, byMeal.get(c.meal_id) ?? 1);
      const unique = 1 / competition;

      // A named restaurant match is the strongest evidence available, so it
      // carries the most weight. With no name to compare, the score is capped by
      // timing and uniqueness alone — which lands near the floor, as it should:
      // "the only dining charge on the only day you ate out" is suggestive, not
      // proof.
      const confidence = name > 0 ? 0.5 * name + 0.3 * d + 0.2 * unique : 0.55 * d + 0.45 * unique;

      return { ...c, confidence: Math.min(confidence, 1), d, name, unique };
    })
    .filter((c) => c.confidence >= PROPOSE_FLOOR)
    .sort((a, b) => b.confidence - a.confidence);

  // Greedy one-to-one assignment, best first. A transaction pays for one meal and
  // a meal is paid by one charge; letting both sides be claimed twice would
  // produce contradictory proposals that can't both be accepted.
  const takenTx = new Set<string>();
  const takenMeal = new Set<number>();
  let proposed = 0;
  let confirmed = 0;

  for (const c of scored) {
    if (takenTx.has(c.transaction_id) || takenMeal.has(c.meal_id)) continue;
    takenTx.add(c.transaction_id);
    takenMeal.add(c.meal_id);

    const status = c.confidence >= AUTO_CONFIRM ? "confirmed" : "proposed";
    await sql`
      INSERT INTO cost_link
        (meal_id, method, transaction_id, allocated_amount, currency, status, origin, confidence, evidence)
      VALUES (${c.meal_id}, 'direct_transaction', ${c.transaction_id}::uuid, ${Math.abs(Number(c.amount))},
              ${c.currency}, ${status}, 'auto', ${c.confidence.toFixed(3)},
              ${sql.json({
                date_score: c.d,
                day_gap: Number(c.day_gap),
                name_score: c.name,
                uniqueness: c.unique,
                merchant: c.merchant,
                meal_date: c.meal_date,
                rule: "direct_transaction/v1",
              })})
    `;
    if (status === "confirmed") confirmed++;
    else proposed++;
  }

  return { proposed, confirmed };
}

/* ========================================================================== */
/* 3. Pantry draws: FIFO depletion                                            */
/* ========================================================================== */

interface OpenEntry {
  entry_id: number;
  meal_id: number;
  food_id: number | null;
  quantity_g: string;
  meal_date: string;
}

interface OpenLot {
  id: number;
  purchased_on: string;
  remaining_g: string;
  cost_per_g: string;
  currency: string;
  age_days: number;
}

/**
 * Freshness discount. Eating something 60 days after buying it is possible
 * (frozen, pantry staples) but less likely than eating it the same week, and the
 * confidence should say so rather than pretend otherwise.
 */
function freshnessScore(ageDays: number): number {
  if (ageDays < 0) return 0; // bought after the meal — impossible
  if (ageDays <= PANTRY_FRESH_DAYS) return 1;
  if (ageDays >= MAX_PANTRY_AGE_DAYS) return 0;
  return 1 - (ageDays - PANTRY_FRESH_DAYS) / (MAX_PANTRY_AGE_DAYS - PANTRY_FRESH_DAYS);
}

export async function proposePantryDraws(sinceDays = 60): Promise<{ proposed: number; skipped: number }> {
  const entries = await sql<OpenEntry[]>`
    SELECT e.id AS entry_id, e.meal_id, e.food_id, e.quantity_g, m.meal_date::text AS meal_date
    FROM mirror_meal_entry e
    JOIN mirror_meal m ON m.id = e.meal_id
    WHERE m.meal_date >= CURRENT_DATE - ${sinceDays}::int
      AND e.food_id IS NOT NULL
      AND e.quantity_g > 0
      AND NOT EXISTS (
        SELECT 1 FROM cost_link cl
        WHERE cl.meal_entry_id = e.id AND cl.status IN ('confirmed', 'proposed')
      )
      -- A meal already paid for as a whole doesn't also draw from the pantry.
      AND NOT EXISTS (
        SELECT 1 FROM cost_link cl
        WHERE cl.meal_id = e.meal_id AND cl.method = 'direct_transaction'
          AND cl.status IN ('confirmed', 'proposed')
      )
    ORDER BY m.meal_date, e.order_index
  `;

  let proposed = 0;
  let skipped = 0;

  // Running balances held in memory for the pass. Two meals on the same day both
  // drawing from one lot must not both see the full opening balance — the second
  // has to see what the first left.
  const consumed = new Map<number, number>();

  for (const e of entries) {
    let need = Number(e.quantity_g);

    const lots = await sql<OpenLot[]>`
      SELECT b.id,
             b.purchased_on::text AS purchased_on,
             b.remaining_g,
             b.cost_per_g,
             b.currency,
             (${e.meal_date}::date - b.purchased_on) AS age_days
      FROM v_pantry_lot_balance b
      WHERE b.food_id = ${e.food_id}
        AND b.basis = 'mass'
        AND b.is_open
        AND b.purchased_on <= ${e.meal_date}::date
        AND (${e.meal_date}::date - b.purchased_on) <= ${MAX_PANTRY_AGE_DAYS}
      ORDER BY b.purchased_on ASC   -- FIFO: oldest stock goes first
    `;

    if (lots.length === 0) {
      skipped++;
      continue;
    }

    for (const lot of lots) {
      if (need <= 0.001) break;

      const alreadyTaken = consumed.get(lot.id) ?? 0;
      const available = Number(lot.remaining_g) - alreadyTaken;
      if (available <= 0.001) continue;

      const draw = Math.min(need, available);
      const costPerG = Number(lot.cost_per_g);
      const fresh = freshnessScore(Number(lot.age_days));
      if (fresh <= 0) continue;

      // The food identity is already established (lot.food_id === entry.food_id),
      // so what remains uncertain is timing, not identity. Confidence is high and
      // discounted only by age.
      const confidence = Math.min(0.6 + 0.4 * fresh, 1);
      if (confidence < PROPOSE_FLOOR) continue;

      const status = confidence >= AUTO_CONFIRM ? "confirmed" : "proposed";

      await sql`
        INSERT INTO cost_link
          (meal_id, meal_entry_id, method, pantry_lot_id, allocated_amount, allocated_g,
           currency, status, origin, confidence, evidence)
        VALUES (${e.meal_id}, ${e.entry_id}, 'pantry_draw', ${lot.id},
                ${(draw * costPerG).toFixed(2)}, ${draw.toFixed(3)}, ${lot.currency},
                ${status}, 'auto', ${confidence.toFixed(3)},
                ${sql.json({
                  drawn_g: Number(draw.toFixed(3)),
                  cost_per_g: costPerG,
                  age_days: Number(lot.age_days),
                  freshness: Number(fresh.toFixed(3)),
                  lot_purchased_on: lot.purchased_on,
                  rule: "pantry_draw/fifo/v1",
                })})
      `;

      consumed.set(lot.id, alreadyTaken + draw);
      need -= draw;
      proposed++;
    }

    if (need > 0.001) skipped++;
  }

  return { proposed, skipped };
}

/* ========================================================================== */
/* 4. Unit-basis lots: pro-rata allocation over a consumption window          */
/* ========================================================================== */

interface UnitLot {
  id: number;
  food_id: number;
  label: string;
  purchased_on: string;
  remaining_cost: string;
  currency: string;
  window_end: string;
}

/**
 * Cost the lots that FIFO-by-mass cannot touch.
 *
 * Supermarket receipts mostly print a UPC, not a weight — "QKR OATMEAL
 * 030000010400 F, $5.24". There is no gram figure to deplete, so a mass-based
 * draw finds nothing, and on real data that was 46 of 51 lots: the grocery half
 * of the system attributed exactly nothing.
 *
 * The honest alternative is not to invent a package weight. It is to change the
 * question. One tub of oatmeal bought on the 3rd, oatmeal eaten on the 4th, 6th
 * and 9th, another tub bought on the 11th — that tub covered those three meals,
 * and its cost divides across them in proportion to how much was eaten each
 * time. The unknown is the package size; the *window* is observable.
 *
 * So the window runs from purchase to the next purchase of the same food (or
 * MAX_PANTRY_AGE_DAYS, or today, whichever comes first), and the lot's cost is
 * split pro-rata by grams across the meal entries inside it.
 *
 * This is a different claim from a FIFO draw and is labelled as such in
 * `evidence.rule`, so a number produced this way can always be told apart from
 * one measured against a printed weight.
 */
export async function proposeUnitLotAllocation(sinceDays = 60): Promise<{ proposed: number; skipped: number }> {
  const lots = await sql<UnitLot[]>`
    SELECT b.id,
           l.food_id,
           b.label,
           b.purchased_on::text AS purchased_on,
           b.remaining_cost,
           b.currency,
           -- The window closes when the same food is bought again: the next tub
           -- takes over from there.
           LEAST(
             COALESCE(
               (SELECT MIN(n.purchased_on)
                  FROM pantry_lot n
                 WHERE n.food_id = l.food_id
                   AND n.purchased_on > l.purchased_on),
               CURRENT_DATE + 1
             ),
             l.purchased_on + ${MAX_PANTRY_AGE_DAYS}::int,
             CURRENT_DATE + 1
           )::text AS window_end
    FROM v_pantry_lot_balance b
    JOIN pantry_lot l ON l.id = b.id
    WHERE b.basis = 'unit'
      AND b.is_open
      AND l.food_id IS NOT NULL
      AND b.remaining_cost > 0.005
      AND l.purchased_on >= CURRENT_DATE - ${sinceDays}::int
    ORDER BY l.purchased_on
  `;

  let proposed = 0;
  let skipped = 0;

  for (const lot of lots) {
    const entries = await sql<{ entry_id: number; meal_id: number; quantity_g: string; meal_date: string }[]>`
      SELECT e.id AS entry_id, e.meal_id, e.quantity_g, m.meal_date::text AS meal_date
      FROM mirror_meal_entry e
      JOIN mirror_meal m ON m.id = e.meal_id
      WHERE e.food_id = ${lot.food_id}
        AND e.quantity_g > 0
        AND m.meal_date >= ${lot.purchased_on}::date
        AND m.meal_date <  ${lot.window_end}::date
        AND NOT EXISTS (
          SELECT 1 FROM cost_link cl
          WHERE cl.meal_entry_id = e.id AND cl.status IN ('confirmed', 'proposed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM cost_link cl
          WHERE cl.meal_id = e.meal_id AND cl.method = 'direct_transaction'
            AND cl.status IN ('confirmed', 'proposed')
        )
      ORDER BY m.meal_date
    `;

    // No meals in the window means the food is still in the pantry, not that
    // something failed. Leaving it unattributed is the correct answer.
    if (entries.length === 0) {
      skipped++;
      continue;
    }

    const totalG = entries.reduce((s, e) => s + Number(e.quantity_g), 0);
    if (totalG <= 0) {
      skipped++;
      continue;
    }

    const remaining = Number(lot.remaining_cost);

    // A window that closed because the food was re-bought is real evidence the
    // lot was finished. One left open by the age cap is a weaker inference, so
    // it scores lower.
    const closedByRepurchase =
      Date.parse(`${lot.window_end}T00:00:00Z`) <
      Date.parse(`${lot.purchased_on}T00:00:00Z`) + MAX_PANTRY_AGE_DAYS * 86_400_000;
    const confidence = closedByRepurchase ? 0.72 : 0.55;

    for (const e of entries) {
      const share = Number(e.quantity_g) / totalG;
      const amount = remaining * share;
      if (amount < 0.005) continue; // below a cent — not worth a row

      await sql`
        INSERT INTO cost_link
          (meal_id, meal_entry_id, method, pantry_lot_id, allocated_amount, allocated_g,
           currency, status, origin, confidence, evidence)
        VALUES (${e.meal_id}, ${e.entry_id}, 'pantry_draw', ${lot.id},
                ${amount.toFixed(2)}, ${Number(e.quantity_g).toFixed(3)}, ${lot.currency},
                'proposed', 'auto', ${confidence.toFixed(3)},
                ${sql.json({
                  rule: "unit_lot_prorata/v1",
                  lot_label: lot.label,
                  lot_cost: remaining,
                  window_start: lot.purchased_on,
                  window_end: lot.window_end,
                  window_closed_by: closedByRepurchase ? "repurchase" : "age cap",
                  meals_in_window: entries.length,
                  share_of_lot: Number(share.toFixed(4)),
                  basis: "no printed weight — cost split pro-rata by grams eaten",
                })})
      `;
      proposed++;
    }
  }

  return { proposed, skipped };
}

/* ========================================================================== */

export async function runMatcher(sinceDays = 60): Promise<MatchReport> {
  const lotsResolved = await resolveLotFoods();
  const direct = await proposeDirectLinks(sinceDays);
  // Mass first: a printed weight is better evidence than an inferred window, so
  // it gets first claim on any entry both could explain.
  const draws = await proposePantryDraws(sinceDays);
  const unit = await proposeUnitLotAllocation(sinceDays);

  return {
    directProposed: direct.proposed,
    directConfirmed: direct.confirmed,
    lotsResolved,
    drawsProposed: draws.proposed + unit.proposed,
    skippedNoCandidate: draws.skipped + unit.skipped,
  };
}
