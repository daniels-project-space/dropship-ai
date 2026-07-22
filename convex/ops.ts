// Durable execution primitives for all external side effects. Convex mutations are serializable,
// so the read/claim/write sequence below is atomic even when Trigger retries concurrently.
import { mutation, query } from "./authz";
import { v } from "convex/values";

const outboxStatus = v.union(v.literal("pending"), v.literal("processing"), v.literal("delivered"), v.literal("failed"), v.literal("ambiguous"));

/** Compare an idempotent request by value, not by its caller-controlled key alone. */
function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("outbox payload must contain finite numbers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
  }
  throw new Error("outbox payload must be JSON data");
}

function hasExactOutboxBinding(existing: any, incoming: { siteId: unknown; kind: string; target: string; idempotencyKey: string; traceId: string; payload: unknown }) {
  return existing.siteId === incoming.siteId
    && existing.kind === incoming.kind
    && existing.target === incoming.target
    && existing.idempotencyKey === incoming.idempotencyKey
    && existing.traceId === incoming.traceId
    && canonicalValue(existing.payload) === canonicalValue(incoming.payload);
}

async function requireServiceIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }) {
  if ((await ctx.auth.getUserIdentity())?.subject !== "dropship-ai:service") throw new Error("UNAUTHENTICATED: operations runtime requires the service identity");
}

export const claimTarget = mutation({
  args: { target: v.string(), owner: v.string(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, { target, owner, leaseMs }) => {
    await requireServiceIdentity(ctx);
    const now = Date.now();
    const existing = await ctx.db.query("targetLocks").withIndex("by_target", (q) => q.eq("target", target)).first();
    // A duplicate Trigger delivery must not enter a live lease, even with the same owner:
    // the provider idempotency key alone cannot protect simultaneous submissions.
    if (existing && existing.expiresAt > now) {
      return { acquired: false, owner: existing.owner, expiresAt: existing.expiresAt, reused: existing.owner === owner };
    }
    if (existing) await ctx.db.delete(existing._id);
    const expiresAt = now + Math.min(Math.max(leaseMs ?? 5 * 60_000, 1_000), 15 * 60_000);
    await ctx.db.insert("targetLocks", { target, owner, expiresAt, createdAt: now });
    return { acquired: true, expiresAt };
  },
});

export const releaseTarget = mutation({
  args: { target: v.string(), owner: v.string() },
  handler: async (ctx, { target, owner }) => {
    await requireServiceIdentity(ctx);
    const existing = await ctx.db.query("targetLocks").withIndex("by_target", (q) => q.eq("target", target)).first();
    if (!existing || existing.owner !== owner) return { released: false };
    await ctx.db.delete(existing._id);
    return { released: true };
  },
});

export const enqueue = mutation({
  args: {
    siteId: v.id("sites"), kind: v.string(), target: v.string(), idempotencyKey: v.string(), traceId: v.string(), payload: v.any(),
  },
  handler: async (ctx, args) => {
    await requireServiceIdentity(ctx);
    const existing = await ctx.db.query("outbox").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", args.idempotencyKey)).first();
    // A key collision with different immutable inputs is a binding violation, not a replay.
    if (existing) {
      if (!hasExactOutboxBinding(existing, args)) throw new Error("outbox idempotency key is already bound to different immutable input");
      return { outboxId: existing._id, duplicate: true, status: existing.status };
    }
    const now = Date.now();
    const outboxId = await ctx.db.insert("outbox", { ...args, status: "pending", attempts: 0, availableAt: now, createdAt: now });
    await ctx.db.insert("traces", { traceId: args.traceId, siteId: args.siteId, operation: args.kind, target: args.target, idempotencyKey: args.idempotencyKey, status: "started", detail: {}, startedAt: now });
    return { outboxId, duplicate: false, status: "pending" as const };
  },
});

export const markOutbox = mutation({
  args: { outboxId: v.id("outbox"), status: outboxStatus, detail: v.optional(v.any()), error: v.optional(v.string()), retryAt: v.optional(v.number()), providerReceiptId: v.optional(v.string()) },
  handler: async (ctx, { outboxId, status, detail, error, retryAt, providerReceiptId }) => {
    await requireServiceIdentity(ctx);
    const row = await ctx.db.get(outboxId);
    if (!row) throw new Error(`outbox ${outboxId} not found`);
    const now = Date.now();
    if (row.status === "delivered" && status !== "delivered") throw new Error("delivered outbox cannot be reopened");
    if (providerReceiptId && row.providerReceiptId && row.providerReceiptId !== providerReceiptId) throw new Error("outbox already has a different provider receipt");
    await ctx.db.patch(outboxId, {
      status,
      attempts: row.attempts + (status === "processing" ? 1 : 0),
      availableAt: retryAt ?? row.availableAt,
      deliveredAt: status === "delivered" ? now : row.deliveredAt,
      lastError: error,
      providerReceiptId: providerReceiptId ?? row.providerReceiptId,
    });
    const trace = await ctx.db.query("traces").withIndex("by_trace_id", (q) => q.eq("traceId", row.traceId)).first();
    if (trace && (status === "delivered" || status === "failed" || status === "ambiguous")) {
      await ctx.db.patch(trace._id, { status: status === "delivered" ? "succeeded" : status === "ambiguous" ? "skipped" : "failed", detail: detail ?? (error ? { error } : {}), finishedAt: now });
    }
    return outboxId;
  },
});

export const getOutboxByKey = query({
  args: { idempotencyKey: v.string() },
  handler: async (ctx, { idempotencyKey }) => ctx.db.query("outbox").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", idempotencyKey)).first(),
});
