import { sql } from "@/db/client";

/**
 * Read models for the UI.
 *
 * Every query that returns a cost also returns its coverage. That is not a
 * convention — it is the honesty rule from docs/DESIGN.md, enforced at the
 * boundary so a component physically cannot render a cost it has no coverage
 * for.
 */

export interface DayBucket {
  meal_date: string;
  meal_type: string;
  meal_type_slug: string;
  cost: number;
  cost_proposed: number;
  meals: number;
  entries: number;
  linked_entries: number;
  coverage: number;
}

export async function getDailyCosts(since: string, until: string): Promise<DayBucket[]> {
  const rows = await sql<Record<string, string>[]>`
    SELECT meal_date::text, meal_type, meal_type_slug, cost, cost_proposed,
           meals, entries, linked_entries, coverage
    FROM v_daily_meal_cost
    WHERE meal_date BETWEEN ${since}::date AND ${until}::date
    ORDER BY meal_date
  `;
  return rows.map((r) => ({
    meal_date: r.meal_date,
    meal_type: r.meal_type,
    meal_type_slug: r.meal_type_slug,
    cost: Number(r.cost ?? 0),
    cost_proposed: Number(r.cost_proposed ?? 0),
    meals: Number(r.meals ?? 0),
    entries: Number(r.entries ?? 0),
    linked_entries: Number(r.linked_entries ?? 0),
    coverage: Number(r.coverage ?? 0),
  }));
}

export interface MealTypeSummary {
  meal_type: string;
  meal_type_slug: string;
  meals: number;
  total: number;
  avg: number;
  entries: number;
  linked_entries: number;
  coverage: number;
}

export async function getMealTypeSummary(since: string, until: string): Promise<MealTypeSummary[]> {
  const rows = await sql<Record<string, string>[]>`
    SELECT meal_type,
           meal_type_slug,
           COUNT(*)                                   AS meals,
           COALESCE(SUM(cost), 0)                     AS total,
           SUM(entry_count)                           AS entries,
           SUM(linked_entry_count)                    AS linked_entries,
           -- Averaged over meals WITH a cost, not all meals: dividing known
           -- spend by every meal including the unattributed ones would report an
           -- average dinner far cheaper than any dinner actually was.
           COALESCE(AVG(cost) FILTER (WHERE cost > 0), 0) AS avg
    FROM v_meal_cost
    WHERE meal_date BETWEEN ${since}::date AND ${until}::date
    GROUP BY meal_type, meal_type_slug
  `;
  return rows.map((r) => {
    const entries = Number(r.entries ?? 0);
    const linked = Number(r.linked_entries ?? 0);
    return {
      meal_type: r.meal_type,
      meal_type_slug: r.meal_type_slug,
      meals: Number(r.meals ?? 0),
      total: Number(r.total ?? 0),
      avg: Number(r.avg ?? 0),
      entries,
      linked_entries: linked,
      coverage: entries > 0 ? linked / entries : 0,
    };
  });
}

export interface PeriodTotals {
  cost: number;
  proposed: number;
  meals: number;
  entries: number;
  linked_entries: number;
  coverage: number;
  unattributed_spend: number;
  unattributed_count: number;
}

export async function getPeriodTotals(since: string, until: string): Promise<PeriodTotals> {
  const [t] = await sql<Record<string, string>[]>`
    SELECT COALESCE(SUM(cost), 0)          AS cost,
           COALESCE(SUM(cost_proposed), 0) AS proposed,
           COUNT(*)                        AS meals,
           COALESCE(SUM(entry_count), 0)   AS entries,
           COALESCE(SUM(linked_entry_count), 0) AS linked_entries
    FROM v_meal_cost
    WHERE meal_date BETWEEN ${since}::date AND ${until}::date
  `;
  const [u] = await sql<Record<string, string>[]>`
    SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS n
    FROM v_unattributed_spend
    WHERE posted_date BETWEEN ${since}::date AND ${until}::date
  `;
  const entries = Number(t?.entries ?? 0);
  const linked = Number(t?.linked_entries ?? 0);
  return {
    cost: Number(t?.cost ?? 0),
    proposed: Number(t?.proposed ?? 0),
    meals: Number(t?.meals ?? 0),
    entries,
    linked_entries: linked,
    coverage: entries > 0 ? linked / entries : 0,
    unattributed_spend: Number(u?.amount ?? 0),
    unattributed_count: Number(u?.n ?? 0),
  };
}

