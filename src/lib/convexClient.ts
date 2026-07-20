// Server-side Convex client for use inside Trigger tasks / route handlers.
// Calls deployed Convex functions over HTTP using the public NEXT_PUBLIC_CONVEX_URL.
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

export function convexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL;
  if (!url) throw new Error("convexClient: NEXT_PUBLIC_CONVEX_URL is not set");
  const token = process.env.DROPSHIP_AI_SERVICE_TOKEN;
  if (!token) throw new Error("convexClient: DROPSHIP_AI_SERVICE_TOKEN is not set");
  return new ConvexHttpClient(url, { auth: token });
}

export { api };
