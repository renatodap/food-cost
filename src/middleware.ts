import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

const PUBLIC_PATHS = ["/login"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // The cron job and the MCP connector carry their own shared secrets and have
  // no browser session to check. Each route verifies its own; the middleware
  // must not redirect them to a login page they cannot complete.
  if (pathname.startsWith("/api/cron")) return NextResponse.next();
  if (pathname.startsWith("/api/internal")) return NextResponse.next();
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  if (!(await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value))) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
