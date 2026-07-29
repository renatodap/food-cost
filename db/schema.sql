-- ============================================================================
-- food_cost — reconciliation ledger linking meals (dap_fitness) to money
--             (dap_finance).
--
-- Idempotent: safe to re-run. Every object is CREATE ... IF NOT EXISTS or
-- guarded by a DO block.
--
-- Three databases live in ONE Postgres instance (Persimmon shared-postgres),
-- but this schema NEVER reaches across into them. Source rows arrive over HTTP
-- and land in `mirror_*`. See docs/DESIGN.md for why (versioned seam, decoupled
-- deploys) and docs/RESEARCH.md §5 for the federation evidence.
--
-- The two attribution mechanisms, which are genuinely different problems:
--   1. DIRECT   — one restaurant meal ≈ one card charge. Record linkage.
--   2. PANTRY   — one grocery line feeds N meals over M days. FIFO depletion.
-- Conflating them is the main way this kind of system goes wrong.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE link_method AS ENUM (
    'direct_transaction',  -- whole meal <- whole charge (ate out)
    'receipt_line',        -- one entry <- one receipt line, consumed whole
    'pantry_draw',         -- one entry <- grams drawn from a FIFO lot
    'manual_amount'        -- human typed a number; no source row to point at
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- 'superseded' exists so re-running the matcher never destroys history: the
  -- old row is closed out, not deleted. Rejections are equally durable — a
  -- rejected link is a negative label the matcher must not re-propose.
  CREATE TYPE link_status AS ENUM ('proposed', 'confirmed', 'rejected', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE link_origin AS ENUM ('auto', 'mcp', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- A receipt prices things by weight ("2.34 LB") or by count ("4 EA").
  -- Only mass-basis lots can cost a gram-denominated meal entry honestly;
  -- unit-basis lots are costed per-item and never pretend to know grams.
  CREATE TYPE lot_basis AS ENUM ('mass', 'unit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sync_source AS ENUM ('finance', 'fitness');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sync_status AS ENUM ('running', 'ok', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- text normalization
--
-- The cheap win that runs before any fuzzy comparison (RESEARCH.md §2).
-- Lowercase, strip the unit/pack noise that supermarket printers emit, collapse
-- punctuation and whitespace. IMMUTABLE so it can back an expression index.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_food_text(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            lower(coalesce(raw, '')),
            -- weights, volumes, counts and pack sizes: "2.34LB", "12 OZ", "4CT", "1L"
            '\m[0-9]+([.,][0-9]+)?\s*(lbs?|oz|kg|kgs|g|gr|grams?|ml|l|ct|pk|pack|ea|each|x)\M',
            ' ', 'g'),
          -- bare price-ish / SKU-ish numbers and any punctuation
          '[^a-z ]+', ' ', 'g'),
        '\s+', ' ', 'g')
    ),
  '');
$$;

COMMENT ON FUNCTION normalize_food_text(text) IS
  'Lowercases and strips unit/pack/SKU noise from receipt and food text. IMMUTABLE so trigram indexes can be built on it.';

