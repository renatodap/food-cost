import { PageHeader } from "@/components/PageHeader";
import { Coverage } from "@/components/Coverage";
import { getMeals } from "@/db/queries";
import { day, mealVar, money, time } from "@/lib/format";
import { resolveRange } from "@/lib/range";

export const dynamic = "force-dynamic";

const ATTRIBUTION_NOTE: Record<string, string> = {
  direct: "one charge paid for this whole meal",
  itemized: "costed from its ingredients",
  unattributed: "no money matched to this yet",
};

export default async function Meals({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; from?: string; to?: string }>;
}) {
  const range = resolveRange(await searchParams);
  const meals = await getMeals(range.from, range.to, 300);

  // Group by day so the ledger reads as a diary rather than an undifferentiated
  // list — the date is the thing you navigate by.
  const byDay = new Map<string, typeof meals>();
  for (const m of meals) {
    const list = byDay.get(m.meal_date);
    if (list) list.push(m);
    else byDay.set(m.meal_date, [m]);
  }

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-8">
      <PageHeader
        title="Meals"
        basePath="/meals"
        range={range}
        lede="Every meal logged, and what it cost — where that's known. A dash means nothing has been matched to it yet, not that it was free."
      />

      {meals.length === 0 ? (
        <p className="py-12 text-center text-[length:var(--text-sm)] text-[var(--ink-3)]">
          No meals in this range.
        </p>
      ) : (
        <div className="pt-6">
          {[...byDay.entries()].map(([date, list]) => {
            const dayTotal = list.reduce((s, m) => s + m.cost, 0);
            return (
              <section key={date} className="mb-6">
                <div className="flex items-baseline justify-between border-b border-dashed border-[var(--rule-strong)] pb-1">
                  <h2 className="text-[length:var(--text-xs)] font-medium text-[var(--ink-2)]">
                    {day(date)}
                  </h2>
                  <span className="tnum text-[length:var(--text-xs)] text-[var(--ink-2)]">
                    {money(dayTotal)}
                  </span>
                </div>

                <ul>
                  {list.map((m) => (
                    <li
                      key={m.meal_id}
                      className="group flex items-baseline gap-2 py-1.5 transition-colors duration-150 hover:bg-[var(--hover)]"
                    >
                      <span
                        className="inline-block h-2 w-2 shrink-0 translate-y-[-1px] rounded-[1px]"
                        style={{ background: mealVar(m.meal_type_slug) }}
                        aria-hidden="true"
                      />
                      <span className="shrink-0 text-[length:var(--text-sm)]">{m.meal_type}</span>
                      {m.meal_time && (
                        <span className="tnum shrink-0 text-[length:var(--text-2xs)] text-[var(--ink-3)]">
                          {time(m.meal_time)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-xs)] text-[var(--ink-3)]">
                        {m.items}
                      </span>

                      {/* Dot leaders — the receipt line, and the thing that makes a
                          column of prices readable without a table border. */}
                      <span
                        className="mx-1 hidden min-w-[1.5rem] flex-[0_1_auto] self-center border-b border-dotted border-[var(--rule-strong)] sm:block"
                        aria-hidden="true"
                      />

                      <span
                        className="shrink-0"
                        title={ATTRIBUTION_NOTE[m.attribution]}
                      >
                        <Coverage value={m.coverage} width={34} showLabel={false} />
                      </span>
                      <span
                        className={`tnum w-[4.5rem] shrink-0 text-right text-[length:var(--text-sm)] ${
                          m.cost > 0 ? "font-medium" : "text-[var(--ink-3)]"
                        }`}
                      >
                        {m.cost > 0 ? money(m.cost) : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
