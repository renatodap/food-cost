import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { DailyChart } from "@/components/DailyChart";
import { Coverage } from "@/components/Coverage";
import { countProposed, getDailyCosts, getMealTypeSummary, getPeriodTotals } from "@/db/queries";
import { mealRank, mealVar, money, pct } from "@/lib/format";
import { resolveRange } from "@/lib/range";

export const dynamic = "force-dynamic";

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; from?: string; to?: string }>;
}) {
  const range = resolveRange(await searchParams);

  const [daily, byType, totals, proposed] = await Promise.all([
    getDailyCosts(range.from, range.to),
    getMealTypeSummary(range.from, range.to),
    getPeriodTotals(range.from, range.to),
    countProposed(),
  ]);

  const types = byType.filter((t) => t.meals > 0).sort((a, b) => mealRank(a.meal_type_slug) - mealRank(b.meal_type_slug));
  const empty = totals.meals === 0;

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-8">
      <PageHeader
        title="Overview"
        basePath="/"
        range={range}
        lede={
          empty ? (
            "Nothing synced for this range yet."
          ) : (
            <>
              <span className="tnum font-medium text-[var(--ink)]">{money(totals.cost)}</span> traced across{" "}
              <span className="tnum">{totals.meals}</span> meals over the last {range.days} days.{" "}
              <span className="tnum">{pct(totals.coverage)}</span> of what you ate is accounted for —
              the rest is food you logged but no money has been matched to yet.
            </>
          )
        }
      />

      {empty ? (
        <EmptyState />
      ) : (
        <>
          <section className="pt-8">
            <h2 className="mb-4 text-[length:var(--text-sm)] font-medium">Daily spend</h2>
            <DailyChart data={daily} />
            <p className="mt-3 max-w-[68ch] text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-3)]">
              Bar height is money actually traced to a receipt or a charge. The strip beneath each
              day is how much of that day&rsquo;s food is accounted for — hatched means unknown.
              Unattributed meals are deliberately absent from the bars rather than estimated into
              them.
            </p>
          </section>

          <section className="pt-10">
            <h2 className="mb-3 text-[length:var(--text-sm)] font-medium">By meal</h2>
            <table className="w-full border-collapse text-[length:var(--text-sm)]">
              <thead>
                <tr className="border-b border-[var(--rule-strong)] text-left text-[length:var(--text-2xs)] text-[var(--ink-3)]">
                  <th className="py-1.5 pr-3 font-normal">Meal</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Meals</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Average</th>
                  <th className="py-1.5 pr-3 text-right font-normal">Total</th>
                  <th className="py-1.5 text-right font-normal">Known</th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.meal_type_slug} className="border-b border-[var(--rule)]">
                    <td className="py-2 pr-3">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-[1px]"
                          style={{ background: mealVar(t.meal_type_slug) }}
                        />
                        {t.meal_type}
                      </span>
                    </td>
                    <td className="tnum py-2 pr-3 text-right text-[var(--ink-2)]">{t.meals}</td>
                    <td className="tnum py-2 pr-3 text-right">{t.avg > 0 ? money(t.avg) : "—"}</td>
                    <td className="tnum py-2 pr-3 text-right font-medium">{money(t.total)}</td>
                    <td className="py-2 text-right">
                      <Coverage value={t.coverage} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[length:var(--text-xs)] text-[var(--ink-3)]">
              Average is over meals that have a cost, not over every meal — otherwise the
              unattributed ones would drag it toward zero and report a cheaper dinner than you ever ate.
            </p>
          </section>

          <section className="pt-10">
            <h2 className="mb-3 text-[length:var(--text-sm)] font-medium">Needs attention</h2>
            <ul className="flex flex-col divide-y divide-[var(--rule)] border-y border-[var(--rule)]">
              <AttentionRow
                href="/review"
                label="Proposed links waiting for a decision"
                value={String(proposed)}
                muted={proposed === 0}
              />
              <AttentionRow
                href="/spend"
                label="Food spend with nothing eaten attached to it"
                value={`${money(totals.unattributed_spend)} · ${totals.unattributed_count} charges`}
                muted={totals.unattributed_count === 0}
              />
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function AttentionRow({
  href,
  label,
  value,
  muted,
}: {
  href: string;
  label: string;
  value: string;
  muted: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        className="group flex items-center justify-between gap-4 py-2.5 transition-colors duration-150 hover:bg-[var(--hover)]"
      >
        <span className="text-[length:var(--text-sm)] text-[var(--ink-2)]">{label}</span>
        <span className="flex items-center gap-2">
          <span
            className={`tnum text-[length:var(--text-sm)] ${muted ? "text-[var(--ink-3)]" : "font-medium"}`}
          >
            {value}
          </span>
          <ArrowRight
            size={13}
            className="text-[var(--ink-3)] transition-transform duration-150 group-hover:translate-x-0.5"
          />
        </span>
      </Link>
    </li>
  );
}

/**
 * An empty state that teaches the interface rather than saying "nothing here".
 * This app is useless until a sync has run, so the empty state is where the
 * setup instructions live.
 */
function EmptyState() {
  return (
    <div className="pt-10">
      <h2 className="text-[length:var(--text-lg)] font-medium">Nothing to reconcile yet</h2>
      <p className="mt-2 max-w-[62ch] text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-2)]">
        This app doesn&rsquo;t hold any data of its own — it mirrors meals from DAP Fitness and
        money from DAP Finance, then works out which paid for which. Run a sync to pull both
        sides in:
      </p>
      <pre className="mt-4 overflow-x-auto rounded-[var(--radius-md)] border border-[var(--rule)] bg-[var(--panel)] p-3 text-[length:var(--text-xs)]">
        <code className="tnum">npm run sync &amp;&amp; npm run match</code>
      </pre>
      <p className="mt-3 max-w-[62ch] text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-3)]">
        Or POST to <code className="tnum">/api/cron/sync</code> with the cron secret. Both source
        apps need <code className="tnum">FOOD_COST_INTERNAL_SECRET</code> set to the same value as
        this one.
      </p>
    </div>
  );
}
