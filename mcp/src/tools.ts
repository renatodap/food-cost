/**
 * Tool surface for the food-cost connector.
 *
 * Built to the 2026 MCP schema principles (docs/RESEARCH.md §6):
 *   - verb_object names, one convention throughout
 *   - flat input schemas — no nested objects
 *   - all four annotations set explicitly on every tool
 *   - failures come back as ToolError → isError result, so the model can recover
 *   - server-side validation; the schema is not the enforcement boundary
 *
 * The one structural decision that matters: PROPOSING AND COMMITTING ARE
 * SEPARATE TOOLS. `list_proposed_links` is read-only and shows the matcher's
 * reasoning; `confirm_cost_link` is the only thing that finalizes one. No tool
 * silently accepts a low-confidence match. That pause does not depend on the
 * client supporting elicitation — it is structural, in the tool split itself.
 */
import { readOnlySql, sql } from "./db.js";
import { linkAction, triggerSync } from "./api.js";

export class ToolError extends Error {}

type Json = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function str(v: unknown, name: string, required = true): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s && required) throw new ToolError(`${name} is required.`);
  return s;
}

function int(v: unknown, name: string, required = true): number {
  if (v == null || v === "") {
    if (required) throw new ToolError(`${name} is required.`);
    return NaN;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`${name} must be a number.`);
  return n;
}

function date(v: unknown, name: string, required = true): string {
  const s = str(v, name, required);
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ToolError(`${name} must be YYYY-MM-DD.`);
  return s;
}

/** Default window when the model doesn't name one. */
function defaultRange(from?: string, to?: string): { from: string; to: string } {
  const end = to || new Date().toISOString().slice(0, 10);
  if (from) return { from, to: end };
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 29);
  return { from: d.toISOString().slice(0, 10), to: end };
}

