// Content factory — turns a brief into K=3 PRODUCT-FIRST creative variants, ready for review.
//
// PRODUCT-FIRST DOCTRINE (locked): each variant's hero is the PRODUCT (mat ASMR, freeze-mold
// pour, hands-only demo, before/after). AI animal footage is NOT a hero — at most a brief
// stylized supporting b-roll. Every variant is AI-touched (Flux still + synthetic voice), so
// each creative is stored aiGenerated:true → aiLabelRequired:true, and the assembler burns the
// on-screen "AI-generated" label. A creative whose label can't be burned is never emitted.
//
// Flow per variant: fal product still → fal image-to-video clip → ElevenLabs VO → assemble
// (9:16 + captions + MANDATORY label) → creatives.requestGen(status:"review", r2Key).
//
// `scheduleApprovedCreative` runs on approval: it pulls the approved creative, passes the label
// gate, and distributes (Ayrshare fan-out, or a semi-manual post row).
import { task, logger } from "@trigger.dev/sdk/v3";
import { convexClient, api } from "../lib/convexClient";
import type { Id } from "../../convex/_generated/dataModel";
import { falProductImage, falProductClip } from "../lib/gen/fal";
import { tts } from "../lib/gen/tts";
import { assemble } from "../lib/assemble";
import { distribute, reconcileAyrsharePost, type CreativeForPublish } from "../lib/distribute";
import { providerDeliveryDecision } from "../lib/distributionState";
import { getSignedUrl } from "../lib/storage";

type Brief = {
  siteId: string;
  productId?: string;
  // product-first scene prompts (PRODUCT as subject, not a realistic dog)
  hooks?: string[];          // optional caption/VO hooks; defaults supplied below
  scenePrompt?: string;      // product still prompt; default = Calm Dog lick-mat scene
  variants?: number;         // K, default 3
};

const DEFAULT_SCENE =
  "close-up product photography of a textured silicone dog lick mat smeared with creamy peanut " +
  "butter and yogurt, soft natural window light, calm muted palette, shallow depth of field, " +
  "no animals in frame, premium pet-enrichment brand look, vertical 9:16";

const DEFAULT_HOOKS = [
  "The 3-minute trick that calms an anxious dog.",
  "Watch this lick mat melt the zoomies away.",
  "Vet-loved enrichment your dog actually slows down for.",
];

export const contentFactory = task({
  id: "content-factory",
  maxDuration: 600,
  run: async (brief: Brief) => {
    const convex = convexClient();
    const siteId = brief.siteId as Id<"sites">;
    const K = Math.max(1, Math.min(brief.variants ?? 3, 3));
    const hooks = brief.hooks ?? DEFAULT_HOOKS;
    const scene = brief.scenePrompt ?? DEFAULT_SCENE;
    const stamp = Date.now();
    const created: Array<{ creativeId: string; r2Key: string }> = [];

    for (let i = 0; i < K; i++) {
      const hook = hooks[i % hooks.length];
      const base = `creatives/${siteId}/${stamp}-v${i}`;
      try {
        // 1) product-first hero still
        const still = await falProductImage(`${scene}, variation ${i + 1}`, `${base}-still.jpg`);
        // 2) image-to-video so motion stays anchored to a real product frame
        const stillUrl = await getSignedUrl(still.r2Key, 600);
        const clip = await falProductClip(stillUrl, "gentle slow push-in, subtle texture motion, calm", `${base}-clip.mp4`);
        // 3) voiceover
        const vo = await tts(hook, `${base}-vo.mp3`);
        // 4) assemble with MANDATORY burned-in AI-disclosure label
        const finished = await assemble({
          productClipR2Key: clip.r2Key,
          voiceoverR2Key: vo.r2Key,
          captions: hook,
          aiLabelRequired: true, // AI-touched → label is non-negotiable
          outR2Key: `${base}-final.mp4`,
        });
        if (!finished.labelBurned) {
          // assemble() throws rather than returning unlabeled, but guard anyway.
          throw new Error("content-factory: assembled asset missing AI label — discarding variant");
        }
        // 5) persist as a reviewable creative (aiGenerated → aiLabelRequired enforced in convex)
        const { creativeId } = await convex.mutation(api.creatives.requestGen, {
          siteId,
          productId: brief.productId as Id<"products"> | undefined,
          kind: "product_demo",
          aiGenerated: true,
          hook,
          r2Key: finished.r2Key,
          labelBurned: finished.labelBurned,
          status: "review",
        });
        created.push({ creativeId, r2Key: finished.r2Key });
        logger.info("content-factory variant ready", { creativeId, variant: i });
      } catch (err) {
        logger.error("content-factory variant failed", { variant: i, error: String(err).slice(0, 300) });
      }
    }

    return { siteId, requested: K, created: created.length, creatives: created };
  },
});

