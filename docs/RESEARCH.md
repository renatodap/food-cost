# Research — Food-cost reconciliation

Deep research conducted 2026-07-28, before any code was written. This is the
evidence base for every design decision in [`DESIGN.md`](./DESIGN.md); when the
schema does something non-obvious, the reason is in here.

---

## Summary

Linking "what I ate" to "what I paid" is **two different problems wearing one
coat**, and the single biggest design mistake would be to model them as one.
Eating out is a *record linkage* problem — one meal, one charge, near-1:1, solved
with temporal + merchant + amount scoring. Eating groceries is an *inventory
depletion* problem — one receipt line feeds N meals across M days, solved with
FIFO cost lots, which is exactly how the restaurant industry has costed
perishables for decades. A system that only does the first covers restaurant
spend and silently reports `$0` for everything cooked at home; a system that
pretends the second is a matching problem produces confident nonsense. The
correct architecture keeps both, tags every attribution with a confidence and a
provenance, auto-confirms only the top band, and routes the rest to a human —
the consensus pattern across every reconciliation system surveyed.

---

## Sub-questions investigated

1. Entity resolution / record linkage — how to match a receipt line to a food item
2. Text normalization — receipt abbreviations, OCR noise, `pg_trgm` mechanics
3. Cost attribution — allocating a bulk grocery purchase to individual meals
4. Reconciliation data modelling — link tables, match status, human review
5. Cross-app data federation — API design when three DBs share one instance
6. MCP server patterns — tool design for a reconciliation workflow
7. Prior art — what existing food-budget products actually do

---

## Key findings

### 1. Record linkage: fuzzy matching is a *scored candidate* problem, not a lookup

