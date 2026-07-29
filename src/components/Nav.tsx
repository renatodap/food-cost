"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { Boxes, LayoutGrid, Moon, ScrollText, Sun, UtensilsCrossed, Wallet } from "lucide-react";

const LINKS = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/review", label: "Review", icon: ScrollText },
  { href: "/meals", label: "Meals", icon: UtensilsCrossed },
  { href: "/spend", label: "Spend", icon: Wallet },
  { href: "/pantry", label: "Pantry", icon: Boxes },
];

/**
 * The theme lives in localStorage and the OS preference — both external stores,
 * so it is read with useSyncExternalStore rather than mirrored into state via an
 * effect. That also makes it correct across tabs for free: a `storage` event
 * from another tab re-renders this one.
 */
const THEME_EVENT = "fc-theme-change";

function subscribeTheme(onChange: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  window.addEventListener("storage", onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    mq.removeEventListener("change", onChange);
    window.removeEventListener("storage", onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

function readTheme(): "light" | "dark" {
  const stored = localStorage.getItem("fc-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeToggle() {
  // `null` on the server: it has no idea what the OS prefers, so rendering an
  // icon during SSR guarantees it's wrong half the time. One frame of nothing
  // beats a wrong icon that then flips.
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => null);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("fc-theme", next);
    window.dispatchEvent(new Event(THEME_EVENT));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--ink-3)] transition-colors duration-150 hover:bg-[var(--hover)] hover:text-[var(--ink)]"
    >
      {theme === "dark" ? <Sun size={15} /> : theme === "light" ? <Moon size={15} /> : null}
    </button>
  );
}

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 flex h-screen w-[210px] shrink-0 flex-col border-r border-[var(--rule)] bg-[var(--panel)] px-3 py-5">
      <div className="px-2 pb-6">
        <div className="text-[length:var(--text-base)] leading-tight font-semibold tracking-tight">food cost</div>
        <div className="text-[length:var(--text-xs)] leading-snug text-[var(--ink-3)]">
          meals, reconciled
        </div>
      </div>

      <ul className="flex flex-col gap-px">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5",
                  "text-[length:var(--text-sm)] transition-colors duration-150",
                  active
                    ? "bg-[var(--selected)] font-medium text-[var(--ink)]"
                    : "text-[var(--ink-2)] hover:bg-[var(--hover)] hover:text-[var(--ink)]",
                ].join(" ")}
              >
                <Icon size={15} strokeWidth={1.75} className="shrink-0" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto flex items-center justify-between px-1 pt-4">
        <span className="text-[length:var(--text-2xs)] text-[var(--ink-3)]">USD</span>
        <ThemeToggle />
      </div>
    </nav>
  );
}