/* -------------------------------------------------------------------------- */
/* definitions                                                                 */
/* -------------------------------------------------------------------------- */

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Reaches two other services over HTTP, hence openWorld. */
const WRITE_REMOTE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const TOOL_DEFS = [
  {
    name: "get_cost_summary",
    description:
      "Spend per meal type over a date range, with the coverage that qualifies it. Start here for any 'how much do I spend on lunch' question. Coverage is the fraction of logged food actually traced to money — always report it alongside the cost, because a total drawn from 40% coverage is not a total.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD. Defaults to 30 days ago." },
        to: { type: "string", description: "End date YYYY-MM-DD. Defaults to today." },
      },
    },
    annotations: { ...READ, title: "Cost summary by meal type" },
  },
  {
    name: "get_daily_costs",
    description:
      "Day-by-day food spend split by meal type over a range. Use for trends and per-day questions; use get_cost_summary for totals.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD. Defaults to 30 days ago." },
        to: { type: "string", description: "End date YYYY-MM-DD. Defaults to today." },
      },
    },
    annotations: { ...READ, title: "Daily costs" },
  },
  {
    name: "get_meal_cost",
    description:
      "One meal's cost with its full provenance: every confirmed link, what it points at, and how the number was arrived at. Use when asked why a specific meal cost what it did.",
    inputSchema: {
      type: "object",
      properties: { meal_id: { type: "number", description: "The meal's id." } },
      required: ["meal_id"],
    },
    annotations: { ...READ, title: "Meal cost detail" },
  },
  {
    name: "list_proposed_links",
    description:
      "The review queue: matches the matcher proposed but nobody has decided yet, with a confidence and the per-signal evidence behind each. READ ONLY — showing a proposal is not accepting it. Present these for a decision rather than confirming them yourself unless explicitly told to.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max rows, default 25, cap 100." },
        min_confidence: { type: "number", description: "Only proposals at or above this 0–1 score." },
      },
    },
    annotations: { ...READ, title: "Proposed links" },
  },
  {
    name: "list_unattributed_meals",
    description:
      "Meals whose cost is partly or wholly unknown, newest first. This is the food side of the reconciliation gap.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD. Defaults to 30 days ago." },
        to: { type: "string", description: "End date YYYY-MM-DD. Defaults to today." },
        limit: { type: "number", description: "Max rows, default 50, cap 200." },
      },
    },
    annotations: { ...READ, title: "Unattributed meals" },
  },
  {
    name: "list_unattributed_spend",
    description:
      "Food charges with nothing eaten attached to them — the money side of the gap. Some of this is groceries still in the pantry, which will attach as they get eaten; some is genuinely unmatched.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD. Defaults to 30 days ago." },
        to: { type: "string", description: "End date YYYY-MM-DD. Defaults to today." },
      },
    },
    annotations: { ...READ, title: "Unattributed spend" },
  },
  {
    name: "list_pantry_lots",
    description:
      "Grocery cost lots and their remaining balances. Meals draw grams from these oldest-first (FIFO). A lot with no food_id can't be drawn from — its receipt text never resolved to a food.",
    inputSchema: {
      type: "object",
      properties: {
        open_only: { type: "boolean", description: "Only lots with stock left. Default true." },
        limit: { type: "number", description: "Max rows, default 50, cap 200." },
      },
    },
    annotations: { ...READ, title: "Pantry lots" },
  },
  {
    name: "confirm_cost_link",
    description:
      "Accept one proposed link as correct. This is the ONLY tool that finalizes an attribution, and it also teaches the alias table so the same match resolves deterministically next time. Confirm what Renato has agreed to, not what looks plausible.",
    inputSchema: {
      type: "object",
      properties: { link_id: { type: "number", description: "Id from list_proposed_links." } },
      required: ["link_id"],
    },
    annotations: { ...WRITE_REMOTE, title: "Confirm link" },
  },
  {
    name: "reject_cost_link",
    description:
      "Mark a proposed link wrong. The rejection is kept as a negative label so the matcher stops re-proposing that pair — rejecting is as valuable as confirming.",
    inputSchema: {
      type: "object",
      properties: { link_id: { type: "number", description: "Id from list_proposed_links." } },
      required: ["link_id"],
    },
    annotations: { ...WRITE_REMOTE, title: "Reject link" },
  },
  {
    name: "link_transaction_to_meal",
    description:
      "Attach a whole charge to a whole meal by hand, when the matcher missed it. Use for meals eaten out. Confirm the pairing with Renato first — this writes a confirmed, human-reviewed link.",
    inputSchema: {
      type: "object",
      properties: {
        meal_id: { type: "number", description: "The meal that was eaten." },
        transaction_id: { type: "string", description: "The transaction uuid that paid for it." },
      },
      required: ["meal_id", "transaction_id"],
    },
    annotations: { ...WRITE_REMOTE, title: "Link charge to meal" },
  },
  {
    name: "set_manual_meal_cost",
    description:
      "Cost a meal by typing the amount, when there is genuinely no transaction to point at — cash at a market stall, someone else's card. Prefer link_transaction_to_meal whenever a real charge exists.",
    inputSchema: {
      type: "object",
      properties: {
        meal_id: { type: "number", description: "The meal to cost." },
        amount: { type: "number", description: "Positive amount in USD." },
        note: { type: "string", description: "Why this was entered by hand." },
      },
      required: ["meal_id", "amount"],
    },
    annotations: { ...WRITE_REMOTE, title: "Set manual meal cost" },
  },
  {
    name: "sync_and_match",
    description:
      "Pull fresh meals and transactions from DAP Fitness and DAP Finance, then run the matcher to propose new links. Proposals still need confirming — this does not decide anything. Run it when the data looks stale.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Look-back window, default 45, cap 730." },
        match: { type: "boolean", description: "Run the matcher after syncing. Default true." },
      },
    },
    annotations: { ...WRITE_REMOTE, title: "Sync and match" },
  },
  {
    name: "describe_schema",
    description:
      "List food_cost tables and views, or pass a name for its columns. Call before run_sql so names are exact.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string", description: "Omit to list everything." } },
    },
    annotations: { ...READ, title: "Describe schema" },
  },
  {
    name: "run_sql",
    description:
      "Run a read-only SELECT against food_cost. The escape hatch for anything the dedicated tools don't shape — joins, custom windows, percentiles. Enforced read-only inside a READ ONLY transaction with a statement timeout. Single statement, no trailing semicolon. Call describe_schema first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A single SELECT or WITH statement. No semicolon." },
        max_rows: { type: "number", description: "Default 200, cap 2000." },
      },
      required: ["query"],
    },
    annotations: { ...READ, title: "Run SQL" },
  },
] as const;

