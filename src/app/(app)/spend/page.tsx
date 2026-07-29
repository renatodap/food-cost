import { PageHeader } from "@/components/PageHeader";
import { LinkToMeal } from "@/components/LinkToMeal";
import { getMeals, getUnattributedSpend } from "@/db/queries";
import { day, money } from "@/lib/format";
import { resolveRange } from "@/lib/range";

export const dynamic = "force-dynamic";

export default async function Spend({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; from?: string; to?: string }>;
}) {
  const range = resolveRange(await searchParams);
  const [txs, meals] = await Promise.all([
    getUnattributedSpend(range.from, range.to),
    getMeals(range.from, range.to, 400),
  ]);

  const total = txs.reduce((s, t) => s + t.amount, 0);

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-8">
      <PageHeader
        title="Spend"
        basePath="/spend"
        range={range}
        lede={
          <>
            Food money with nothing eaten attached to it — <span className="tnum">{money(total)}</span>{" "}
            across <span className="tnum">{txs.length}</span> charges. Some of this is genuinely
            unmatched; some is groceries still sitting in the pantry, which will attach itself as you
            eat them.
          </>
        }
      />

      {txs.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-[length:var(--text-sm)] font-medium">Everything is accounted for</p>
          <p className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-3)]">
            Every food charge in this range is linked to something you ate.
          </p>
        </div>
      ) : (
        <table className="mt-6 w-full border-collapse text-[length:var(--text-sm)]">
          <thead>
            <tr className="border-b border-[var(--rule-strong)] text-left text-[length:var(--text-2xs)] text-[var(--ink-3)]">
              <th className="py-1.5 pr-3 font-normal">Date</th>
              <th className="py-1.5 pr-3 font-normal">Merchant</th>
              <th className="py-1.5 pr-3 font-normal">Category</th>
              <th className="py-1.5 pr-3 text-right font-normal">Amount</th>
              <th className="w-[4.5rem] py-1.5 font-normal" />
            </tr>
          </thead>
          <tbody>
            {txs.map((t) => (
              <tr key={t.id} className="border-b border-[var(--rule)] transition-colors duration-150 hover:bg-[var(--hover)]">
                <td className="tnum py-2 pr-3 text-[length:var(--text-xs)] whitespace-nowrap text-[var(--ink-2)]">
                  {day(t.posted_date)}
                </td>
                <td className="max-w-0 py-2 pr-3">
                  <div className="truncate">{t.merchant ?? t.description ?? "—"}</div>
                  {t.has_receipt && (
                    <div className="text-[length:var(--text-2xs)] text-[var(--ink-3)]">
                      has an itemized receipt
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3 text-[length:var(--text-xs)] whitespace-nowrap text-[var(--ink-3)]">
                  {t.category_name ?? "—"}
                </td>
                <td className="tnum py-2 pr-3 text-right font-medium whitespace-nowrap">
                  {money(t.amount, t.currency)}
                </td>
                <td className="py-2">
                  <LinkToMeal tx={t} meals={meals} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