Record linkage (a.k.a. data matching, entity resolution) is the task of finding
records that refer to the same entity across sources without a shared key
([Wikipedia](https://en.wikipedia.org/wiki/Record_linkage)). The standard
algorithm family is Jaro-Winkler, Levenshtein, Soundex and token matching, with
**probabilistic record linkage** assigning statistical weights to each field's
discriminatory power ([Data Ladder](https://dataladder.com/fuzzy-matching-101/),
[MatchDataPro](https://matchdatapro.com/fuzzy-data-matching-and-entity-resolution/)).
Retail product-catalog reconciliation is called out explicitly as a canonical
application — which is precisely "receipt line → food item".

**Confidence: High** (4+ independent sources agree).

The operational consequence, stated most directly by
[Dataiku](https://www.dataiku.com/stories/blog/accelerating-entity-resolution)
and [Google Cloud's Enterprise Knowledge Graph](https://docs.cloud.google.com/enterprise-knowledge-graph/docs/confidence-score):
**high-confidence matches are auto-reconciled; uncertain ones are flagged for
human review.** Confidence is not decoration — it is the routing key. Google
models the score as a clustering confidence; the schema-matching literature
([PoWareMatch, arXiv](https://arxiv.org/pdf/2109.07321)) uses a `(-1, +1)` range
where `-1` is definitely-not, `+1` is definitely-yes and `0` is total
uncertainty.

Critically, [Matchmaker (arXiv)](https://arxiv.org/pdf/2410.24105) notes that a
matcher must be able to **abstain** — "sometimes no suitable match exists, which
requires the system to abstain from making a match". A matcher with no null
option will confidently mislabel.

> **Design consequence.** `link_candidate` stores a score and a per-signal
> breakdown; `cost_link.status` is a lifecycle, not a boolean; nothing below the
> floor threshold is ever written. See `DESIGN.md` §Matching.

### 2. Text normalization: cheap wins before expensive fuzz

`pg_trgm` breaks strings into overlapping 3-character sequences and scores
similarity by shared trigrams
([PostgreSQL docs](https://www.postgresql.org/docs/current/pgtrgm.html)). The
mechanics that matter:

| Thing | Value |
|---|---|
| `similarity(a,b)` | 0..1, whole-string |
| `word_similarity(a,b)` | best score against any *continuous extent* of b |
| `strict_word_similarity(a,b)` | same, but extents must respect word boundaries |
| `%` operator threshold | `pg_trgm.similarity_threshold`, default **0.3** |
| `<%` threshold | `pg_trgm.word_similarity_threshold`, default **0.6** |
| GIN `gin_trgm_ops` | supports similarity, `LIKE`, `ILIKE`, regex — **not** efficient `ORDER BY <->` |
| GiST `gist_trgm_ops` | supports efficient `ORDER BY distance LIMIT n` |

`word_similarity` is the right function here, not `similarity`: a receipt line
`"GV CHKN BRST BNLS 2.34LB"` against a food item `"Chicken Breast"` scores
terribly on whole-string similarity and well on word similarity, because the
food name is a *substring-ish extent* of the noisy receipt text.

Practitioner sources converge on normalizing first —
lowercase, trim, strip punctuation — because it "catches a large share of
duplicate variants without fuzzy logic doing any work at all… cheap wins before
the expensive trigram comparison even runs"
([Towards Data Science](https://towardsdatascience.com/postgres-fuzzy-search-with-pg-trgm-smart-database-guesses-what-you-want-and-returns-cat-food-4b174d9bede8/),
[Medium/techybob](https://medium.com/@techybob/fuzzy-matching-in-postgresql-taming-messy-text-with-pg-trgm-bc3af9335f2f)).
Threshold guidance: default 0.3 is loose; **0.5 for near-exact needs like product
codes and names**. And `pg_trgm` without a GIN index "quietly becomes a
performance problem the moment the comparison set grows" — relevant here, since
`food_item` has **406,235 rows**.

The strongest recommendation is to combine tools: `pg_trgm` for broad candidate
generation at scale, then `fuzzystrmatch` edit-distance for precision on the
narrowed set.

**Confidence: High** (official docs + 4 practitioner sources).

> **Design consequence.** A `normalize_food_text()` SQL function, a GIN trigram
> index on it, `word_similarity` for candidate generation with a 0.35 floor, and
> a learned `food_alias` table so a confirmed match never has to be fuzzy-matched
> twice.

### 3. Cost attribution: FIFO, because that's how food actually moves

This is where the naive approaches break. The searched consumer products
(MealCost, GroceryTracker Pro) acknowledge the problem exactly — "ingredients get
reused, leftovers stretch across days, and dining out gets mixed in with home
cooking" ([MealCost](https://www.mealcostapp.com/)) — but the published methods
are just *divide total spend by meal count*
([Quora](https://www.quora.com/How-do-I-calculate-food-cost-per-month),
[Grocery Budget Calculator](https://ai-mealplan.com/grocery-budget-calculator)).
That's an average, not an attribution; it can't answer "what did *this* dinner
cost".

The real method comes from restaurant accounting:

- **Plate cost** = Σ (ingredient quantity × ingredient unit cost). Per-serving
  costing "delivers more details about the profitability of every dish and the
  feasibility of current portion sizes"
  ([Lightspeed](https://www.lightspeedhq.com/blog/how-to-calculate-restaurant-food-costs/),
  [meez](https://www.getmeez.com/blog/5-things-to-know-about-food-costing)).
- **FIFO** is the standard for food: "you use and cost your oldest stock first,
  and it matches how perishable food should actually be rotated, so it's the
  standard for restaurants and food businesses"
  ([Tenzo](https://www.gotenzo.com/resources/insight/the-essential-guide-to-restaurant-inventory-costing-all-3-techniques-explained/),
  [DishTrack](https://dishtrack.app/blog/food-costing-methods)).
- The period formula `(Beginning inventory + Purchases − Ending inventory) ÷ Sales`
  is the *reconciliation check*, not the attribution mechanism
  ([Restaurant365](https://www.restaurant365.com/blog/food-cost-guide/),
  [Toast](https://pos.toasttab.com/blog/on-the-line/how-to-calculate-food-cost-percentage)).

**Confidence: High** for FIFO-as-standard (5 sources). **Medium** for applying
restaurant costing to a single person's pantry — no source does this directly;
it is my synthesis, and the analogy is sound because the mechanics (perishable
stock, portions drawn over time, cost basis per unit) are identical.

> **Design consequence.** `pantry_lot` is a FIFO cost lot created from a grocery
> receipt line; a meal entry draws grams from the oldest open lot of that food.
> Lot balance is a **view computed from confirmed draws**, never a mutable
> column — a stored balance drifts the first time a link is rejected.

A second consequence: receipts price things by mass (`2.34 LB`), by count
(`4 EA`) or by neither. So a lot carries a `basis` of `mass` or `unit`, and
mass-basis lots are the only ones that can cost a gram-denominated meal entry
precisely. Pretending a `unit`-basis lot yields grams would be invention.

### 4. Reconciliation modelling: status lifecycle + exception routing

Cross-system reconciliation architecture converges on a consistent shape
([arXiv 2604.15108](https://arxiv.org/pdf/2604.15108),
[Salesforce Data 360](https://architect.salesforce.com/docs/architect/fundamentals/guide/data360_integration_patterns_and_practices),
[Nexla](https://nexla.com/data-integration-techniques/data-federation/)):

- **reconciliation link tables** joining entities across domains, carrying match
  criteria and a status flag;
- **exception tables** for unmatched records — the unmatched set is a
  first-class output, not an absence;
- a **Master Key Strategy**: "prefer consistent business identifiers (external
  IDs) so downstream reconciliation and upserts are deterministic";
- **audit**: every ingestion job logged for traceability.

A representative status enum from the literature:
`PENDING_REVIEW, AUTO_MATCHED, MANUAL_APPROVED, REJECTED, EXCEPTION`.

**Confidence: High** on the shape; **Medium** on specific enum labels (the PDF
of arXiv 2604.15108 could not be parsed — see Open Questions).

> **Design consequence.** `cost_link.status ∈ (proposed, confirmed, rejected,
> superseded)` with `origin ∈ (auto, mcp, user)` and a nullable `reviewed_at`.
> The nullable-`reviewed_at`-means-unconfirmed idiom is **already the house
> pattern** in both source apps (`transactions.reviewed_at`,
> `receipts.reviewed_at`, both documented as "NULL until a human confirms…
> machine paths must never set this"). Matching it is free consistency.

### 5. Federation: HTTP over FDW, mirror for speed

All three databases live in the *same* Postgres container
(`shared-postgres`, one instance, one DB per app — deliberate, to avoid N
Postgres processes each paying baseline memory on a small box). So
`postgres_fdw` or `dblink` is physically available.

It is still the wrong choice here. Federation guidance describes the
**Proxy Gateway Pattern** — "a single gateway that routes and orchestrates
queries, used when central control and auditing are required" — and the
**Pushdown-First Pattern** for minimizing transferred data
([DataOps School](https://dataopsschool.com/blog/data-federation/),
[Fivetran](https://www.fivetran.com/learn/data-federation)). A federation
pipeline is: *request → authn → authz → planning → execution → merge → response
→ audit log persisted*.

Cross-DB SQL would couple three deploy cycles to one schema: any column rename in
`dap_finance` silently breaks `food_cost` at runtime, with no compile-time signal
and no version boundary. An HTTP contract gives a typed, versioned, auditable
seam — and it is what was asked for. The cost is latency, paid once at sync time
rather than per query, because the mirror tables absorb it.

**Confidence: High** on the pattern; the tradeoff call is a judgement, flagged as
such.

> **Design consequence.** Read-only `/api/internal/food-cost/*` endpoints in both
> apps, bearer-authenticated with the existing `MCP_INTERNAL_SECRET` idiom
> already present in `dap-finance` (`src/lib/internal-auth.ts`). Cursor-based
> incremental pull into `mirror_*` tables. Every sync writes a `sync_run` row.

### 6. MCP: annotations, flat schemas, confirm-before-write

From the [2026 MCP tool schema guide](https://kansei-link.com/en/insights/mcp-tool-schema-design-guide-2026.html)
— "MCP server quality is decided 80% by tool schema":

1. **verb_object naming**, one convention per server (`propose_links`, not `links`)
2. **descriptions state what + when to use**, 1–3 sentences
3. **flat inputSchema** — nesting inflates tokens and parse failures
4. **all four annotations set explicitly** — `readOnlyHint`, `destructiveHint`,
   `idempotentHint`, `openWorldHint`. Missing annotations are cited as a cause of
   "30% of Claude Connector Directory rejections"
5. **errors inside the result** (`isError: true`), not as protocol errors, so the
   model can read and recover
6. **large payloads by URI**, not inlined
7. **server-side validation** — the schema is not the enforcement boundary

On human-in-the-loop, the pattern for 2026 is "autonomous execution for routine
tasks, human oversight for high-stakes decisions… the agent prepares an action
and pauses before executing"
([Toloka](https://toloka.ai/blog/human-in-the-loop-for-ai-agents-why-mcp-servers-need-human-expertise/),
[Cloudflare Agents](https://developers.cloudflare.com/agents/concepts/human-in-the-loop/)).
The spec now has **elicitation** (server pauses mid-call for structured user
input, result carries `accept`/`decline`/`cancel`)
([WorkOS](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026)).

**Confidence: High** on tool-design principles; **Medium** on elicitation client
support being universal — safer to design tools that work *without* it.

> **Design consequence.** The MCP server splits proposal from commitment:
> `propose_meal_cost_links` is read-only and returns scored candidates;
> `confirm_cost_link` is the only writer. No tool auto-confirms a low-confidence
> match. This does not depend on elicitation being supported — the pause is
> structural, in the tool split itself.

### 7. Prior art: nobody does the hard half

[GroceryTracker Pro](https://grocery-tracker-pro.com/food-budget-app/) "connects
scanned receipts to eating patterns, showing the cost-per-meal of usual recipes"
and answers questions like "what's my cost-per-meal if I cook three pasta dinners
a week?". [SummitPlate](https://www.summitplate.com/meal-planning-app-with-grocery-budgeting)
does budget-aware meal *planning*. [Groceries Tracker](https://groceriestracker.com/)
does receipt itemization and category breakdowns.

All of them run **forward** — plan a recipe, estimate its cost. None run
**backward** from an actual logged food diary to actual bank transactions. That
backward direction is the whole point here, and it is only possible because both
halves of the data already exist and are already itemized:
`dap_finance.receipt_items` (with a food-tag taxonomy already attached) and
`dap_fitness.meal_entry` (1,922 rows, gram-denominated, against a 406k-row food
library).

**Confidence: Medium** — absence of evidence from a web search is weak evidence
of absence.

---

## Analysis

Three things fall out of the findings taken together.

**The data is already better than the products.** `dap_finance` doesn't just have
transactions — it has `receipt_items` with `raw_name` (as printed) *and*
`normalized_name` *and* a many-to-many `item_tags` food taxonomy already applied
per line. `dap_fitness` doesn't just have meals — it has `meal_entry` rows in
grams referencing a food library with per-100g macros. The join key that
commercial apps lack (itemized both sides, normalized both sides) is already
present. This is why the ambitious version is feasible at all.

**Coverage is the metric that keeps the system honest.** Every attribution
mechanism here is partial: some meals have no receipt, some receipt lines never
resolve to a food, some lots are unit-basis. A dashboard that renders
"Dinner: $14.20" from 40% attributed entries is lying by omission. So coverage
travels *with* every cost number, at every grain — meal, day, meal-type, month.
This is the single most important honesty constraint in the design, and it comes
straight from the confidence-routing literature: a score you don't surface is a
score you've thrown away.

**The learning loop is the difference between a demo and a tool.** Fuzzy matching
alone has a fixed ceiling on messy retail text. But every human confirmation is a
labelled example — `"GV CHKN BRST BNLS"` → `food_item 12345` — and `dap_finance`
already proves the pattern works with `merchant_rules` carrying
`origin ∈ (seed, learned)` and a `hits` counter. `food_alias` is the same idea
one level down. After a few weeks of confirmations, the common basket resolves
deterministically and fuzzy matching handles only the tail. The system gets
quieter over time, which is the correct direction for a review queue.

---

## Confidence assessment

| Finding | Confidence | Basis |
|---|---|---|
| Fuzzy matching = scored candidates + human review routing | High | 6 sources agree (Data Ladder, Dataiku, Google Cloud, PoWareMatch, Matchmaker, MatchDataPro) |
| `pg_trgm` mechanics, thresholds, index tradeoffs | High | Official PostgreSQL docs + 4 practitioner sources |
| Normalize before fuzzing | High | 3 sources, no dissent |
| FIFO is standard for perishable food costing | High | 5 industry sources (Tenzo, DishTrack, Restaurant365, Toast, Lightspeed) |
| Plate cost = Σ(qty × unit cost) | High | 4 sources |
| Applying restaurant FIFO to a personal pantry | Medium | Synthesis — no source does this; mechanics are identical, analogy is mine |
| Reconciliation link tables + status + exception routing | High | arXiv + Salesforce + Nexla converge on shape |
| Specific status enum labels | Medium | One partially-readable source; adapted to the house pattern instead |
| HTTP federation preferable to FDW here | Medium | Pattern is well-sourced; the tradeoff call is a judgement |
| MCP tool-schema principles | High | Dedicated 2026 guide + AWS Prescriptive Guidance + spec blog |
| MCP elicitation universally supported | Low | Spec'd and documented, client support unverified — designed around it |
| No existing product does backward attribution | Medium | Negative result from search; can't prove absence |

---

## Open questions

- **arXiv 2604.15108 could not be parsed** (binary PDF stream). Its GERA
  framework and specific status enums would have firmed up the Medium-confidence
  modelling finding. The design instead follows the house `reviewed_at` idiom,
  which is better for this codebase anyway.
- **Portion-to-mass conversion for unit-basis receipt lines.** "4 EA AVOCADO
  $5.16" has no grams. `food_portion` (408,955 rows) in `dap_fitness` may carry
  per-unit gram weights that could bridge this. Not verified; the design degrades
  honestly to unit-basis rather than guessing.
- **Shared/household consumption.** If food is cooked for two people, the eater's
  share ≠ the purchase. Out of scope for a single-user system, but the schema
  should not make it impossible to add a share factor later.
- **Waste.** Food bought and thrown out never appears in a meal. Lots that expire
  with a remaining balance are real spend attributable to no meal — the residual
  is a genuine signal (spoilage), not an error. Worth surfacing, not solving now.
- **Empirical threshold tuning.** The 0.85 auto-confirm / 0.50 propose bands are
  reasoned from the literature's defaults, not calibrated on this data. They are
  config, not constants, and should be tuned after the first few hundred reviews.

---

## Sources

**Entity resolution / record linkage**
- [Record linkage — Wikipedia](https://en.wikipedia.org/wiki/Record_linkage)
- [Fuzzy Matching 101 — Data Ladder](https://dataladder.com/fuzzy-matching-101/)
- [Fuzzy Data Matching and Entity Resolution — MatchDataPro](https://matchdatapro.com/fuzzy-data-matching-and-entity-resolution/)
- [Accelerating entity resolution with automation and human validation — Dataiku](https://www.dataiku.com/stories/blog/accelerating-entity-resolution)
- [Understand reconciliation confidence score — Google Cloud](https://docs.cloud.google.com/enterprise-knowledge-graph/docs/confidence-score)
- [PoWareMatch: Quality-aware Deep Learning for Human Schema Matching — arXiv](https://arxiv.org/pdf/2109.07321)
- [Matchmaker: Self-Improving LLM Programs for Schema Matching — arXiv](https://arxiv.org/pdf/2410.24105)
- [Entity Resolution — Towards Data Science](https://towardsdatascience.com/entity-resolution-identifying-real-world-entities-in-noisy-data-3e8c59f4f41c/)

**Postgres fuzzy text**
- [pg_trgm — PostgreSQL 18 documentation](https://www.postgresql.org/docs/current/pgtrgm.html)
- [Postgres Fuzzy Search With pg_trgm — Towards Data Science](https://towardsdatascience.com/postgres-fuzzy-search-with-pg-trgm-smart-database-guesses-what-you-want-and-returns-cat-food-4b174d9bede8/)
- [Fuzzy Matching in PostgreSQL: Taming Messy Text — Medium](https://medium.com/@techybob/fuzzy-matching-in-postgresql-taming-messy-text-with-pg-trgm-bc3af9335f2f)
- [Fuzzy Text Search in PostgreSQL: How Trigrams Work — DEV](https://dev.to/dhananjayharidas/fuzzy-text-search-in-postgresql-how-trigrams-make-computers-almost-right-2hmk)
- [pg_trgm — Nile Documentation](https://www.thenile.dev/docs/extensions/pg_trgm)

**Food costing / FIFO**
- [Restaurant Inventory Costing: 3 techniques — Tenzo](https://www.gotenzo.com/resources/insight/the-essential-guide-to-restaurant-inventory-costing-all-3-techniques-explained/)
- [Food Costing Methods Explained — DishTrack](https://dishtrack.app/blog/food-costing-methods)
- [Food Cost Guide: Formula & Benchmarks — Restaurant365](https://www.restaurant365.com/blog/food-cost-guide/)
- [How to Calculate Food Cost Percentage — Toast](https://pos.toasttab.com/blog/on-the-line/how-to-calculate-food-cost-percentage)
- [How to Calculate Restaurant Food Costs — Lightspeed](https://www.lightspeedhq.com/blog/how-to-calculate-restaurant-food-costs/)
- [5 Things to Know About Food Costing — meez](https://www.getmeez.com/blog/5-things-to-know-about-food-costing)
- [Calculating Food Cost — The Culinary Pro](https://www.theculinarypro.com/calculating-food-cost)

**Reconciliation & federation architecture**
- [Data Engineering Patterns for Cross-System Reconciliation — arXiv](https://arxiv.org/pdf/2604.15108)
- [Data 360 Integration Patterns — Salesforce Architects](https://architect.salesforce.com/docs/architect/fundamentals/guide/data360_integration_patterns_and_practices)
- [What is Data Federation? — DataOps School](https://dataopsschool.com/blog/data-federation/)
- [Data Federation: Key Concepts & Best Practices — Nexla](https://nexla.com/data-integration-techniques/data-federation/)
- [What is data federation? — Fivetran](https://www.fivetran.com/learn/data-federation)
- [Reconciling — OpenRefine](https://openrefine.org/docs/manual/reconciling)

**MCP**
- [MCP Tool Schema Design Guide 2026 — KanseiLink](https://kansei-link.com/en/insights/mcp-tool-schema-design-guide-2026.html)
- [MCP tool design strategy — AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/mcp-strategies/mcp-tool-strategy.html)
- [Everything your team needs to know about MCP in 2026 — WorkOS](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026)
- [Human-in-the-loop for AI agents — Toloka](https://toloka.ai/blog/human-in-the-loop-for-ai-agents-why-mcp-servers-need-human-expertise/)
- [Human in the Loop — Cloudflare Agents](https://developers.cloudflare.com/agents/concepts/human-in-the-loop/)
- [Building Long-Running MCP Tools with Human-in-the-Loop — Temporal](https://learn.temporal.io/tutorials/ai/building-mcp-tools-with-temporal/adding-hitl-to-mcp-tools/)
- [The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)

**Prior art**
- [GroceryTracker Pro — Food Budget App](https://grocery-tracker-pro.com/food-budget-app/)
- [MealCost — Track the Cost of Meals](https://www.mealcostapp.com/)
- [SummitPlate — Meal Planning with Grocery Budgeting](https://www.summitplate.com/meal-planning-app-with-grocery-budgeting)
- [Groceries Tracker](https://groceriestracker.com/)
