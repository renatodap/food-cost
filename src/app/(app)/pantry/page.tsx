import { PageHeader } from "@/components/PageHeader";
import { getPantryLots } from "@/db/queries";
import { day, grams, money } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Pantry() {
  const lots = await getPantryLots(250);

  const open = lots.filter((l) => l.is_open);
  const openValue = open.reduce((s, l) => s + l.remaining_cost, 0);
  const unresolved = lots.filter((l) => l.food_id == null).length;

  return (
    <div className="mx-auto max-w-[1000px] px-8 py-8">
      <PageHeader
        title="Pantry"
        lede={
          <>
            Every grocery line becomes a cost lot that meals draw from, oldest first — the same FIFO
            rule restaurants use for perishables.{" "}
            <span className="tnum">{money(openValue)}</span> of food is still on the shelf,
            unattributed only because you haven&rsquo;t eaten it yet.
          </>
        }
      />

      {unresolved > 0 && (
        <p className="mt-4 rounded-[var(--radius-md)] border border-[var(--rule)] bg-[var(--warn-bg)] px-3 py-2 text-[length:var(--text-xs)] text-[var(--warn)]">
          <span className="tnum">{unresolved}</span> lots couldn&rsquo;t be resolved to a food you
          eat, so nothing can draw from them. Usually the receipt text was too abbreviated to match —
          confirming one similar link teaches the alias and fixes the rest.
        </p>
      )}

      {lots.length === 0 ? (
        <p className="py-12 text-center text-[length:var(--text-sm)] text-[var(--ink-3)]">
          No grocery lines stocked yet. Sync a grocery receipt to fill this.
        </p>
      ) : (
        <table className="mt-6 w-full border-collapse text-[length:var(--text-sm)]">
          <thead>
            <tr className="border-b border-[var(--rule-strong)] text-left text-[length:var(--text-2xs)] text-[var(--ink-3)]">
              <th className="py-1.5 pr-3 font-normal">Bought</th>
              <th className="py-1.5 pr-3 font-normal">Item</th>
              <th className="py-1.5 pr-3 text-right font-normal">Cost</th>
              <th className="py-1.5 pr-3 text-right font-normal">Eaten</th>
              <th className="py-1.5 pr-3 text-right font-normal">Left</th>
              <th className="py-1.5 text-right font-normal">Value left</th>
            </tr>
          </thead>
          <tbody>
            {lots.map((l) => (
              <tr
                key={l.id}
                className={`border-b border-[var(--rule)] transition-colors duration-150 hover:bg-[var(--hover)] ${
                  l.is_open ? "" : "text-[var(--ink-3)]"
                }`}
              >
                <td className="tnum py-2 pr-3 text-[length:var(--text-xs)] whitespace-nowrap text-[var(--ink-2)]">
                  {day(l.purchased_on)}
                </td>
                <td className="max-w-0 py-2 pr-3">
                  <div className="truncate">{l.label}</div>
                  {/* A unit-basis lot can't be drawn from in grams. Saying so is
                      more useful than silently never matching. */}
                  {l.basis === "unit" && (
                    <div className="text-[length:var(--text-2xs)] text-[var(--ink-3)]">
                      priced per item — no weight printed, so meals can&rsquo;t draw grams from it
                    </div>
                  )}
                  {l.food_id == null && (
                    <div className="text-[length:var(--text-2xs)] text-[var(--warn)]">
                      not matched to a food yet
                    </div>
                  )}
                </td>
                <td className="tnum py-2 pr-3 text-right whitespace-nowrap">
                  {money(l.total_cost, l.currency)}
                </td>
                <td className="tnum py-2 pr-3 text-right text-[length:var(--text-xs)] whitespace-nowrap text-[var(--ink-2)]">
                  {l.basis === "mass" && l.drawn_g != null ? grams(l.drawn_g) : "—"}
                </td>
                <td className="tnum py-2 pr-3 text-right text-[length:var(--text-xs)] whitespace-nowrap text-[var(--ink-2)]">
                  {l.basis === "mass" && l.remaining_g != null ? grams(l.remaining_g) : "—"}
                </td>
                <td className="tnum py-2 text-right whitespace-nowrap">
                  {money(l.remaining_cost, l.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