const NAMES = new Set(TOOL_DEFS.map((t) => t.name));
export const hasTool = (n: string) => NAMES.has(n as (typeof TOOL_DEFS)[number]["name"]);

/* -------------------------------------------------------------------------- */
/* implementations                                                             */
/* -------------------------------------------------------------------------- */

async function getCostSummary(a: Json) {
  const { from, to } = defaultRange(date(a.from, "from", false), date(a.to, "to", false));
  const rows = await sql`
    SELECT meal_type,
           meal_type_slug,
           COUNT(*)                                      AS meals,
           ROUND(COALESCE(SUM(cost), 0), 2)              AS total_cost,
           ROUND(COALESCE(AVG(cost) FILTER (WHERE cost > 0), 0), 2) AS avg_cost_when_known,
           SUM(entry_count)                              AS food_items,
           -- covered_entry_count, NOT linked_entry_count. A whole-meal charge
           -- covers every entry of its meal while producing no per-entry links,
           -- so summing the latter reports near-zero coverage for meals that
           -- are fully attributed.
           SUM(covered_entry_count)                      AS food_items_traced,
           CASE WHEN SUM(entry_count) = 0 THEN 0
                ELSE ROUND(SUM(covered_entry_count)::numeric / SUM(entry_count), 3) END AS coverage
    FROM v_meal_cost
    WHERE meal_date BETWEEN ${from}::date AND ${to}::date
    GROUP BY meal_type, meal_type_slug
    ORDER BY total_cost DESC
  `;
  const [totals] = await sql`
    SELECT ROUND(COALESCE(SUM(cost), 0), 2) AS total_cost,
           COUNT(*) AS meals,
           SUM(entry_count) AS food_items,
           SUM(covered_entry_count) AS food_items_traced
    FROM v_meal_cost WHERE meal_date BETWEEN ${from}::date AND ${to}::date
  `;
  const items = Number(totals?.food_items ?? 0);
  const traced = Number(totals?.food_items_traced ?? 0);
  return {
    from,
    to,
    by_meal_type: rows,
    total_cost: Number(totals?.total_cost ?? 0),
    meals: Number(totals?.meals ?? 0),
    coverage: items > 0 ? Number((traced / items).toFixed(3)) : 0,
    note: "coverage is the share of logged food traced to money; report the cost and the coverage together",
  };
}

async function getDailyCosts(a: Json) {
  const { from, to } = defaultRange(date(a.from, "from", false), date(a.to, "to", false));
  const rows = await sql`
    SELECT meal_date::text, meal_type, ROUND(cost, 2) AS cost, coverage, meals, entries, linked_entries
    FROM v_daily_meal_cost
    WHERE meal_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY meal_date, meal_type
  `;
  return { from, to, days: rows };
}

async function getMealCost(a: Json) {
  const mealId = int(a.meal_id, "meal_id");
  const [meal] = await sql`
    SELECT meal_id, meal_date::text, meal_time::text, meal_type, note,
           ROUND(cost, 2) AS cost, coverage, attribution, entry_count, linked_entry_count
    FROM v_meal_cost WHERE meal_id = ${mealId}
  `;
  if (!meal) throw new ToolError(`No meal with id ${mealId}.`);

  const entries = await sql`
    SELECT id, food_name, quantity_g, energy_kcal
    FROM mirror_meal_entry WHERE meal_id = ${mealId} ORDER BY order_index
  `;
  const links = await sql`
    SELECT cl.id, cl.method::text, cl.status::text, cl.origin::text, cl.confidence,
           ROUND(cl.allocated_amount, 2) AS amount, cl.allocated_g, cl.evidence,
           cl.reviewed_at IS NOT NULL AS human_reviewed,
           e.food_name, t.merchant, l.label AS lot_label, ri.name AS receipt_item
    FROM cost_link cl
    LEFT JOIN mirror_meal_entry e    ON e.id  = cl.meal_entry_id
    LEFT JOIN mirror_transaction t   ON t.id  = cl.transaction_id
    LEFT JOIN pantry_lot l           ON l.id  = cl.pantry_lot_id
    LEFT JOIN mirror_receipt_item ri ON ri.id = cl.receipt_item_id
    WHERE cl.meal_id = ${mealId} AND cl.status <> 'superseded'
    ORDER BY cl.status, cl.confidence DESC NULLS LAST
  `;
  return { meal, entries, links };
}