-- ---------------------------------------------------------------------------
-- sync_run — every federated pull is auditable (RESEARCH.md §5)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_run (
  id            bigserial PRIMARY KEY,
  source        sync_source NOT NULL,
  status        sync_status NOT NULL DEFAULT 'running',
  since_date    date,
  until_date    date,
  rows_fetched  integer NOT NULL DEFAULT 0,
  rows_upserted integer NOT NULL DEFAULT 0,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS sync_run_source_idx ON sync_run (source, started_at DESC);

-- ===========================================================================
-- MIRRORS — read-only local copies of source-of-truth rows.
--
-- Never edited by this app. `synced_at` is the only column we own. Native id
-- types are preserved (finance = uuid, fitness = bigint) so a row here is
-- trivially traceable back to its origin.
-- ===========================================================================

-- ---- from dap_fitness ------------------------------------------------------
CREATE TABLE IF NOT EXISTS mirror_food_item (
  id             bigint PRIMARY KEY,
  name           text NOT NULL,
  brand          text,
  restaurant     text,
  food_category  text,
  is_beverage    boolean NOT NULL DEFAULT false,
  is_recipe      boolean NOT NULL DEFAULT false,
  serving_g      numeric(12,3),
  energy_kcal    numeric(12,3),
  synced_at      timestamptz NOT NULL DEFAULT now()
);
-- Candidate generation runs word_similarity over this; 406k rows in the source
-- library means the GIN index is not optional (RESEARCH.md §2).
CREATE INDEX IF NOT EXISTS mirror_food_item_norm_trgm
  ON mirror_food_item USING GIN (normalize_food_text(name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS mirror_food_item_restaurant_idx
  ON mirror_food_item (restaurant) WHERE restaurant IS NOT NULL;

CREATE TABLE IF NOT EXISTS mirror_meal (
  id             bigint PRIMARY KEY,
  meal_date      date NOT NULL,
  meal_time      time,
  meal_type      text NOT NULL,         -- 'Breakfast' | 'Lunch' | ... (denormalized label)
  meal_type_slug text NOT NULL,
  note           text,
  photo_urls     text[] NOT NULL DEFAULT '{}',
  source         text,
  created_at     timestamptz,
  synced_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mirror_meal_date_idx ON mirror_meal (meal_date DESC);
CREATE INDEX IF NOT EXISTS mirror_meal_type_idx ON mirror_meal (meal_type_slug, meal_date DESC);

CREATE TABLE IF NOT EXISTS mirror_meal_entry (
  id           bigint PRIMARY KEY,
  meal_id      bigint NOT NULL REFERENCES mirror_meal (id) ON DELETE CASCADE,
  food_id      bigint,
  food_name    text NOT NULL,           -- denormalized: survives a food_item rename
  brand        text,
  restaurant   text,
  quantity_g   numeric(12,3) NOT NULL,
  energy_kcal  numeric(12,3),
  protein_g    numeric(12,3),
  carbs_g      numeric(12,3),
  fat_g        numeric(12,3),
  order_index  integer NOT NULL DEFAULT 0,
  entry_time   time,
  synced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mirror_meal_entry_meal_idx ON mirror_meal_entry (meal_id);
CREATE INDEX IF NOT EXISTS mirror_meal_entry_food_idx ON mirror_meal_entry (food_id);
CREATE INDEX IF NOT EXISTS mirror_meal_entry_name_trgm
  ON mirror_meal_entry USING GIN (normalize_food_text(food_name) gin_trgm_ops);

-- ---- from dap_finance ------------------------------------------------------
CREATE TABLE IF NOT EXISTS mirror_transaction (
  id            uuid PRIMARY KEY,
  posted_date   date NOT NULL,
  amount        numeric(14,2) NOT NULL,   -- signed; negative = outflow
  currency      char(3) NOT NULL DEFAULT 'USD',
  merchant      text,
  description   text,
  kind          text NOT NULL DEFAULT 'expense',
  account_name  text,
  category_name text,
  category_slug text,
  is_food       boolean NOT NULL DEFAULT false,  -- source decided this, not us
  is_split      boolean NOT NULL DEFAULT false,
  has_receipt   boolean NOT NULL DEFAULT false,
  reviewed      boolean NOT NULL DEFAULT false,
  synced_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mirror_transaction_date_idx ON mirror_transaction (posted_date DESC);
CREATE INDEX IF NOT EXISTS mirror_transaction_food_idx ON mirror_transaction (posted_date DESC) WHERE is_food;
CREATE INDEX IF NOT EXISTS mirror_transaction_merchant_trgm
  ON mirror_transaction USING GIN (normalize_food_text(merchant) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS mirror_receipt (
  id             uuid PRIMARY KEY,
  transaction_id uuid REFERENCES mirror_transaction (id) ON DELETE SET NULL,
  store          text,
  purchased_on   date,
  purchased_at   timestamptz,
  subtotal       numeric(14,2),
  tax            numeric(14,2),
  tip            numeric(14,2),
  total          numeric(14,2),
  currency       char(3) DEFAULT 'USD',
  status         text,
  synced_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mirror_receipt_date_idx ON mirror_receipt (purchased_on DESC);
CREATE INDEX IF NOT EXISTS mirror_receipt_tx_idx ON mirror_receipt (transaction_id);

CREATE TABLE IF NOT EXISTS mirror_receipt_item (
  id           uuid PRIMARY KEY,
  receipt_id   uuid NOT NULL REFERENCES mirror_receipt (id) ON DELETE CASCADE,
  name         text NOT NULL,           -- LLM-expanded, human readable
  raw_name     text,                    -- exactly as printed
  quantity     numeric(12,3) DEFAULT 1,
  unit_price   numeric(14,2),
  amount       numeric(14,2) NOT NULL,
  category_name text,
  -- The food-tag taxonomy dap_finance already applies per line. `non-food`
  -- here is what keeps paper towels out of the pantry.
  food_tags    text[] NOT NULL DEFAULT '{}',
  sort_order   integer NOT NULL DEFAULT 0,
  synced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mirror_receipt_item_receipt_idx ON mirror_receipt_item (receipt_id);
CREATE INDEX IF NOT EXISTS mirror_receipt_item_trgm
  ON mirror_receipt_item USING GIN (normalize_food_text(coalesce(name, raw_name)) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS mirror_receipt_item_tags_idx ON mirror_receipt_item USING GIN (food_tags);

-- ===========================================================================
-- LEARNING — the difference between a demo and a tool (RESEARCH.md Analysis)
-- ===========================================================================

-- Every confirmed link teaches this table. Next time the same printed string
-- appears, it resolves deterministically instead of going through the fuzzy
-- matcher. Mirrors dap_finance's own merchant_rules(origin, hits) idiom.
CREATE TABLE IF NOT EXISTS food_alias (
  id             bigserial PRIMARY KEY,
  normalized_text text NOT NULL,
  food_id        bigint,                -- resolved dap_fitness food_item.id
  food_name      text,                  -- kept for display when food_id is null
  origin         link_origin NOT NULL DEFAULT 'user',
  hits           integer NOT NULL DEFAULT 0,
  -- A negative alias records "this text is NOT that food" — the abstain case
  -- the matching literature insists on (RESEARCH.md §1).
  is_negative    boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS food_alias_uq
  ON food_alias (normalized_text, coalesce(food_id, -1), is_negative);
CREATE INDEX IF NOT EXISTS food_alias_text_trgm
  ON food_alias USING GIN (normalized_text gin_trgm_ops);

-- ===========================================================================
-- PANTRY — FIFO cost lots (RESEARCH.md §3)
--
-- A grocery receipt line becomes a lot of stock with a cost basis. Meals draw
-- from the oldest open lot of that food. This is how restaurants have costed
-- perishables forever, and it is the only mechanism that can answer "what did
-- THIS dinner cost" for food cooked at home.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS pantry_lot (
  id              bigserial PRIMARY KEY,
  receipt_item_id uuid UNIQUE REFERENCES mirror_receipt_item (id) ON DELETE CASCADE,
  food_id         bigint,               -- null until resolved to a food_item
  label           text NOT NULL,        -- human name, from the receipt line
  purchased_on    date NOT NULL,
  basis           lot_basis NOT NULL,
  qty_total_g     numeric(14,3),        -- basis='mass' only
  qty_total_units numeric(14,3),        -- basis='unit' only
  total_cost      numeric(14,2) NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'USD',
  -- Perishables that expire with stock left are spoilage, not error. Surfaced,
  -- not silently absorbed (RESEARCH.md Open questions).
  expires_on      date,
  closed_at       timestamptz,          -- manually closed: "finished / threw out"
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pantry_lot_basis_qty CHECK (
    (basis = 'mass' AND qty_total_g   IS NOT NULL AND qty_total_g   > 0 AND qty_total_units IS NULL) OR
    (basis = 'unit' AND qty_total_units IS NOT NULL AND qty_total_units > 0 AND qty_total_g IS NULL)
  ),
  CONSTRAINT pantry_lot_cost_positive CHECK (total_cost >= 0)
);
CREATE INDEX IF NOT EXISTS pantry_lot_food_fifo_idx
  ON pantry_lot (food_id, purchased_on) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS pantry_lot_label_trgm
  ON pantry_lot USING GIN (normalize_food_text(label) gin_trgm_ops);

-- ===========================================================================
-- COST_LINK — the reconciliation edge. One row = one attribution of money to
-- something eaten.
--
-- meal_id is ALWAYS set (it is what we are costing). meal_entry_id is set only
-- for per-ingredient grains. Exactly one source FK is non-null, enforced below,
-- because a link that points at two things is a link that means nothing.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS cost_link (
  id              bigserial PRIMARY KEY,
  meal_id         bigint NOT NULL REFERENCES mirror_meal (id) ON DELETE CASCADE,
  meal_entry_id   bigint REFERENCES mirror_meal_entry (id) ON DELETE CASCADE,

  method          link_method NOT NULL,
  transaction_id  uuid REFERENCES mirror_transaction (id) ON DELETE CASCADE,
  receipt_item_id uuid REFERENCES mirror_receipt_item (id) ON DELETE CASCADE,
  pantry_lot_id   bigint REFERENCES pantry_lot (id) ON DELETE CASCADE,

  allocated_amount numeric(14,2) NOT NULL,
  allocated_g      numeric(14,3),        -- pantry_draw only: grams withdrawn
  currency         char(3) NOT NULL DEFAULT 'USD',

  status          link_status NOT NULL DEFAULT 'proposed',
  origin          link_origin NOT NULL DEFAULT 'auto',
  confidence      numeric(4,3),          -- 0..1, null for manual
  -- Per-signal score breakdown. An unexplainable score is an untrustworthy one,
  -- so the matcher always shows its work.
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  note            text,

  -- NULL until a human confirms. Machine paths (matcher, MCP proposals) must
  -- never set this. Same idiom as dap_finance transactions.reviewed_at and
  -- receipts.reviewed_at — deliberately consistent across the three apps.
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cost_link_one_source CHECK (
    (transaction_id  IS NOT NULL)::int +
    (receipt_item_id IS NOT NULL)::int +
    (pantry_lot_id   IS NOT NULL)::int
    = CASE WHEN method = 'manual_amount' THEN 0 ELSE 1 END
  ),
  CONSTRAINT cost_link_method_source CHECK (
    (method = 'direct_transaction' AND transaction_id  IS NOT NULL) OR
    (method = 'receipt_line'       AND receipt_item_id IS NOT NULL) OR
    (method = 'pantry_draw'        AND pantry_lot_id   IS NOT NULL) OR
    (method = 'manual_amount')
  ),
  -- A whole-meal charge attaches to the meal, not to one ingredient of it.
  CONSTRAINT cost_link_direct_is_meal_grain CHECK (
    method <> 'direct_transaction' OR meal_entry_id IS NULL
  ),
  CONSTRAINT cost_link_draw_has_grams CHECK (
    method <> 'pantry_draw' OR (allocated_g IS NOT NULL AND allocated_g > 0)
  ),
  CONSTRAINT cost_link_confidence_range CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT cost_link_reviewed_implies_settled CHECK (
    reviewed_at IS NULL OR status IN ('confirmed', 'rejected')
  )
);

CREATE INDEX IF NOT EXISTS cost_link_meal_idx    ON cost_link (meal_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS cost_link_entry_idx   ON cost_link (meal_entry_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS cost_link_lot_idx     ON cost_link (pantry_lot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS cost_link_tx_idx      ON cost_link (transaction_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS cost_link_review_idx  ON cost_link (status, confidence DESC) WHERE status = 'proposed';

-- At most ONE confirmed whole-meal charge per meal. This is what makes the
-- direct-vs-entry precedence in v_meal_cost unambiguous rather than a guess.
CREATE UNIQUE INDEX IF NOT EXISTS cost_link_one_direct_per_meal
  ON cost_link (meal_id)
  WHERE method = 'direct_transaction' AND status = 'confirmed';

-- The same source can't be confirmed onto the same target twice.
CREATE UNIQUE INDEX IF NOT EXISTS cost_link_no_dupe_entry_source
  ON cost_link (meal_entry_id, method, coalesce(receipt_item_id::text, pantry_lot_id::text))
  WHERE status = 'confirmed' AND meal_entry_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DO $$ BEGIN
  CREATE TRIGGER cost_link_touch BEFORE UPDATE ON cost_link
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER pantry_lot_touch BEFORE UPDATE ON pantry_lot
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER food_alias_touch BEFORE UPDATE ON food_alias
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================================
-- VIEWS — every cost number ships with its coverage.
--
-- A "Dinner: $14.20" computed from 40% attributed entries is a lie by omission.
-- Coverage travels with cost at every grain. This is the central honesty
-- constraint of the whole design (RESEARCH.md Analysis).
-- ===========================================================================

-- Lot balance is DERIVED, never stored. A stored balance drifts the first time
-- a link is rejected or a lot is re-matched.
CREATE OR REPLACE VIEW v_pantry_lot_balance AS
SELECT
  l.id,
  l.food_id,
  l.label,
  l.purchased_on,
  l.basis,
  l.total_cost,
  l.currency,
  l.expires_on,
  l.closed_at,
  l.qty_total_g,
  l.qty_total_units,
  COALESCE(d.drawn_g, 0)                                       AS drawn_g,
  COALESCE(d.drawn_cost, 0)                                    AS drawn_cost,
  CASE WHEN l.basis = 'mass'
       THEN GREATEST(l.qty_total_g - COALESCE(d.drawn_g, 0), 0)
  END                                                          AS remaining_g,
  GREATEST(l.total_cost - COALESCE(d.drawn_cost, 0), 0)        AS remaining_cost,
  CASE WHEN l.basis = 'mass' AND l.qty_total_g > 0
       THEN l.total_cost / l.qty_total_g
  END                                                          AS cost_per_g,
  -- A mass lot is spent when its grams are gone; a unit lot has no gram figure
  -- to deplete, so it is spent when its cost has been fully allocated. Without
  -- the second branch a unit lot stays "open" forever and gets re-allocated on
  -- every matcher run.
  (l.closed_at IS NULL
   AND CASE
         WHEN l.basis = 'mass' THEN l.qty_total_g - COALESCE(d.drawn_g, 0) > 0.001
         ELSE l.total_cost - COALESCE(d.drawn_cost, 0) > 0.005
       END) AS is_open
FROM pantry_lot l
LEFT JOIN LATERAL (
  SELECT SUM(cl.allocated_g)      AS drawn_g,
         SUM(cl.allocated_amount) AS drawn_cost
  FROM cost_link cl
  WHERE cl.pantry_lot_id = l.id AND cl.status = 'confirmed'
) d ON TRUE;

COMMENT ON VIEW v_pantry_lot_balance IS
  'FIFO lot balances computed from confirmed draws. Never store this — it drifts.';

-- Per-meal cost with provenance and coverage.
--
-- Precedence: a confirmed WHOLE-MEAL cost wins and is used alone. Otherwise sum
-- the per-ingredient links. Without this rule, a restaurant meal whose receipt
-- lines were also linked would double-count.
--
-- "Whole-meal" is two things, not one: a direct charge (ate out, the card paid
-- for the meal) and a manual amount with no entry (cash at a market stall — you
-- know what the meal cost, there is just no row to point at). Both cost the meal
-- entirely, so both suppress per-entry summing and both mean coverage = 1.
CREATE OR REPLACE VIEW v_meal_cost AS
WITH whole_meal AS (
  SELECT meal_id,
         SUM(ABS(allocated_amount)) AS amount,
         MIN(currency)              AS currency
  FROM cost_link
  WHERE status = 'confirmed'
    AND (method = 'direct_transaction'
         OR (method = 'manual_amount' AND meal_entry_id IS NULL))
  GROUP BY meal_id
),
per_entry AS (
  SELECT meal_id,
         SUM(ABS(allocated_amount)) AS amount,
         COUNT(DISTINCT meal_entry_id) FILTER (WHERE meal_entry_id IS NOT NULL) AS linked_entries,
         MIN(currency)              AS currency
  FROM cost_link
  WHERE status = 'confirmed'
    AND method <> 'direct_transaction'
    AND NOT (method = 'manual_amount' AND meal_entry_id IS NULL)
  GROUP BY meal_id
),
proposed AS (
  SELECT meal_id, SUM(ABS(allocated_amount)) AS amount
  FROM cost_link WHERE status = 'proposed'
  GROUP BY meal_id
),
entries AS (
  SELECT meal_id, COUNT(*) AS n, SUM(quantity_g) AS total_g
  FROM mirror_meal_entry GROUP BY meal_id
)
SELECT
  m.id                                            AS meal_id,
  m.meal_date,
  m.meal_time,
  m.meal_type,
  m.meal_type_slug,
  m.note,
  COALESCE(e.n, 0)                                AS entry_count,
  e.total_g,
  COALESCE(d.amount, pe.amount, 0)::numeric(14,2) AS cost,
  COALESCE(pr.amount, 0)::numeric(14,2)           AS cost_proposed,
  COALESCE(d.currency, pe.currency, 'USD')        AS currency,
  CASE WHEN d.amount IS NOT NULL THEN 'direct'
       WHEN pe.amount IS NOT NULL THEN 'itemized'
       ELSE 'unattributed' END                    AS attribution,
  -- A direct whole-meal charge covers the meal completely by definition.
  CASE
    WHEN d.amount IS NOT NULL THEN 1.0
    WHEN COALESCE(e.n, 0) = 0  THEN 0.0
    ELSE ROUND(COALESCE(pe.linked_entries, 0)::numeric / e.n, 3)
  END                                             AS coverage,
  COALESCE(pe.linked_entries, 0)                  AS linked_entry_count
FROM mirror_meal m
LEFT JOIN entries    e  ON e.meal_id  = m.id
LEFT JOIN whole_meal d  ON d.meal_id  = m.id
LEFT JOIN per_entry  pe ON pe.meal_id = m.id
LEFT JOIN proposed   pr ON pr.meal_id = m.id;

COMMENT ON VIEW v_meal_cost IS
  'Cost per meal. A confirmed direct charge wins over per-entry links (prevents double-count). Coverage is the fraction of entries attributed — always render it alongside cost.';

-- Daily rollup by meal type — the primary dashboard series.
CREATE OR REPLACE VIEW v_daily_meal_cost AS
SELECT
  meal_date,
  meal_type,
  meal_type_slug,
  COUNT(*)                                       AS meals,
  SUM(cost)::numeric(14,2)                       AS cost,
  SUM(cost_proposed)::numeric(14,2)              AS cost_proposed,
  SUM(entry_count)                               AS entries,
  SUM(linked_entry_count)                        AS linked_entries,
  CASE WHEN SUM(entry_count) = 0 THEN 0
       ELSE ROUND(SUM(linked_entry_count)::numeric / SUM(entry_count), 3)
  END                                            AS coverage
FROM v_meal_cost
GROUP BY meal_date, meal_type, meal_type_slug;

-- Spend that food_finance knows about but no meal claims. The exception table
-- of the reconciliation literature — unmatched is a first-class output.
CREATE OR REPLACE VIEW v_unattributed_spend AS
SELECT
  t.id,
  t.posted_date,
  ABS(t.amount)::numeric(14,2) AS amount,
  t.currency,
  t.merchant,
  t.description,
  t.category_name,
  t.has_receipt
FROM mirror_transaction t
WHERE t.is_food
  AND t.kind = 'expense'
  AND NOT EXISTS (
    SELECT 1 FROM cost_link cl
    WHERE cl.transaction_id = t.id AND cl.status = 'confirmed'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM mirror_receipt r
    JOIN mirror_receipt_item ri ON ri.receipt_id = r.id
    JOIN cost_link cl2 ON (cl2.receipt_item_id = ri.id
                       OR  cl2.pantry_lot_id IN (SELECT id FROM pantry_lot WHERE receipt_item_id = ri.id))
    WHERE r.transaction_id = t.id AND cl2.status = 'confirmed'
  );

COMMENT ON VIEW v_unattributed_spend IS
  'Food spend with no confirmed link to anything eaten. The reconciliation exception queue, money-side.';

-- Meals with no money attached — the exception queue, food-side.
CREATE OR REPLACE VIEW v_unattributed_meals AS
SELECT meal_id, meal_date, meal_time, meal_type, entry_count, coverage
FROM v_meal_cost
WHERE coverage < 1.0
ORDER BY meal_date DESC, meal_time DESC NULLS LAST;
