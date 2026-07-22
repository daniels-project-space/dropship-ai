import { query as baseQuery, mutation as baseMutation } from "./_generated/server";

async function requireOperatorIdentity(ctx: { auth: { getUserIdentity: () => Promise<{ subject?: string } | null> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.subject !== "dropship-ai:operator" && identity?.subject !== "dropship-ai:service") {
    throw new Error("UNAUTHENTICATED: an operator or service identity is required");
  }
}

/** Wrap every public Convex function so direct deployment calls fail closed. */
export const query: typeof baseQuery = ((definition: any) =>
  baseQuery({
    ...definition,
    handler: async (ctx: any, args: any) => {
      await requireOperatorIdentity(ctx);
      return definition.handler(ctx, args);
    },
  })) as typeof baseQuery;

export const mutation: typeof baseMutation = ((definition: any) =>
  baseMutation({
    ...definition,
    handler: async (ctx: any, args: any) => {
      await requireOperatorIdentity(ctx);
      return definition.handler(ctx, args);
    },
  })) as typeof baseMutation;
