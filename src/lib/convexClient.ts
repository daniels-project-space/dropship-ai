// Server-side Convex client for use inside Trigger tasks / route handlers.
// Calls deployed Convex functions over HTTP using the public NEXT_PUBLIC_CONVEX_URL.
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { mintServiceJwt } from "./auth/jwt";

export function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL;
  if (!url) throw new Error("convexClient: NEXT_PUBLIC_CONVEX_URL is not set");
  return new ConvexHttpClient(url, { auth: mintServiceJwt() });
}

export { api };
