# food cost

Traces what you ate back to what you paid for it. Meals come from **DAP Fitness**,
money comes from **DAP Finance**, and this app owns the links between them —
plus the visualizations and the MCP connector that let you interrogate them.

> Every cost figure ships with its coverage. A total drawn from 45 % attributed
> food is not a total, and this app never pretends otherwise.

## Why it's two problems, not one

Eating out and eating groceries are different reconciliation problems, and
conflating them is the main way this kind of system goes wrong.

| | Mechanism | How it's costed |
|---|---|---|
| **Ate out** | record linkage | one meal ≈ one card charge, scored on date proximity, merchant↔restaurant similarity, and how uniquely the pair fit |
| **Groceries** | FIFO inventory depletion | a receipt line becomes a **cost lot**; each meal entry draws grams from the oldest open lot of that food |

FIFO is not an invention here — it's the standard method for costing perishables
in restaurant accounting. See [`docs/RESEARCH.md`](docs/RESEARCH.md) §3.

## Architecture

```
dap_fitness ──┐                        ┌── /            overview + daily chart
   (meals)    │  HTTP, read-only       ├── /review      the matcher's proposals
              ├──▶  food_cost  ────────┤── /meals       diary with costs
dap_finance ──┘   mirrors + links      ├── /spend       money with nothing eaten attached
 (receipts)                            └── /pantry      FIFO lots and balances
                       │
                       └──▶ mcp/  ── remote MCP connector for Claude
```

All three databases live in the **same** Postgres instance, so a cross-database
join was physically available — and deliberately not used. An FDW would couple
three deploy cycles to one schema, with a column rename breaking this app at
runtime and no compile-time signal. HTTP gives a versioned, auditable seam; the
latency is paid once per sync rather than once per page view, because everything
lands in `mirror_*`.

## The pieces

| Path | What it is |
|---|---|
| `db/schema.sql` | The whole schema. Idempotent — re-running it *is* the migration |
| `src/lib/sync.ts` | Pulls both sources into the mirrors, derives pantry lots |
| `src/lib/match.ts` | The matcher: direct links, lot resolution, FIFO draws |
| `src/lib/actions.ts` | The only writer. Confirming teaches the alias table |
| `mcp/` | Remote MCP connector (OAuth + Streamable HTTP) |
| `docs/RESEARCH.md` | The evidence behind every design decision |
| `docs/DESIGN.md` | Visual direction, and what was rejected from it |

## The learning loop

Every confirmation writes a `food_alias` row: *this printed receipt text is this
food*. Every rejection writes a **negative** alias, without which the matcher
would re-propose the same wrong pair forever. After a few weeks the common
basket resolves deterministically and fuzzy matching only handles the tail — the
review queue should get shorter over time, not stay the same size.

## Local dev

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL + FOOD_COST_INTERNAL_SECRET
npm run db:push                # apply db/schema.sql
npm run sync                   # pull 45 days from both sources
npm run match                  # propose links
npm run dev
```

`FOOD_COST_INTERNAL_SECRET` must match the value set on **both** dap-finance and
dap-fitness. It is deliberately separate from those apps' `MCP_INTERNAL_SECRET`:
that one opens routes that write money, this one only reads.

## Scheduled

```
POST /api/cron/sync            # 45-day window, then match
POST /api/cron/sync?days=180   # wider backfill
POST /api/cron/sync?match=0    # mirror only
```
Guarded by `CRON_SECRET`. Per-source errors are reported rather than thrown — if
one source is down, mirroring the other is still worth doing, and `sync_run`
records what happened either way.

## MCP connector

```bash
cd mcp && npm install && npm run build && npm start
```

Needs `DATABASE_URL` (reads), `FOOD_COST_APP_URL` + `MCP_INTERNAL_SECRET`
(writes), `CRON_SECRET` (sync), and `MCP_PASSPHRASE` (the connector consent
page). Reads hit Postgres directly; **every write goes through the app's
`/api/internal/links`**, so the alias-teaching that rides along with a
confirm/reject has exactly one implementation.

Proposing and committing are separate tools by design: `list_proposed_links`
shows the matcher's reasoning, `confirm_cost_link` is the only thing that
finalizes one. No tool auto-accepts a low-confidence match.

Personal project. Not for redistribution.
