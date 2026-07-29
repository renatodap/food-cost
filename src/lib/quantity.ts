/**
 * Turning a printed receipt line into a quantity we can cost against.
 *
 * A receipt says one of three things, and the difference matters:
 *   "CHICKEN BREAST 2.34 LB"  → mass. Can cost a gram-denominated meal entry.
 *   "AVOCADO 4 EA"            → count. Cannot yield grams without inventing one.
 *   "PRODUCE"                 → neither. Not stockable.
 *
 * Guessing grams for a unit-basis line would be the single most tempting
 * dishonesty in this system — it would make coverage look better and every
 * number downstream would be fiction. So `unit` is a real outcome, not a
 * failure, and unit lots are costed per item.
 */

export type Basis = "mass" | "unit";

export interface ParsedQuantity {
  basis: Basis;
  /** grams, when basis === 'mass' */
  grams?: number;
  /** item count, when basis === 'unit' */
  units?: number;
  /** what in the text produced this, for the audit trail */
  matched: string | null;
}

const TO_GRAMS: Record<string, number> = {
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
  oz: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125,
  kg: 1000,
  kgs: 1000,
  kilo: 1000,
  kilos: 1000,
  kilogram: 1000,
  kilograms: 1000,
  g: 1,
  gr: 1,
  gram: 1,
  grams: 1,
  // Volume for water-like liquids only. 1 ml ≈ 1 g is wrong for oil and honey,
  // but the error is small next to portion-estimation error, and the
  // alternative — refusing to stock any liquid — is worse.
  ml: 1,
  l: 1000,
  liter: 1000,
  litre: 1000,
  liters: 1000,
  litres: 1000,
};

const MASS_RE = new RegExp(
  String.raw`(\d+(?:[.,]\d+)?)\s*(${Object.keys(TO_GRAMS).join("|")})\b`,
  "i"
);
const COUNT_RE = /(\d+(?:[.,]\d+)?)\s*(ea|each|ct|count|pk|pack)\b/i;

const toNumber = (s: string) => Number(s.replace(",", "."));

/**
 * Parse a quantity out of the receipt text, falling back to the structured
 * `quantity` column.
 *
 * `quantity` alone is ambiguous — 2.34 could be pounds or items — so the printed
 * text is consulted first, and the column is only trusted to mean "items" when
 * the text says nothing.
 */
export function parseQuantity(
  text: string | null | undefined,
  quantityColumn?: number | null
): ParsedQuantity {
  const hay = (text ?? "").trim();

  const mass = hay.match(MASS_RE);
  if (mass) {
    const value = toNumber(mass[1]);
    const unit = mass[2].toLowerCase();
    const grams = value * TO_GRAMS[unit];
    if (grams > 0 && Number.isFinite(grams)) {
      return { basis: "mass", grams, matched: mass[0] };
    }
  }

  const count = hay.match(COUNT_RE);
  if (count) {
    const units = toNumber(count[1]);
    if (units > 0 && Number.isFinite(units)) {
      return { basis: "unit", units, matched: count[0] };
    }
  }

  const q = quantityColumn ?? 1;
  return { basis: "unit", units: q > 0 ? q : 1, matched: null };
}

/** Tags that mean a receipt line is not something eaten. */
const NON_FOOD = new Set(["non-food", "household", "service"]);

/**
 * Is this line stockable as pantry inventory?
 *
 * Excludes non-food, and excludes the lines that are money-about-food rather
 * than food: tax, tips, fees, deposits. Those are real spend and stay attached
 * to the transaction — they simply cannot be drawn from in grams.
 */
export function isStockable(name: string, rawName: string | null, foodTags: string[]): boolean {
  if (foodTags.some((t) => NON_FOOD.has(t))) return false;
  const t = `${name} ${rawName ?? ""}`.toLowerCase();
  return !/\b(tax|tip|gratuity|service charge|delivery fee|bag fee|deposit|rounding|subtotal|total|change|discount|coupon)\b/.test(
    t
  );
}
