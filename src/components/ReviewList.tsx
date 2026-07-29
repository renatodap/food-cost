"use client";

import { useState, useTransition } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import type { ProposedLink } from "@/db/queries";
import { confirmLink, rejectLink } from "@/lib/actions";
import { day, grams, mealVar, money, pct, time } from "@/lib/format";

const METHOD_LABEL: Record<string, string> = {
  direct_transaction: "whole meal ← charge",
  pantry_draw: "drawn from pantry",
  receipt_line: "receipt line",
  manual_amount: "manual",
};

function confidenceTone(c: number): { bg: string; fg: string; word: string } {
  if (c >= 0.8) return { bg: "var(--good-bg)", fg: "var(--good)", word: "likely" };
  if (c >= 0.6) return { bg: "var(--warn-bg)", fg: "var(--warn)", word: "plausible" };
  return { bg: "var(--bad-bg)", fg: "var(--bad)", word: "a guess" };
}

function Row({ link }: { link: ProposedLink }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  // Optimistic removal: once you've decided, the row should leave immediately.
  // Waiting for a round trip to re-render the list makes triage feel like wading.
  const [done, setDone] = useState<"confirmed" | "rejected" | null>(null);

  const tone = confidenceTone(link.confidence);

  if (done) return null;

  function decide(kind: "confirmed" | "rejected") {
    start(async () => {
      if (kind === "confirmed") await confirmLink(link.id);
      else await rejectLink(link.id);
      setDone(kind);
    });
  }

  return (
    <li className="border-b border-[var(--rule)] last:border-b-0">
      <div className="flex items-start gap-4 py-3">
        <div className="min-w-0 flex-1">
          {/* The pairing, stated plainly: what was eaten ← what paid for it. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className="inline-block h-2 w-2 shrink-0 translate-y-[-1px] rounded-[1px]"
              style={{ background: mealVar(link.meal_type_slug) }}
              aria-hidden="true"
            />
            <span className="text-[length:var(--text-sm)] font-medium">
              {link.entry_name ?? link.meal_type}
            </span>
            {link.entry_g != null && (
              <span className="tnum text-[length:var(--text-xs)] text-[var(--ink-3)]">
                {grams(link.entry_g)}
              </span>
            )}
            <span className="text-[length:var(--text-xs)] text-[var(--ink-3)]">
              · {link.meal_type} {day(link.meal_date)} {time(link.meal_time)}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[length:var(--text-xs)] text-[var(--ink-2)]">
            <span className="text-[var(--ink-3)]">←</span>
            <span className="font-medium">{link.source_label}</span>
            {link.source_detail && <span className="text-[var(--ink-3)]">{link.source_detail}</span>}
            <span className="text-[var(--ink-3)]">· {METHOD_LABEL[link.method] ?? link.method}</span>
          </div>

          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="mt-1.5 flex items-center gap-1 text-[length:var(--text-2xs)] text-[var(--ink-3)] transition-colors duration-150 hover:text-[var(--ink)]"
          >
            <ChevronDown
              size={11}
              className="transition-transform duration-150"
              style={{ transform: open ? "rotate(180deg)" : undefined }}
            />
            why this match
          </button>

          {open && (
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-[var(--radius-sm)] bg-[var(--panel)] p-2 text-[length:var(--text-2xs)]">
              {Object.entries(link.evidence).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-[var(--ink-3)]">{k.replace(/_/g, " ")}</dt>
                  <dd className="tnum">{typeof v === "number" ? Number(v.toFixed(3)) : String(v ?? "—")}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <div className="tnum text-[length:var(--text-sm)] font-medium">
              {money(link.allocated_amount, link.currency)}
            </div>
            <div
              className="mt-0.5 inline-block rounded-full px-1.5 py-px text-[length:var(--text-2xs)]"
              style={{ background: tone.bg, color: tone.fg }}
              title={`Matcher confidence ${pct(link.confidence)}`}
            >
              {tone.word} · <span className="tnum">{pct(link.confidence)}</span>
            </div>
          </div>

          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => decide("rejected")}
              disabled={pending}
              aria-label="Reject this match"
              className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--rule-strong)] text-[var(--ink-2)] transition-colors duration-150 hover:border-[var(--bad)] hover:text-[var(--bad)] disabled:opacity-40"
            >
              <X size={14} />
            </button>
            <button
              type="button"
              onClick={() => decide("confirmed")}
              disabled={pending}
              aria-label="Confirm this match"
              className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--ink)] text-[var(--bg)] transition-opacity duration-150 hover:opacity-85 disabled:opacity-40"
            >
              <Check size={14} />
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

export function ReviewList({ links }: { links: ProposedLink[] }) {
  if (links.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-[length:var(--text-sm)] font-medium">Queue is empty</p>
        <p className="mx-auto mt-1 max-w-[46ch] text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-3)]">
          Every proposal has been decided. Run the matcher again after the next sync — and note
          that each decision you make here teaches the alias table, so this queue should get
          shorter over time, not longer.
        </p>
      </div>
    );
  }

  return (
    <ul className="border-y border-[var(--rule)]">
      {links.map((l) => (
        <Row key={l.id} link={l} />
      ))}
    </ul>
  );
}
