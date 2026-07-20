// Rule-based insight engine. Walks the (index-scoped) data for a scope and emits
// a small ranked set of plain-language insights. These are DETERMINISTIC computed
// rules over real rows — NOT model output — and are surfaced as such in the UI
// (labelled "computed"). Each insight carries an icon key, headline, supporting
// stat, tone, and an optional suggested action (route + label).

import { query } from "./authz";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { matchesDataMode } from "./sampleScope";

const DAY_MS = 24 * 60 * 60 * 1000;

type Insight = {
  id: string;
  icon: "flame" | "spark" | "package" | "approvals" | "research" | "truck" | "distribution";
  tone: "live" | "pending" | "cyan" | "signal" | "violet";
  headline: string;
  stat: string;
  action?: { label: string; href: string };
};

export const list = query({
  args: { scope: v.optional(v.string()), days: v.optional(v.number()), dataMode: v.optional(v.union(v.literal("live"), v.literal("sample"))) },
  handler: async (ctx, { scope, days, dataMode }) => {
    const window = Math.min(days ?? 30, 180);
    const since = Date.now() - window * DAY_MS;
    const candidates =
      scope && scope !== "all"
        ? [await ctx.db.get(scope as Id<"sites">)].filter((s): s is NonNullable<typeof s> => !!s)
        : await ctx.db.query("sites").take(200);
    const sites = candidates.filter((site) => matchesDataMode(site, dataMode));

    const insights: Insight[] = [];

    // gather per-scope aggregates
    let totalViews = 0;
    let bestPost: { hook: string; views: number; platform: string } | null = null;
    const platformViews: Record<string, number> = { tiktok: 0, instagram: 0, youtube: 0, facebook: 0 };
    const hookViews = new Map<string, number>();
    let pending = 0;
    let openOrders = 0;
    let revenue = 0;
    let bestMargin: { title: string; margin: number } | null = null;
    let breakoutCount = 0;

    for (const s of sites) {
      const [posts, actions, orders, products] = await Promise.all([
        ctx.db.query("posts").withIndex("by_site_status", (q) => q.eq("siteId", s._id).eq("status", "published")).take(2000),
        ctx.db.query("actions").withIndex("by_site_status", (q) => q.eq("siteId", s._id).eq("status", "pending_approval")).take(500),
        ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", s._id)).take(2000),
        ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", s._id)).take(200),
      ]);

      pending += actions.length;

      for (const p of posts) {
        const at = p.publishedAt ?? p._creationTime;
        if (at < since) continue;
        const v0 = p.views ?? 0;
        totalViews += v0;
        platformViews[p.platform] = (platformViews[p.platform] ?? 0) + v0;
        if (v0 >= 10000) breakoutCount++;
        if (!bestPost || v0 > bestPost.views) {
          const creative = await ctx.db.get(p.creativeId);
          bestPost = { hook: creative?.hook ?? "top creative", views: v0, platform: p.platform };
        }
        const creative = await ctx.db.get(p.creativeId);
        if (creative?.hook) hookViews.set(creative.hook, (hookViews.get(creative.hook) ?? 0) + v0);
      }

      for (const o of orders) {
        if (o.createdAt >= since) revenue += o.totalUsd;
        if (o.fulfillmentStatus === "received") openOrders++;
      }

      for (const p of products) {
        const m = p.contributionMarginPct ?? (p.priceUsd > 0 ? ((p.priceUsd - p.cogsUsd - p.shippingUsd) / p.priceUsd) * 100 : null);
        if (m != null && (!bestMargin || m > bestMargin.margin)) bestMargin = { title: p.title, margin: m };
      }
    }

    // RULE 1 — top hook outperforming the rest (ratio vs median)
    const hooks = [...hookViews.entries()].sort((a, b) => b[1] - a[1]);
    if (hooks.length >= 2 && hooks[0][1] > 0) {
      const top = hooks[0];
      const rest = hooks.slice(1);
      const restAvg = rest.reduce((s, h) => s + h[1], 0) / rest.length || 1;
      const ratio = top[1] / restAvg;
      if (ratio >= 1.6) {
        insights.push({
          id: "top-hook",
          icon: "flame",
          tone: "signal",
          headline: `"${top[0]}" hook is your breakout angle`,
          stat: `${ratio.toFixed(1)}× the average hook reach — scale this creative line.`,
          action: { label: "Generate more", href: "/content" },
        });
      }
    }

    // RULE 2 — content-fit milestone
    if (breakoutCount > 0) {
      insights.push({
        id: "content-fit",
        icon: "spark",
        tone: "live",
        headline: `Content-fit gate cleared (${breakoutCount} post${breakoutCount > 1 ? "s" : ""} > 10k)`,
        stat: `Organic demand is proven — green-light paid amplification.`,
        action: { label: "Review approvals", href: "/approvals" },
      });
    } else if (bestPost && bestPost.views > 0) {
      const pct = Math.round((bestPost.views / 10000) * 100);
      insights.push({
        id: "fit-progress",
        icon: "research",
        tone: "cyan",
        headline: `${pct}% to the 10k content-fit milestone`,
        stat: `Best post: ${bestPost.views.toLocaleString()} views on ${bestPost.platform}. Keep iterating the winning hook.`,
        action: { label: "See distribution", href: "/posts" },
      });
    }

    // RULE 3 — platform concentration
    const pv = Object.entries(platformViews).filter(([, v0]) => v0 > 0).sort((a, b) => b[1] - a[1]);
    if (pv.length >= 1 && totalViews > 0) {
      const [topP, topV] = pv[0];
      const share = (topV / totalViews) * 100;
      if (share >= 55) {
        insights.push({
          id: "platform-skew",
          icon: "distribution",
          tone: "violet",
          headline: `${topP[0].toUpperCase() + topP.slice(1)} carries ${share.toFixed(0)}% of reach`,
          stat: `Concentration risk — diversify cadence to the other platforms.`,
          action: { label: "Open distribution", href: "/posts" },
        });
      }
    }

    // RULE 4 — pending approvals nudge (money/ban-risk paused)
    if (pending > 0) {
      insights.push({
        id: "pending",
        icon: "approvals",
        tone: "pending",
        headline: `${pending} action${pending > 1 ? "s" : ""} awaiting your call`,
        stat: `Money / ban-risk moves are paused until approved.`,
        action: { label: "Review now", href: "/approvals" },
      });
    }

    // RULE 5 — open fulfillment
    if (openOrders > 0) {
      insights.push({
        id: "fulfillment",
        icon: "truck",
        tone: "cyan",
        headline: `${openOrders} order${openOrders > 1 ? "s" : ""} pending fulfillment`,
        stat: `Awaiting hand-off to the CJ supplier loop.`,
        action: { label: "View orders", href: "/posts" },
      });
    }

    // RULE 6 — best-margin product (only if nothing more urgent fills the slot)
    if (bestMargin && insights.length < 4) {
      insights.push({
        id: "margin",
        icon: "package",
        tone: "live",
        headline: `${bestMargin.title} leads on contribution margin`,
        stat: `${bestMargin.margin.toFixed(0)}% margin — prioritise it in collections & creative.`,
        action: { label: "See products", href: "/research" },
      });
    }

    // priority order, cap at 4
    const priority = ["top-hook", "content-fit", "fit-progress", "pending", "platform-skew", "fulfillment", "margin"];
    insights.sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));

    return { insights: insights.slice(0, 4), computedAt: Date.now(), windowDays: window };
  },
});