export interface MealRow {
  meal_id: number;
  meal_date: string;
  meal_time: string | null;
  meal_type: string;
  meal_type_slug: string;
  note: string | null;
  entry_count: number;
  linked_entry_count: number;
  cost: number;
  cost_proposed: number;
  coverage: number;
  attribution: "direct" | "itemized" | "unattributed";
  items: string;
}

export async function getMeals(since: string, until: string, limit = 200): Promise<MealRow[]> {
  const rows = await sql<Record<string, string>[]>`
    SELECT v.*,
           (SELECT string_agg(e.food_name, ', ' ORDER BY e.order_index)
              FROM mirror_meal_entry e WHERE e.meal_id = v.meal_id) AS items
    FROM v_meal_cost v
    WHERE v.meal_date BETWEEN ${since}::date AND ${until}::date
    ORDER BY v.meal_date DESC, v.meal_time DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    meal_id: Number(r.meal_id),
    meal_date: String(r.meal_date).slice(0, 10),
    meal_time: r.meal_time ? String(r.meal_time).slice(0, 5) : null,
    meal_type: r.meal_type,
    meal_type_slug: r.meal_type_slug,
    note: r.note ?? null,
    entry_count: Number(r.entry_count ?? 0),
    linked_entry_count: Number(r.linked_entry_count ?? 0),
    cost: Number(r.cost ?? 0),
    cost_proposed: Number(r.cost_proposed ?? 0),
    coverage: Number(r.coverage ?? 0),
    attribution: r.attribution as MealRow["attribution"],
    items: r.items ?? "",
  }));
}

export interface ProposedLink {
  id: number;
  meal_id: number;
  meal_entry_id: number | null;
  method: string;
  confidence: number;
  allocated_amount: number;
  allocated_g: number | null;
  currency: string;
  evidence: Record<string, unknown>;
  created_at: string;
  meal_date: string;
  meal_time: string | null;
  meal_type: string;
  meal_type_slug: string;
  entry_name: string | null;
  entry_g: number | null;
  source_label: string;
  source_detail: string | null;
}

/** The review queue: what the matcher thinks, ordered by how sure it is. */
export async function getProposedLinks(limit = 100): Promise<ProposedLink[]> {
  const rows = await sql<Record<string, string>[]>`
    SELECT cl.id, cl.meal_id, cl.meal_entry_id, cl.method::text, cl.confidence,
           cl.allocated_amount, cl.allocated_g, cl.currency, cl.evidence,
           cl.created_at::text,
           m.meal_date::text, m.meal_time::text, m.meal_type, m.meal_type_slug,
           e.food_name AS entry_name, e.quantity_g AS entry_g,
           COALESCE(t.merchant, ri.name, l.label, 'manual') AS source_label,
           CASE
             WHEN t.id  IS NOT NULL THEN t.posted_date::text || ' · ' || COALESCE(t.category_name, '')
             WHEN l.id  IS NOT NULL THEN 'bought ' || l.purchased_on::text
             WHEN ri.id IS NOT NULL THEN ri.raw_name
           END AS source_detail
    FROM cost_link cl
    JOIN mirror_meal m ON m.id = cl.meal_id
    LEFT JOIN mirror_meal_entry e   ON e.id  = cl.meal_entry_id
    LEFT JOIN mirror_transaction t  ON t.id  = cl.transaction_id
    LEFT JOIN mirror_receipt_item ri ON ri.id = cl.receipt_item_id
    LEFT JOIN pantry_lot l          ON l.id  = cl.pantry_lot_id
    WHERE cl.status = 'proposed'
    ORDER BY cl.confidence DESC NULLS LAST, m.meal_date DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    meal_id: Number(r.meal_id),
    meal_entry_id: r.meal_entry_id != null ? Number(r.meal_entry_id) : null,
    method: r.method,
    confidence: Number(r.confidence ?? 0),
    allocated_amount: Number(r.allocated_amount ?? 0),
    allocated_g: r.allocated_g != null ? Number(r.allocated_g) : null,
    currency: r.currency ?? "USD",
    evidence: (r.evidence as unknown as Record<string, unknown>) ?? {},
    created_at: r.created_at,
    meal_date: String(r.meal_date).slice(0, 10),
    meal_time: r.meal_time ? String(r.meal_time).slice(0, 5) : null,
    meal_type: r.meal_type,
    meal_type_slug: r.meal_type_slug,
    entry_name: r.entry_name ?? null,
    entry_g: r.entry_g != null ? Number(r.entry_g) : null,
    source_label: r.source_label,
    source_detail: r.source_detail ?? null,
  }));
}

