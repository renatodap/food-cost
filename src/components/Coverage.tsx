import { pct } from "@/lib/format";

/**
 * How much of a cost figure is actually known.
 *
 * A meter with a number beside it, not a ring: rings standing in for content are
 * a refused pattern, and a number is what you actually read. The hatched
 * remainder is the same texture used everywhere else for "we don't know" — a
 * texture rather than a colour so it survives greyscale and forced-colors mode.
 *
 * This component never appears alone. It is always adjacent to the cost it
 * qualifies (see docs/DESIGN.md — the honesty rule).
 */
export function Coverage({
  value,
  width = 44,
  showLabel = true,
}: {
  value: number;
  width?: number;
  showLabel?: boolean;
}) {
  const clamped = Math.max(0, Math.min(1, value || 0));
  const full = clamped >= 0.999;

  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <span
        className="relative inline-block h-[5px] overflow-hidden rounded-full hatch"
        style={{ width }}
        role="img"
        aria-label={`${pct(clamped)} of this cost is attributed`}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-200"
          style={{
            width: `${clamped * 100}%`,
            background: full ? "var(--good)" : "var(--ink-2)",
          }}
        />
      </span>
      {showLabel && (
        <span className="tnum text-[length:var(--text-2xs)] text-[var(--ink-3)] tabular-nums">
          {pct(clamped)}
        </span>
      )}
    </span>
  );
}
