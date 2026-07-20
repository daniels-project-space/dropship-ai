// Sample-data seeder — generates realistic, representative analytics so the
// Command Center charts & insights render beautifully for review. EVERYTHING it
// writes is scoped to sites flagged `sample: true`; `clearSampleData` deletes
// exactly those sites and their siteId-scoped children and NOTHING else, so the
// real Calm Collar brand + its creative are never touched.
//
// Honesty: while sample sites exist, dashboard.sampleStatus returns present:true,
// which lights the "SAMPLE DATA" pill in the UI. Clear it and the pill vanishes.

import { mutation } from "./authz";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// deterministic-ish pseudo-random so reseeds look stable-ish but lively
function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

type Platform = "tiktok" | "instagram" | "youtube";

async function seedBrand(
  ctx: MutationCtx,
  spec: {
    name: string;
    niche: string;
    seed: number;
    days: number;
    baseViews: number;
    rampStrength: number;
    breakoutView?: number; // one post crosses 10k when set
    products: { title: string; cogs: number; ship: number; price: number; cvr: number }[];
    orderCount: number;
    revenueScale: number;
  },
) {
  const rand = rng(spec.seed);
  const now = Date.now();

  const siteId: Id<"sites"> = await ctx.db.insert("sites", {
    name: spec.name,
    niche: spec.niche,
    status: "active",
    shopifyDomain: `${spec.name.toLowerCase().replace(/[^a-z]/g, "")}.myshopify.com`,
    minKitPriceUsd: 39,
    minBlendedMarginPct: 70,
    distributionMode: "semi_manual",
    createdAt: now - spec.days * DAY_MS,
    sample: true,
  });

  // products
  const productIds: Id<"products">[] = [];
  for (const p of spec.products) {
    const margin = ((p.price - p.cogs - p.ship) / p.price) * 100;
    const pid = await ctx.db.insert("products", {
      siteId,
      title: p.title,
      cjFromUsWarehouse: true,
      cogsUsd: p.cogs,
      shippingUsd: p.ship,
      priceUsd: p.price,
      contributionMarginPct: Math.round(margin * 10) / 10,
      status: "active",
      createdAt: now - spec.days * DAY_MS,
      sample: true,
    });
    productIds.push(pid);
  }

  // conversion metrics — daily, organic ramp curve (S-shaped growth)
  for (let i = spec.days - 1; i >= 0; i--) {
    const t = (spec.days - 1 - i) / (spec.days - 1); // 0→1
    const growth = 1 / (1 + Math.exp(-(t - 0.45) * 9)); // logistic ramp
    const day = dayKey(now - i * DAY_MS);
    for (let pi = 0; pi < productIds.length; pi++) {
      const p = spec.products[pi];
      const base = spec.baseViews * (0.4 + pi === 0 ? 1 : 0.55);
      const pageviews = Math.round((base + base * spec.rampStrength * growth) * (0.75 + rand() * 0.5));
      const atc = 0.07 + growth * 0.06 + rand() * 0.02;
      const cvr = Math.max(0.004, p.cvr * (0.6 + growth * 0.7) * (0.8 + rand() * 0.4));
      await ctx.db.insert("conversionMetrics", {
        siteId,
        productId: productIds[pi],
        day,
        pageviews,
        addToCartRate: Math.round(atc * 1000) / 1000,
        cvr: Math.round(cvr * 1000) / 1000,
        aovUsd: p.price * (1 + rand() * 0.3),
        refundRate: Math.round((0.01 + rand() * 0.02) * 1000) / 1000,
        sample: true,
      });
    }
  }

  // creatives + posts across platforms (~30), one breakout
  const platforms: Platform[] = ["tiktok", "instagram", "youtube"];
  const hooks = [
    "Lick-mat calm hack",
    "Snuffle vs lick-mat",
    "5-second anxiety fix",
    "Vet-approved wind-down",
    "Why your dog paces at night",
    "The $39 calm kit",
    "ASMR for anxious dogs",
    "Crate-training in 3 days",
  ];
  const postCount = 30;
  const breakoutIdx = spec.breakoutView ? Math.floor(postCount * 0.7) : -1;
  for (let i = 0; i < postCount; i++) {
    const platform = platforms[i % platforms.length];
    const ageDays = Math.floor((1 - i / postCount) * spec.days);
    const publishedAt = now - ageDays * DAY_MS;
    const ramp = i / postCount;
    let views = Math.round((400 + 5200 * ramp) * (0.5 + rand()));
    if (i === breakoutIdx && spec.breakoutView) views = spec.breakoutView;
    const engagement = Math.round(views * (0.03 + rand() * 0.05));

    const creativeId: Id<"creatives"> = await ctx.db.insert("creatives", {
      siteId,
      productId: productIds[i % productIds.length],
      kind: i % 3 === 0 ? "ai_spokesperson" : i % 3 === 1 ? "product_demo" : "ai_broll",
      r2Key: `sample/${spec.name}/creative-${i}.mp4`,
      aiGenerated: true,
      aiLabelRequired: true,
      hook: hooks[i % hooks.length],
      status: "approved",
      createdAt: publishedAt,
      sample: true,
    });
    await ctx.db.insert("posts", {
      siteId,
      creativeId,
      platform,
      status: "published",
      publishedAt,
      externalPostId: `sample-${platform}-${i}`,
      views,
      engagement,
      sample: true,
    });
  }

  // orders (revenue) spread across the recent window with growth
  for (let i = 0; i < spec.orderCount; i++) {
    const t = i / Math.max(1, spec.orderCount - 1);
    const ageDays = Math.floor((1 - t) * Math.min(spec.days, 60));
    const total = (spec.products[0].price + rand() * 22) * spec.revenueScale;
    await ctx.db.insert("orders", {
      siteId,
      shopifyOrderId: `sample-${spec.seed}-${1000 + i}`,
      fulfillmentStatus: i % 7 === 0 ? "received" : i % 5 === 0 ? "shipped" : "delivered",
      totalUsd: Math.round(total * 100) / 100,
      createdAt: now - ageDays * DAY_MS - Math.floor(rand() * DAY_MS),
      sample: true,
    });
  }

  // a couple of pending actions (drives the approvals badge realistically)
  for (let i = 0; i < 2; i++) {
    await ctx.db.insert("actions", {
      siteId,
      type: i === 0 ? "spark_ad" : "reorder_collection",
      params: { note: "sample proposed action" },
      riskTier: "human_gated",
      status: "pending_approval",
      rationale:
        i === 0
          ? "Lick-mat hook is outperforming; propose a small spark-ad boost behind the top organic post."
          : "Reorder PDP collection to surface the highest-CVR product first.",
      confidence: 0.78 + rand() * 0.15,
      proposedAt: now - Math.floor(rand() * 2 * DAY_MS),
      sample: true,
    });
  }

  // one running experiment
  await ctx.db.insert("experiments", {
    siteId,
    productId: productIds[0],
    hypothesis: "Bundle pricing at $44 lifts AOV without hurting CVR.",
    variantA: { price: 39 },
    variantB: { price: 44 },
    status: "running",
    startedAt: now - 9 * DAY_MS,
    sample: true,
  });

  // audit trail
  const events = [
    ["product_imported", { title: spec.products[0].title }],
    ["creative_generated", { hook: hooks[0] }],
    ["post_published", { platform: "tiktok", views: spec.breakoutView ?? 4200 }],
    ["action_proposed", { type: "spark_ad" }],
    ["content_fit_check", { passed: !!spec.breakoutView }],
    ["order_received", { totalUsd: spec.products[0].price }],
  ] as const;
  for (let i = 0; i < events.length; i++) {
    await ctx.db.insert("auditLog", {
      siteId,
      event: events[i][0],
      detail: events[i][1],
      at: now - i * 3 * 60 * 60 * 1000,
      sample: true,
    });
  }

  return siteId;
}

