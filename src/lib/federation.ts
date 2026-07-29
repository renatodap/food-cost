/**
 * Typed clients for the two source apps' read-only food-cost surfaces.
 *
 * This is the versioned seam. Both databases sit in the same Postgres instance,
 * so a cross-database join was physically possible — and rejected. An FDW would
 * couple three deploy cycles to one schema: a column rename in dap-finance would
 * break this app at runtime with no compile-time signal. HTTP gives a contract
 * that can be checked, logged and evolved. The latency is paid once per sync,
 * not once per page view, because everything lands in `mirror_*`.
 *
 * See docs/RESEARCH.md §5.
 */

export interface FinanceTransaction {
  id: string;
  posted_date: string;
  amount: number;
  /** The food share: whole charge when wholly food, sum of food splits when mixed. */
  food_amount: number | null;
  currency: string;
  base_amount: number;
  merchant: string | null;
  description: string | null;
  kind: string;
  account: string | null;
  category: string | null;
  category_slug: string | null;
  is_split: boolean;
  has_receipt: boolean;
  reviewed: boolean;
}

export interface FinanceReceiptItem {
  id: string;
  name: string;
  raw_name: string | null;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  category: string | null;
  sort_order: number;
  food_tags: string[];
}

export interface FinanceReceipt {
  id: string;
  transaction_id: string | null;
  store: string | null;
  merchant_normalized: string | null;
  purchased_on: string | null;
  purchased_at: string | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  currency: string;
  status: string | null;
  reviewed: boolean;
  items: FinanceReceiptItem[];
}

export interface FitnessMealEntry {
  id: number;
  food_id: number | null;
  food_name: string;
  brand: string | null;
  restaurant: string | null;
  food_category: string | null;
  is_beverage: boolean;
  is_recipe: boolean;
  serving_g: number | null;
  quantity_g: number;
  energy_kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  order_index: number;
  entry_time: string | null;
}

export interface FitnessMeal {
  id: number;
  meal_date: string;
  meal_time: string | null;
  meal_type: string;
  meal_type_slug: string;
  note: string | null;
  photo_urls: string[];
  source: string | null;
  created_at: string | null;
  entries: FitnessMealEntry[];
}

class FederationError extends Error {
  constructor(
    readonly app: string,
    readonly status: number,
    body: string
  ) {
    super(`${app} responded ${status}: ${body.slice(0, 200)}`);
    this.name = "FederationError";
  }
}

async function get<T>(base: string, path: string, params: Record<string, string | undefined>): Promise<T> {
  const secret = process.env.FOOD_COST_INTERNAL_SECRET;
  if (!secret) throw new Error("FOOD_COST_INTERNAL_SECRET is not set — refusing to call unauthenticated");

  const url = new URL(base.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { "x-internal-secret": secret },
    // These are sync jobs, not page renders; a stale cached body would silently
    // make a sync a no-op.
    cache: "no-store",
  });
  if (!res.ok) throw new FederationError(base, res.status, await res.text());
  return (await res.json()) as T;
}

function financeBase(): string {
  const b = process.env.FINANCE_API_URL;
  if (!b) throw new Error("FINANCE_API_URL is not set");
  return b;
}

function fitnessBase(): string {
  const b = process.env.FITNESS_API_URL;
  if (!b) throw new Error("FITNESS_API_URL is not set");
  return b;
}

export async function fetchTransactions(since: string, until?: string) {
  return get<{ count: number; transactions: FinanceTransaction[] }>(
    financeBase(),
    "/api/internal/food-cost/transactions",
    { since, until }
  );
}

export async function fetchReceipts(since: string, until?: string) {
  return get<{ count: number; receipts: FinanceReceipt[] }>(
    financeBase(),
    "/api/internal/food-cost/receipts",
    { since, until }
  );
}

export async function fetchMeals(since: string, until?: string) {
  return get<{ count: number; meals: FitnessMeal[] }>(
    fitnessBase(),
    "/api/internal/food-cost/meals",
    { since, until }
  );
}
