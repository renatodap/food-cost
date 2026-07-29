# Design

Mode: **Operate**. This is a tool you use, not a page you're persuaded by. The
bar is earned familiarity — it should disappear into the task.

## The design read

Four directions were generated with GPT Image 2 (`docs/inspiration/`, produced by
`scripts/gen-inspiration.sh`). The build is a synthesis of two of them, and
explicitly rejects parts of both.

**Taken from `receipt-paper`:**
- The ledger line as the primary content structure — label, dot leaders,
  right-aligned figure. It is the correct shape for this data and it is what a
  receipt already looks like.
- Dashed hairlines as section rules, reading as perforations.
- Warm paper, ink type, a single accent. Restraint as the default.
- Tabular monospace figures, right-aligned, so columns of money line up
  digit-for-digit.

**Taken from `dark-editorial`:**
- The three-column honesty of `total cost · known · coverage` in the meal table.
  That triplet is the whole product in one row.
- Persistent left nav; date range control top-right.

**Rejected from both**, per the craft floor:
- The row of KPI tiles (`dark-editorial` has five). The hero-metric template is a
  refused scaffold, and here it would be actively dishonest — a big `$1,254.68`
  with no coverage attached is the exact lie this app exists to stop telling.
  The opening is a sentence and a chart instead.
- Progress rings standing in for content. Coverage is a labeled meter with a
  number next to it, which is both readable and not decoration.
- `dark-editorial`'s monochrome orange ramp. Four series in one hue at four
  lightnesses would fail CVD separation outright.
- All-caps letterspaced labels on every section. One kicker is a system; an
  eyebrow everywhere is grammar you didn't choose.
- The "APPROVED" stamp from `receipt-paper`. Charming, but decoration — unless it
  earns a real state, which it does not here.

## Type

One family, two voices: **IBM Plex Sans** for the interface, **IBM Plex Mono**
for money, weights, dates and receipt lines. Mono here is data and measurement —
the sanctioned use — never a costume for "technical".

Fixed rem scale, ratio ≈1.15. Not fluid: this is read at a consistent DPI, and a
`clamp()`ed heading that shrinks inside a panel looks worse, not better.

## Color

Restrained. Hue is spent on data, never on decoration.

- **Primary action is solid ink**, not a colored button. Color in this app means
  "this is a meal type" or "this is a state"; a blue Save button would make the
  reader parse blue two ways.
- **Meal types** use slots 1–4 of a validated categorical palette. The ordering
  is the CVD-safety mechanism, not cosmetics.
- **Unattributed** is deliberately not a fifth hue. It is not a meal type, it is
  a hole in our knowledge, and it renders as neutral + a 45° hatch — a texture,
  so it survives greyscale and forced-colors.
- **Status** (good / warn / bad) is reserved and always ships with a label.

The palette was validated with the dataviz skill's script against this app's
actual surfaces, not eyeballed:

```
node scripts/validate_palette.js "#2a78d6,#eb6834,#1baf7a,#eda100" --mode light --surface "#FAF8F4"
node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500" --mode dark  --surface "#121110"
```

Both pass every gate. The first attempt — an eyeballed warm set of amber / sage /
steel / mauve — failed on chroma floor and on normal-vision separation between
mauve and steel. Re-run the validator before changing any of these hexes.

Light mode carries a contrast WARN on aqua and yellow (2.65:1 and 2.04:1 against
warm paper). That is not dismissable: it obligates relief, shipped as direct
labels on the legend **and** the meal-type table. Both are present.

## The honesty rule

Every cost figure ships with its coverage, at every grain. A "Dinner: $14.20"
computed from 40 % attributed entries is a lie by omission. Coverage travels with
cost through `v_meal_cost`, `v_daily_meal_cost`, and every component that renders
either. There is no view in this app that shows a cost without showing how much
of it is known.

This is the central constraint. If a future change makes it easy to render a cost
without its coverage, that change is wrong.

## Motion

150–250 ms, and only to convey state: row hover, link confirm/reject settling,
panel open. No orchestrated page-load sequence — this loads into a task.
`prefers-reduced-motion` is honored globally.
