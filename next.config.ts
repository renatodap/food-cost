import type { NextConfig } from "next";

/**
 * `basePath` comes from the environment so the same build can serve at
 * `renatodap.me/food-cost` (path-mounted behind Coolify's Traefik) or at the
 * root of its own domain later, with no code change. See Persimmon/infra's
 * README — Traefik must NOT strip the prefix; Next owns it.
 */
const basePath = process.env.NEXT_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath ?? "" },
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
};

export default nextConfig;
