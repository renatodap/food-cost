import Link from "next/link";
import { PRESETS, type Range } from "@/lib/range";

/**
 * One header shape for every page: title, a sentence of orientation, and the
 * range control. Consistency screen-to-screen is a virtue here, not a missed
 * chance to be interesting.
 */
export function PageHeader({
  title,
  lede,
  range,
  basePath,
}: {
  title: string;
  lede?: React.ReactNode;
  range?: Range;
  basePath?: string;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-dashed border-[var(--rule-strong)] pb-5">
      <div className="min-w-0">
        <h1 className="text-[length:var(--text-2xl)] font-semibold">{title}</h1>
        {lede && (
          <p className="mt-1 max-w-[68ch] text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-2)]">
            {lede}
          </p>
        )}
      </div>

      {range && basePath && (
        <div
          className="flex shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--rule-strong)]"
          role="group"
          aria-label="Date range"
        >
          {PRESETS.map((p) => {
            const active = range.days === p.days;
            return (
              <Link
                key={p.days}
                href={`${basePath}?days=${p.days}`}
                aria-current={active ? "true" : undefined}
                className={[
                  "border-r border-[var(--rule-strong)] px-2.5 py-1 text-[length:var(--text-xs)] last:border-r-0",
                  "transition-colors duration-150",
                  active
                    ? "bg-[var(--ink)] text-[var(--bg)]"
                    : "text-[var(--ink-2)] hover:bg-[var(--hover)] hover:text-[var(--ink)]",
                ].join(" ")}
              >
                {p.label}
              </Link>
            );
          })}
        </div>
      )}
    </header>
  );
}
