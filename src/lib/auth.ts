import { SignJWT, jwtVerify } from "jose";
import { timingSafeEqual } from "crypto";

/**
 * Single-user password session, mirroring dap-finance.
 *
 * This app renders a full picture of what someone eats and what they spend. It
 * is path-mounted on a public domain, so "nobody knows the URL" is not a
 * control — the gate is the control.
 */
export const SESSION_COOKIE = "fc-session";
const ALG = "HS256";

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ sub: "renato" })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, secret(), { algorithms: [ALG] });
    return true;
  } catch {
    return false;
  }
}

/** Constant-time, and fails closed when APP_PASSWORD is unset. */
export function checkPassword(input: string): boolean {
  const expected = process.env.APP_PASSWORD ?? "";
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
