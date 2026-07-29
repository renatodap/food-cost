"use client";

import { useMemo, useState, useTransition } from "react";
import { Link2 } from "lucide-react";
import { linkTransactionToMeal } from "@/lib/actions";
import { day, mealVar, money, time } from "@/lib/format";
import type { MealRow, UnattributedTx } from "@/db/queries";

/**
 * Attach a charge to the meal it paid for, by hand.
 *
 * This is the escape hatch for everything the matcher couldn't work out, and it
 * is deliberately inline rather than a modal — you are scanning a list of
 * charges, and a dialog would throw away the context you're using to decide.
 *
 * Candidates are limited to meals within the plausible posting window (the meal
 * happens on or up to three days before the charge posts). Offering every meal
 * in the range would technically be more flexible and would make the common case
 * worse.
 */
export function LinkToMeal({ tx, meals }: { tx: UnattributedTx; meals: MealRow[] }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [linked, setLinked] = useState(false);

  const candidates = useMemo(() => {
    const posted = Date.parse(`${tx.posted_date}T00:00:00Z`);
    return meals
      .filter((m) => {
        const gap = (posted - Date.parse(`${m.meal_date}T00:00:00Z`)) / 86_400_000;
        return gap >= 0 && gap <= 3 && m.attribution !== "direct";
      })
      .slice(0, 12);
  }, [tx.posted_date, meals]);

  if (linked) {
    return (
      <span className="text-[length:var(--text-2xs)] text-[var(--good)]">linked</span>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--rule-strong)] px-1.5 py-0.5 text-[length:var(--text-2xs)] text-[var(--ink-2)] transition-colors duration-150 hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      >
        <Link2 size={11} />
        link
      </button>

      {open && (
        <div className="absolute top-full right-0 z-20 mt-1 w-[300px] rounded-[var(--radius-md)] border border-[var(--rule-strong)] bg-[var(--surface)] p-1.5 shadow-[0_6px_20px_rgba(0,0,0,0.14)]">
          {candidates.length === 0 ? (
            <p className="p-2 text-[length:var(--text-2xs)] leading-relaxed text-[var(--ink-3)]">
              No meals logged in the three days before this charge posted. Either the meal
              wasn&rsquo;t logged, or this charge isn&rsquo;t a meal.
            </p>
          ) : (
            <ul>
              {candidates.map((m) => (
                <li key={m.meal_id}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        await linkTransactionToMeal(m.meal_id, tx.id);
                        setLinked(true);
                        setOpen(false);
                      })
                    }
                    className="flex w-full items-baseline gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left transition-colors duration-150 hover:bg-[var(--hover)] disabled:opacity-40"
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0 translate-y-[-1px] rounded-[1px]"
                      style={{ background: mealVar(m.meal_type_slug) }}
                    />
                    <span className="shrink-0 text-[length:var(--text-xs)]">{m.meal_type}</span>
                    <span className="tnum shrink-0 text-[length:var(--text-2xs)] text-[var(--ink-3)]">
                      {day(m.meal_date)} {time(m.meal_time)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-2xs)] text-[var(--ink-3)]">
                      {m.items}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 border-t border-[var(--rule)] px-1.5 pt-1.5 text-[length:var(--text-2xs)] text-[var(--ink-3)]">
            Links {money(tx.amount, tx.currency)} to the whole meal.
          </p>
        </div>
      )}
    </div>
  );
}
