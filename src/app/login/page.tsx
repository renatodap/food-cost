import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, checkPassword, createSessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  async function submit(formData: FormData) {
    "use server";
    const password = String(formData.get("password") ?? "");
    const target = String(formData.get("next") ?? "/") || "/";

    if (!checkPassword(password)) {
      redirect(`/login?error=1${target !== "/" ? `&next=${encodeURIComponent(target)}` : ""}`);
    }
    const jar = await cookies();
    jar.set(SESSION_COOKIE, await createSessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    // Only ever redirect to a path on this origin — a full URL here would make
    // ?next= an open redirect.
    redirect(target.startsWith("/") ? target : "/");
  }

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <form action={submit} className="w-full max-w-[300px]">
        <h1 className="text-[length:var(--text-xl)] font-semibold">food cost</h1>
        <p className="mt-1 mb-5 text-[length:var(--text-sm)] text-[var(--ink-2)]">
          Meals, reconciled against what paid for them.
        </p>

        <input type="hidden" name="next" value={next ?? "/"} />
        <label htmlFor="password" className="sr-only">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          className="w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-2.5 py-2 text-[length:var(--text-sm)] outline-none transition-colors duration-150 focus:border-[var(--focus)]"
        />

        {error && (
          <p role="alert" className="mt-2 text-[length:var(--text-xs)] text-[var(--bad)]">
            That password didn&rsquo;t work.
          </p>
        )}

        <button
          type="submit"
          className="mt-3 w-full rounded-[var(--radius-sm)] bg-[var(--ink)] px-3 py-2 text-[length:var(--text-sm)] font-medium text-[var(--bg)] transition-opacity duration-150 hover:opacity-85"
        >
          Enter
        </button>
      </form>
    </div>
  );
}