async function listProposedLinks(a: Json) {
  const limit = Math.min(Number.isFinite(int(a.limit, "limit", false)) ? int(a.limit, "limit", false) : 25, 100);
  const minC = Number.isFinite(int(a.min_confidence, "min_confidence", false))
    ? int(a.min_confidence, "min_confidence", false)
    : 0;
  const rows = await sql`
    SELECT cl.id, cl.method::text, cl.confidence, ROUND(cl.allocated_amount, 2) AS amount,
           cl.allocated_g, cl.evidence,
           m.id AS meal_id, m.meal_date::text, m.meal_type,
           e.food_name AS entry_name, e.quantity_g AS entry_g,
           COALESCE(t.merchant, ri.name, l.label) AS source_label
    FROM cost_link cl
    JOIN mirror_meal m ON m.id = cl.meal_id
    LEFT JOIN mirror_meal_entry e    ON e.id  = cl.meal_entry_id
    LEFT JOIN mirror_transaction t   ON t.id  = cl.transaction_id
    LEFT JOIN mirror_receipt_item ri ON ri.id = cl.receipt_item_id
    LEFT JOIN pantry_lot l           ON l.id  = cl.pantry_lot_id
    WHERE cl.status = 'proposed' AND COALESCE(cl.confidence, 0) >= ${minC}
    ORDER BY cl.confidence DESC NULLS LAST
    LIMIT ${limit}
  `;
  return {
    count: rows.length,
    proposals: rows,
    note: "these are proposals only — call confirm_cost_link to accept one, and ask before you do",
  };
}

async function listUnattributedMeals(a: Json) {
  const { from, to } = defaultRange(date(a.from, "from", false), date(a.to, "to", false));
  const limit = Math.min(Number.isFinite(int(a.limit, "limit", false)) ? int(a.limit, "limit", false) : 50, 200);
  const rows = await sql`
    SELECT v.meal_id, v.meal_date::text, v.meal_type, v.entry_count, v.linked_entry_count,
           v.coverage, ROUND(v.cost, 2) AS cost_so_far,
           (SELECT string_agg(e.food_name, ', ' ORDER BY e.order_index)
              FROM mirror_meal_entry e WHERE e.meal_id = v.meal_id) AS items
    FROM v_meal_cost v
    WHERE v.meal_date BETWEEN ${from}::date AND ${to}::date AND v.coverage < 1.0
    ORDER BY v.meal_date DESC
    LIMIT ${limit}
  `;
  return { from, to, count: rows.length, meals: rows };
}

async function listUnattributedSpend(a: Json) {
  const { from, to } = defaultRange(date(a.from, "from", false), date(a.to, "to", false));
  const rows = await sql`
    SELECT id, posted_date::text, ROUND(amount, 2) AS amount, currency, merchant,
           description, category_name, has_receipt
    FROM v_unattributed_spend
    WHERE posted_date BETWEEN ${from}::date AND ${to}::date
    ORDER BY posted_date DESC
  `;
  const total = rows.reduce((s: number, r) => s + Number(r.amount ?? 0), 0);
  return { from, to, count: rows.length, total: Number(total.toFixed(2)), transactions: rows };
}

async function listPantryLots(a: Json) {
  const openOnly = a.open_only !== false;
  const limit = Math.min(Number.isFinite(int(a.limit, "limit", false)) ? int(a.limit, "limit", false) : 50, 200);
  const rows = await sql`
    SELECT id, label, food_id, purchased_on::text, basis::text,
           ROUND(total_cost, 2) AS total_cost, remaining_g, drawn_g,
           ROUND(remaining_cost, 2) AS remaining_cost, cost_per_g, is_open
    FROM v_pantry_lot_balance
    WHERE (${openOnly} = FALSE OR is_open)
    ORDER BY purchased_on DESC
    LIMIT ${limit}
  `;
  return { count: rows.length, lots: rows };
}