export interface UnattributedTx {
  id: string;
  posted_date: string;
  amount: number;
  currency: string;
  merchant: string | null;
  description: string | null;
  category_name: string | null;
  has_receipt: boolean;
}

export async function getUnattributedSpend(since: string, until: string): Promise<UnattributedTx[]> {
  const rows = await sql<Record<string, string>[]>`
    SELECT id, posted_date::text, amount, currency, merchant, description, category_name, has_receipt
    FROM v_unattributed_spend
    WHERE posted_date BETWEEN ${since}::date AND ${until}::date
    ORDER BY posted_date DESC, amount DESC
    LIMIT 300
  `;
  return rows.map((r) => ({
    id: r.id,
    posted_date: String(r.posted_date).slice(0, 10),
    amount: Number(r.amount ?? 0),
    currency: r.currency ?? "USD",
    merchant: r.merchant ?? null,
    description: r.description ?? null,
    category_name: r.category_name ?? null,
    has_receipt: String(r.has_receipt) === "true",
  }));
}

export interface LotRow {
  id: number;
  label: string;
  food_id: number | null;
  purchased_on: string;
  basis: "mass" | "unit";
  total_cost: number;
  currency: string;
  qty_total_g: number | null;
  remaining_g: number | null;
  drawn_g: number | null;
  remaining_cost: number;
  drawn_cost: number;
  cost_per_g: number | null;
  is_open: boolean;
}

export async function getPantryLots(limit = 200): Promise<LotRow[]> {
  const rows = await sql<Record<string, string>[]>`
    SELECT id, label, food_id, purchased_on::text, basis::text, total_cost, currency,
           qty_total_g, remaining_g, drawn_g, remaining_cost, drawn_cost, cost_per_g, is_open
    FROM v_pantry_lot_balance
    ORDER BY purchased_on DESC, id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    label: r.label,
    food_id: r.food_id != null ? Number(r.food_id) : null,
    purchased_on: String(r.purchased_on).slice(0, 10),
    basis: r.basis as "mass" | "unit",
    total_cost: Number(r.total_cost ?? 0),
    currency: r.currency ?? "USD",
    qty_total_g: r.qty_total_g != null ? Number(r.qty_total_g) : null,
    remaining_g: r.remaining_g != null ? Number(r.remaining_g) : null,
    drawn_g: r.drawn_g != null ? Number(r.drawn_g) : null,
    remaining_cost: Number(r.remaining_cost ?? 0),
    drawn_cost: Number(r.drawn_cost ?? 0),
    cost_per_g: r.cost_per_g != null ? Number(r.cost_per_g) : null,
    is_open: String(r.is_open) === "true",
  }));
}

export async function getLastSync(): Promise<{ source: string; finished_at: string | null; status: string }[]> {
  return sql<{ source: string; finished_at: string | null; status: string }[]>`
    SELECT DISTINCT ON (source) source::text, finished_at::text, status::text
    FROM sync_run
    ORDER BY source, started_at DESC
  `;
}

export async function countProposed(): Promise<number> {
  const [r] = await sql<{ n: string }[]>`SELECT COUNT(*) AS n FROM cost_link WHERE status = 'proposed'`;
  return Number(r?.n ?? 0);
}
