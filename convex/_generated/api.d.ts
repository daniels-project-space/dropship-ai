/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as admin from "../admin.js";
import type * as audit from "../audit.js";
import type * as creatives from "../creatives.js";
import type * as dashboard from "../dashboard.js";
import type * as experiments from "../experiments.js";
import type * as insights from "../insights.js";
import type * as metrics from "../metrics.js";
import type * as orders from "../orders.js";
import type * as ops from "../ops.js";
import type * as posts from "../posts.js";
import type * as products from "../products.js";
import type * as seed from "../seed.js";
import type * as signals from "../signals.js";
import type * as siteSecrets from "../siteSecrets.js";
import type * as sites from "../sites.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actions: typeof actions;
  admin: typeof admin;
  audit: typeof audit;
  creatives: typeof creatives;
  dashboard: typeof dashboard;
  experiments: typeof experiments;
  insights: typeof insights;
  metrics: typeof metrics;
  orders: typeof orders;
  ops: typeof ops;
  posts: typeof posts;
  products: typeof products;
  seed: typeof seed;
  signals: typeof signals;
  siteSecrets: typeof siteSecrets;
  sites: typeof sites;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