async function describeSchema(a: Json) {
  const table = str(a.table, "table", false);
  if (!table) {
    const rows = await sql`
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_type, table_name
    `;
    return { objects: rows, hint: "pass a name for its columns, then use run_sql" };
  }
  const cols = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `;
  if (cols.length === 0) throw new ToolError(`No table or view named "${table}".`);
  return { table, columns: cols };
}

/** Rejected outright rather than escaped — a write keyword has no business here. */
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|reindex|call|do|merge|refresh)\b/i;

async function runSql(a: Json) {
  const query = str(a.query, "query");
  const maxRows = Math.min(
    Number.isFinite(int(a.max_rows, "max_rows", false)) ? int(a.max_rows, "max_rows", false) : 200,
    2000
  );

  const trimmed = query.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) throw new ToolError("Only SELECT or WITH statements are allowed.");
  if (trimmed.includes(";")) throw new ToolError("One statement only — remove the semicolon.");
  if (FORBIDDEN.test(trimmed)) throw new ToolError("That statement contains a write keyword.");

  // Defence in depth: the credential should already be SELECT-only, and the
  // transaction is READ ONLY regardless, so a bypass of the string checks above
  // still cannot write.
  const rows = await readOnlySql.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY");
    await tx.unsafe("SET LOCAL statement_timeout = '20s'");
    return tx.unsafe(`SELECT * FROM (${trimmed}) AS q LIMIT ${maxRows}`);
  });

  return { row_count: rows.length, truncated: rows.length >= maxRows, rows };
}

/* ---- writes: all delegated to the app, never done in SQL here -------------- */

async function confirmCostLink(a: Json) {
  const id = int(a.link_id, "link_id");
  await linkAction({ action: "confirm", link_id: id });
  return { confirmed: id, note: "the alias table was taught this match; it will resolve deterministically next time" };
}

async function rejectCostLink(a: Json) {
  const id = int(a.link_id, "link_id");
  await linkAction({ action: "reject", link_id: id });
  return { rejected: id, note: "kept as a negative label so the matcher stops proposing this pair" };
}

async function linkTransactionToMeal(a: Json) {
  const mealId = int(a.meal_id, "meal_id");
  const txId = str(a.transaction_id, "transaction_id");
  await linkAction({ action: "link_transaction", meal_id: mealId, transaction_id: txId });
  return { meal_id: mealId, transaction_id: txId, status: "confirmed" };
}

async function setManualMealCost(a: Json) {
  const mealId = int(a.meal_id, "meal_id");
  const amount = int(a.amount, "amount");
  if (amount <= 0) throw new ToolError("amount must be positive.");
  await linkAction({
    action: "manual_cost",
    meal_id: mealId,
    amount,
    note: str(a.note, "note", false) || null,
  });
  return { meal_id: mealId, amount, status: "confirmed" };
}

async function syncAndMatch(a: Json) {
  const days = Math.min(
    Number.isFinite(int(a.days, "days", false)) ? int(a.days, "days", false) : 45,
    730
  );
  const match = a.match !== false;
  const out = await triggerSync(days, match);
  return { ...out, note: "new links are PROPOSED, not accepted — review them with list_proposed_links" };
}

/* -------------------------------------------------------------------------- */

const IMPL: Record<string, (a: Json) => Promise<unknown>> = {
  get_cost_summary: getCostSummary,
  get_daily_costs: getDailyCosts,
  get_meal_cost: getMealCost,
  list_proposed_links: listProposedLinks,
  list_unattributed_meals: listUnattributedMeals,
  list_unattributed_spend: listUnattributedSpend,
  list_pantry_lots: listPantryLots,
  confirm_cost_link: confirmCostLink,
  reject_cost_link: rejectCostLink,
  link_transaction_to_meal: linkTransactionToMeal,
  set_manual_meal_cost: setManualMealCost,
  sync_and_match: syncAndMatch,
  describe_schema: describeSchema,
  run_sql: runSql,
};

export async function callTool(name: string, args: Json): Promise<unknown> {
  const fn = IMPL[name];
  if (!fn) throw new ToolError(`Unknown tool: ${name}`);
  return fn(args ?? {});
}