export const seedSampleData = mutation({
  args: {},
  handler: async (ctx) => {
    // idempotent: clear any prior sample data first
    await clearInternal(ctx);

    const a = await seedBrand(ctx, {
      name: "Calm Collar",
      niche: "Dog anxiety & calm [sample]",
      seed: 101,
      days: 80,
      baseViews: 520,
      rampStrength: 5.5,
      breakoutView: 14200, // crosses the 10k content-fit gate
      products: [
        { title: "Calm Lick-Mat Kit", cogs: 6.2, ship: 3.1, price: 39, cvr: 0.022 },
        { title: "Snuffle Calm Bundle", cogs: 8.4, ship: 3.4, price: 49, cvr: 0.018 },
        { title: "Night Wind-Down Spray", cogs: 4.1, ship: 2.2, price: 29, cvr: 0.015 },
      ],
      orderCount: 64,
      revenueScale: 1,
    });

    const b = await seedBrand(ctx, {
      name: "Pawthentic",
      niche: "Premium dog enrichment [sample]",
      seed: 202,
      days: 62,
      baseViews: 380,
      rampStrength: 3.8,
      products: [
        { title: "Enrichment Puzzle Trio", cogs: 9.5, ship: 4.0, price: 54, cvr: 0.017 },
        { title: "Slow-Feed Bowl", cogs: 5.0, ship: 2.6, price: 34, cvr: 0.013 },
      ],
      orderCount: 31,
      revenueScale: 1.1,
    });

    return { ok: true, sampleSites: [a, b] };
  },
});

// shared clear used by both the public mutation and seed's idempotent reset.
// Deletes EVERY siteId-scoped child row of each sample site, then the site. Each
// table is read through its own first-by-siteId index so reads stay index-driven.
async function clearInternal(ctx: MutationCtx) {
  const sites = await ctx.db.query("sites").withIndex("by_sample", (q) => q.eq("sample", true)).take(200);
  let deleted = 0;
  for (const s of sites) {
    const sid = s._id;
    const batches = await Promise.all([
      ctx.db.query("products").withIndex("by_site", (q) => q.eq("siteId", sid)).take(5000),
      ctx.db.query("conversionMetrics").withIndex("by_site_day", (q) => q.eq("siteId", sid)).take(20000),
      ctx.db.query("creatives").withIndex("by_site_status", (q) => q.eq("siteId", sid)).take(5000),
      ctx.db.query("posts").withIndex("by_site_status", (q) => q.eq("siteId", sid)).take(5000),
      ctx.db.query("orders").withIndex("by_site", (q) => q.eq("siteId", sid)).take(5000),
      ctx.db.query("actions").withIndex("by_site_status", (q) => q.eq("siteId", sid)).take(5000),
      ctx.db.query("auditLog").withIndex("by_site_at", (q) => q.eq("siteId", sid)).take(5000),
      ctx.db.query("experiments").withIndex("by_site_status", (q) => q.eq("siteId", sid)).take(5000),
    ]);
    for (const rows of batches) {
      for (const r of rows) {
        await ctx.db.delete(r._id);
        deleted++;
      }
    }
    await ctx.db.delete(sid);
    deleted++;
  }
  return deleted;
}

export const clearSampleData = mutation({
  args: {},
  handler: async (ctx) => {
    const deleted = await clearInternal(ctx);
    return { ok: true, deleted };
  },
});