// On approval → distribute. Caller (UI approve action or a webhook) triggers this with the id.
export const scheduleApprovedCreative = task({
  id: "schedule-approved-creative",
  run: async (payload: { creativeId: string; caption?: string; dispatchKey?: string }) => {
    const convex = convexClient();
    const creativeId = payload.creativeId as Id<"creatives">;
    const creative = await convex.query(api.creatives.get, { creativeId });
    if (!creative) throw new Error(`creative ${creativeId} not found`);
    if (creative.status !== "approved") {
      logger.warn("schedule-approved-creative: not approved, skipping", { creativeId, status: creative.status });
      return { skipped: true, reason: `status ${creative.status}` };
    }
    if (creative.aiLabelRequired && creative.labelBurned !== true) {
      return { skipped: true, reason: "AI disclosure burn was not verified", creativeId };
    }
    const site = await convex.query(api.sites.get, { siteId: creative.siteId as Id<"sites"> });
    if (!site || site.sample === true) {
      return { skipped: true, reason: "sample or missing site cannot distribute", creativeId };
    }

    const idempotencyKey = payload.dispatchKey ?? `distribution:${creativeId}`;
    const target = `creative-distribution:${creativeId}`;
    const queued = await convex.mutation(api.ops.enqueue, {
      siteId: creative.siteId as Id<"sites">, kind: "creative.distribute", target, idempotencyKey, traceId: idempotencyKey,
      payload: { creativeId, caption: payload.caption },
    });
    if (queued.duplicate && queued.status === "delivered") return { skipped: true, reason: "already distributed", creativeId };
    const lock = await convex.mutation(api.ops.claimTarget, { target, owner: idempotencyKey, leaseMs: 10 * 60_000 });
    if (!lock.acquired) return { skipped: true, reason: "target locked", creativeId };

    try {
      // Create the local schedule before marking the external attempt. A crash at any point
      // therefore leaves a durable post ledger entry, while a crash after `processing` can only
      // move to receipt reconciliation and can never issue a second provider POST.
      const scheduledPosts: Record<string, Id<"posts">> = {};
      for (const platform of ["tiktok", "instagram", "youtube"] as const) {
        const post = await convex.mutation(api.posts.schedule, {
          siteId: creative.siteId as Id<"sites">, creativeId, platform, status: "scheduled",
        });
        scheduledPosts[platform] = post.postId;
      }

      const outbox = queued.duplicate ? await convex.query(api.ops.getOutboxByKey, { idempotencyKey }) : undefined;
      const deliveryDecision = providerDeliveryDecision((outbox?.status ?? queued.status) as "pending" | "processing" | "delivered" | "failed" | "ambiguous");
      if (deliveryDecision === "already_delivered") return { skipped: true, reason: "already distributed", creativeId };
      if (deliveryDecision === "reconcile_required") {
        if (!outbox?.providerReceiptId) {
          await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: "provider_receipt_missing" });
          return { mode: "reconcile_required", creativeId, reason: "provider attempt has no receipt; automatic repost is forbidden" };
        }
        const reconciliation = await reconcileAyrsharePost(outbox.providerReceiptId);
        for (const [platform, externalPostId] of Object.entries(reconciliation.postIds)) {
          const postId = scheduledPosts[platform];
          if (postId) await convex.mutation(api.posts.markPublished, { postId, externalPostId });
        }
        if (reconciliation.missingPlatforms.length) {
          await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: "provider_receipt_incomplete" });
          return { mode: "reconcile_required", creativeId, reason: "provider receipt is incomplete; automatic repost is forbidden" };
        }
        await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", detail: { mode: "ayrshare", reconciled: true } });
        await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey });
        return { mode: "ayrshare", posts: Object.keys(reconciliation.postIds).length, reconciled: true };
      }

      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "processing" });
      const mediaUrl = await getSignedUrl(creative.r2Key, 3600);
      const forPublish: CreativeForPublish = {
        aiGenerated: creative.aiGenerated,
        aiLabelRequired: creative.aiLabelRequired,
        labelBurned: creative.labelBurned === true,
        mediaUrl,
        caption: payload.caption ?? creative.hook ?? "Calm Dog enrichment.",
      };

      // distribute() runs assertLabelGate() first — hard stop on any unlabeled AI asset.
      const result = await distribute(forPublish, { distributionMode: site.distributionMode, idempotencyKey });

      if (result.mode === "ayrshare" && result.ok) {
        for (const [platform, externalPostId] of Object.entries(result.postIds)) {
          const postId = scheduledPosts[platform];
          if (postId) await convex.mutation(api.posts.markPublished, { postId, externalPostId });
        }
        if (result.missingPlatforms.length) {
          await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "ambiguous", providerReceiptId: result.providerReceiptId, error: "provider_receipt_missing", detail: { mode: "ayrshare", missingPlatforms: result.missingPlatforms, providerErrors: result.providerErrors ?? null } });
          await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: "provider_receipt_missing" });
          return { mode: "reconcile_required", creativeId, reason: "provider response omitted one or more post receipts; automatic repost is forbidden" };
        }
        await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", providerReceiptId: result.providerReceiptId, detail: { mode: "ayrshare", platforms: result.platforms } });
        await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey });
        return { mode: "ayrshare", posts: result.platforms.length };
      }

      if (result.mode === "semi_manual") {
        // cold-start: convert the pre-created rows to an explicit manual directive.
        for (const postId of Object.values(scheduledPosts)) await convex.mutation(api.posts.markAwaitingManualPublish, { postId: postId as Id<"posts"> });
        await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "delivered", detail: { mode: "semi_manual" } });
        await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey });
        return { mode: "semi_manual", posts: 3, reason: result.reason };
      }

      logger.error("schedule-approved-creative: distribution blocked", { creativeId, result });
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "failed", error: result.ok ? "unknown" : result.reason });
      await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: result.ok ? "unknown" : result.reason });
      return { mode: "blocked", reason: result.ok ? "unknown" : result.reason };
    } catch (error) {
      // Once processing was durably recorded, the network call may have reached Ayrshare. Do not
      // let Trigger retry it as a fresh post; preserve reconciliation instead.
      await convex.mutation(api.ops.markOutbox, { outboxId: queued.outboxId, status: "ambiguous", error: String(error).slice(0, 500) });
      await convex.mutation(api.posts.completeDistributionDispatch, { creativeId, dispatchKey: idempotencyKey, reconciliationRequired: true, error: "provider_response_ambiguous" });
      return { mode: "reconcile_required", creativeId, reason: "provider response was ambiguous; automatic repost is forbidden" };
    } finally {
      await convex.mutation(api.ops.releaseTarget, { target, owner: idempotencyKey });
    }
  },
});
