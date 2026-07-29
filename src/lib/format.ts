const SYMBOLS: Record<string, string> = { USD: "$", BRL: "R$", EUR: "€", GBP: "£" };

export function money(value: number | string | null | undefined, currency = "USD"): string {
  const n = typeof value === "string" ? parseFloat(value) : (value ?? 0);
  const sym = SYMBOLS[currency] ?? `${currency} `;
  return `${n < 0 ? "−" : ""}${sym}${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n || 0))}`;
}

export function pct(value: number | string | null | undefined, digits = 0): string {
  const n = typeof value === "string" ? parseFloat(value) : (value ?? 0);
  return `${(n * 100).toFixed(digits)}%`;
}

export function grams(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? parseFloat(value) : (value ?? 0);
  if (n >= 1000) return `${(n / 1000).toFixed(2)} kg`;
  return `${Math.round(n)} g`;
}

/**
 * Dates are formatted from the string, never through `new Date(...)`.
 *
 * `new Date("2026-07-20")` parses as UTC midnight and then renders in local
 * time, which west of Greenwich silently shows the 19th. A meal logged on the
 * 20th must say the 20th.
 */
export function day(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function dayLong(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function time(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.slice(0, 5).split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")}${suffix}`;
}

/** Canonical meal-type order. Chart stack order and table order must agree. */
export const MEAL_ORDER = ["breakfast", "lunch", "dinner", "snack"] as const;

export function mealVar(slug: string): string {
  const s = slug.toLowerCase();
  if (s.startsWith("break")) return "var(--series-breakfast)";
  if (s.startsWith("lunch")) return "var(--series-lunch)";
  if (s.startsWith("dinner")) return "var(--series-dinner)";
  return "var(--series-snack)";
}

/** Sort key that keeps anything unexpected after the four known types. */
export function mealRank(slug: string): number {
  const i = MEAL_ORDER.indexOf(slug.toLowerCase() as (typeof MEAL_ORDER)[number]);
  return i === -1 ? MEAL_ORDER.length : i;
}
