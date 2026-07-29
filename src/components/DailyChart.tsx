"use client";

import { useMemo, useState } from "react";
import { day, mealRank, mealVar, money, pct } from "@/lib/format";
import type { DayBucket } from "@/db/queries";

/**
 * Daily food spend, stacked by meal type, with a coverage strip underneath.
 *
 * THE IMPORTANT DECISION: the money axis carries only money we can actually
 * account for. It is tempting to stack an "unattributed" band on top — but we do
 * not know what unattributed meals cost. That is the definition of
 * unattributed. Extrapolating one (known ÷ coverage) would put an invented
 * number on the same axis as measured ones, and nobody reading the chart later
 * would remember which was which.
 *
 * So knowledge gets its own channel: a 4px strip below each column, filled to
 * that day's coverage and hatched for the rest. Height is always money; the
 * strip is always knowledge. Neither lies about the other.
 */

const GAP = 2; // surface gap between stacked segments, per the mark spec

interface Props {
  data: DayBucket[];
  height?: number;
}

interface Column {
  date: string;
  total: number;
  segments: { slug: string; label: string; value: number }[];
  coverage: number;
  entries: number;
  linked: number;
}

export function DailyChart({ data, height = 200 }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const { columns, max, types } = useMemo(() => {
    const byDate = new Map<string, Column>();
    for (const d of data) {
      let col = byDate.get(d.meal_date);
      if (!col) {
        col = { date: d.meal_date, total: 0, segments: [], coverage: 0, entries: 0, linked: 0 };
        byDate.set(d.meal_date, col);
      }
      if (d.cost > 0) col.segments.push({ slug: d.meal_type_slug, label: d.meal_type, value: d.cost });
      col.total += d.cost;
      col.entries += d.entries;
      col.linked += d.linked_entries;
    }

    const columns = [...byDate.values()]
      .map((c) => ({
        ...c,
        coverage: c.entries > 0 ? c.linked / c.entries : 0,
        segments: c.segments.sort((a, b) => mealRank(a.slug) - mealRank(b.slug)),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const seen = new Map<string, string>();
    for (const c of columns) for (const s of c.segments) seen.set(s.slug, s.label);

    return {
      columns,
      max: Math.max(1, ...columns.map((c) => c.total)),
      types: [...seen.entries()].sort((a, b) => mealRank(a[0]) - mealRank(b[0])),
    };
  }, [data]);

  if (columns.length === 0) {
    return (
      <p className="py-10 text-center text-[length:var(--text-sm)] text-[var(--ink-3)]">
        No meals in this range yet.
      </p>
    );
  }

  const active = hover != null ? columns[hover] : null;

  return (
    <figure className="m-0">
      {/* Legend is always present for ≥2 series, and carries the direct labels
          that discharge the light-mode contrast warning on aqua and yellow. */}
      <figcaption className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        {types.map(([slug, label]) => (
          <span key={slug} className="flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--ink-2)]">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-[1px]"
              style={{ background: mealVar(slug) }}
            />
            {label}
          </span>
        ))}
      </figcaption>

      <div className="relative">
        <div
          className="flex items-end gap-[3px]"
          style={{ height }}
          onMouseLeave={() => setHover(null)}
        >
          {columns.map((c, i) => {
            const h = (c.total / max) * height;
            return (
              <div
                key={c.date}
                className="group relative flex min-w-0 flex-1 flex-col justify-end"
                style={{ height }}
                onMouseEnter={() => setHover(i)}
              >
                <div
                  className="flex w-full flex-col-reverse justify-start transition-opacity duration-150"
                  style={{ height: Math.max(h, c.total > 0 ? 2 : 0), opacity: hover == null || hover === i ? 1 : 0.45 }}
                >
                  {c.segments.map((s, si) => (
                    <div
                      key={s.slug}
                      style={{
                        height: `${(s.value / c.total) * 100}%`,
                        background: mealVar(s.slug),
                        // 4px rounded end on the topmost segment only — the data
                        // end, anchored to the baseline.
                        borderTopLeftRadius: si === c.segments.length - 1 ? 3 : 0,
                        borderTopRightRadius: si === c.segments.length - 1 ? 3 : 0,
                        marginBottom: si > 0 ? GAP : 0,
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Coverage strip: knowledge, not money. */}
        <div className="mt-1 flex gap-[3px]" aria-hidden="true">
          {columns.map((c, i) => (
            <div
              key={c.date}
              className="hatch h-[4px] min-w-0 flex-1 overflow-hidden rounded-[1px] transition-opacity duration-150"
              style={{ opacity: hover == null || hover === i ? 1 : 0.45 }}
              onMouseEnter={() => setHover(i)}
            >
              <div
                className="h-full"
                style={{
                  width: `${c.coverage * 100}%`,
                  background: c.coverage >= 0.999 ? "var(--good)" : "var(--ink-2)",
                }}
              />
            </div>
          ))}
        </div>

        <div className="mt-2 flex justify-between text-[length:var(--text-2xs)] text-[var(--ink-3)]">
          <span>{day(columns[0].date)}</span>
          <span>{day(columns[columns.length - 1].date)}</span>
        </div>

        {active && (
          <div
            className="pointer-events-none absolute -top-1 z-10 w-[190px] rounded-[var(--radius-md)] border border-[var(--rule-strong)] bg-[var(--surface)] p-2.5 shadow-[0_4px_16px_rgba(0,0,0,0.12)]"
            style={{
              left: `${((hover! + 0.5) / columns.length) * 100}%`,
              transform:
                hover! > columns.length / 2 ? "translate(-100%, -100%)" : "translate(0, -100%)",
            }}
          >
            <div className="mb-1.5 text-[length:var(--text-xs)] font-medium">{day(active.date)}</div>
            {active.segments.length === 0 ? (
              <div className="text-[length:var(--text-2xs)] text-[var(--ink-3)]">Nothing attributed</div>
            ) : (
              active.segments.map((s) => (
                <div key={s.slug} className="flex items-center justify-between gap-3 py-px">
                  <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-2xs)] text-[var(--ink-2)]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ background: mealVar(s.slug) }} />
                    <span className="truncate">{s.label}</span>
                  </span>
                  <span className="tnum text-[length:var(--text-2xs)]">{money(s.value)}</span>
                </div>
              ))
            )}
            <div className="mt-1.5 flex items-center justify-between border-t border-[var(--rule)] pt-1.5">
              <span className="text-[length:var(--text-2xs)] text-[var(--ink-3)]">
                {active.linked}/{active.entries} items known
              </span>
              <span className="tnum text-[length:var(--text-2xs)] font-medium">{pct(active.coverage)}</span>
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}
