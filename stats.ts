import { Schema as S } from "effect";

export const RequestStatus = S.Literal(
  "success",
  "error",
  "timeout",
  "rate_limited",
);
export type TRequestStatus = S.Schema.Type<typeof RequestStatus>;

export const RequestRow = S.Struct({
  id: S.String,
  user_id: S.String,
  key_id: S.String,
  model: S.String,
  provider: S.String,
  /** Canonical prompt tokens — INCLUDES the two cache columns below. */
  tokens_in: S.Number,
  tokens_out: S.Number,
  /**
   * Cache split of `tokens_in`. Kept so a row can be re-priced at the cache
   * rates (`cache_read_per_million` / `cache_write_per_million`) rather than
   * the full input rate — see `priceSubscriptionUsage` in `handlers/stats.ts`.
   * Rows written before these columns existed carry 0.
   */
  cached_tokens: S.Number,
  cache_creation_tokens: S.Number,
  cost_usd: S.Number,
  latency_ms: S.Number,
  status: RequestStatus,
  error: S.NullOr(S.String),
  idempotency_key: S.NullOr(S.String),
  ts: S.String,
});
export type TRequestRow = S.Schema.Type<typeof RequestRow>;

export const ModelBreakdown = S.Struct({
  model: S.String,
  provider: S.String,
  requests: S.Number,
  tokens_in: S.Number,
  tokens_out: S.Number,
  cost_usd: S.Number,
});
export type TModelBreakdown = S.Schema.Type<typeof ModelBreakdown>;

export const DailyBucket = S.Struct({
  day: S.String,
  requests: S.Number,
  tokens_in: S.Number,
  tokens_out: S.Number,
  cost_usd: S.Number,
});
export type TDailyBucket = S.Schema.Type<typeof DailyBucket>;

/**
 * All-device subscription usage INFERRED from the vendor quota meter, per
 * provider — the calibration estimator's output (docs/proposals/
 * inferred-subscription-usage-calibration.md). Every dollar figure is a
 * LOWER bound by construction (censored one-sided estimator), so the UI
 * may present them as "≥ $X"; `tightness` near 1 means the estimate has
 * converged and can read as "≈".
 */
export const InferredProviderUsage = S.Struct({
  provider: S.String,
  /** API-eq value of 30-day usage the gateway never saw (other devices /
   *  raw CLI / vendor apps). Lower bound. */
  off_gateway_usd: S.Number,
  /** The in-progress window's figures, when a calibrated series has a
   *  current reading — drives the providers-page headroom line. */
  current_window: S.NullOr(
    S.Struct({
      window_label: S.String,
      percent_used: S.Number,
      used_usd: S.Number,
      headroom_usd: S.Number,
      bracket_usd: S.Number,
    }),
  ),
  /** Valid calibration pairs behind K̂ — 0 pairs never reaches here. */
  pair_count: S.Number,
  /** 0–1; ≥ ~0.8 reads as converged ("≈" instead of "≥"). */
  tightness: S.Number,
});
export type TInferredProviderUsage = S.Schema.Type<
  typeof InferredProviderUsage
>;

export const UserStats = S.Struct({
  total_requests: S.Number,
  total_tokens_in: S.Number,
  total_tokens_out: S.Number,
  total_cost_usd: S.Number,
  /**
   * What the same window's usage would have cost at pure metered API
   * pricing: non-subscription rows contribute their real `cost_usd`;
   * subscription rows (which log cost 0) are re-priced from the static
   * catalog pricing at API-equivalent per-token rates — PLUS the inferred
   * off-gateway subscription usage below (usage on other devices moves the
   * same quota meter the plan fee bought). Drives the overview savings bar
   * (`total_api_equivalent_cost_usd - total_cost_usd` = what the
   * subscriptions saved).
   */
  total_api_equivalent_cost_usd: S.Number,
  /**
   * Per-provider inferred all-device usage (absent providers had no
   * calibrated meter series — their contribution is 0, the pre-inference
   * behaviour). The sum of `off_gateway_usd` here is exactly the inferred
   * term inside `total_api_equivalent_cost_usd`.
   */
  inferred_subscription_usage: S.optional(S.Array(InferredProviderUsage)),
  by_model: S.Array(ModelBreakdown),
  daily: S.Array(DailyBucket),
});
export type TUserStats = S.Schema.Type<typeof UserStats>;

export const KeyStats = S.Struct({
  key_id: S.String,
  total_requests: S.Number,
  total_tokens_in: S.Number,
  total_tokens_out: S.Number,
  total_cost_usd: S.Number,
  daily: S.Array(DailyBucket),
});
export type TKeyStats = S.Schema.Type<typeof KeyStats>;

export const AdminStats = S.Struct({
  total_users: S.Number,
  active_users_7d: S.Number,
  total_requests: S.Number,
  total_cost_usd: S.Number,
  by_model: S.Array(ModelBreakdown),
  daily: S.Array(DailyBucket),
});
export type TAdminStats = S.Schema.Type<typeof AdminStats>;

// ─── Stacked / grouped requests for the overview "Recent Requests" table ─────

/**
 * A horizontal grouping of recent requests by (model, endpoint) within a
 * sliding window. The overview table renders one row per group with an
 * `N×` badge; expanding fans out the individual rows via
 * `requestItems`.
 */
export const GroupedRequest = S.Struct({
  id: S.String,
  provider: S.String,
  model: S.NullOr(S.String),
  endpoint: S.NullOr(S.String),
  count: S.Number,
  tokens_in: S.Number,
  tokens_out: S.Number,
  total_tokens: S.Number,
  /**
   * What this group actually cost on metered API billing — the summed
   * `requests.cost_usd`. Subscription groups log cost 0, so this is 0
   * for them; their price story lives in `api_equivalent_cost_usd`.
   */
  cost_usd: S.Number,
  /**
   * What this group's usage would cost at metered API pricing — set only
   * for subscription-provider groups (which log `cost_usd = 0`), re-priced
   * from the static catalog via `priceSubscriptionUsage` (same calculator
   * as the overview savings bar, cache-read/cache-write split included).
   * `null` for metered groups, whose real cost already lives in `cost_usd`.
   */
  api_equivalent_cost_usd: S.NullOr(S.Number),
  first_timestamp: S.String,
  last_timestamp: S.String,
});
export type TGroupedRequest = S.Schema.Type<typeof GroupedRequest>;

export const GroupedRequestsPagination = S.Struct({
  page: S.Number,
  page_size: S.Number,
  total_groups: S.Number,
  has_more: S.Boolean,
  has_exact_total: S.Boolean,
});
export type TGroupedRequestsPagination = S.Schema.Type<
  typeof GroupedRequestsPagination
>;

export const GroupedRequestsResponse = S.Struct({
  groups: S.Array(GroupedRequest),
  pagination: GroupedRequestsPagination,
});
export type TGroupedRequestsResponse = S.Schema.Type<
  typeof GroupedRequestsResponse
>;

/** A single request row inside an expanded group. */
export const RequestItem = S.Struct({
  id: S.String,
  model: S.NullOr(S.String),
  endpoint: S.NullOr(S.String),
  prompt_tokens: S.Number,
  completion_tokens: S.Number,
  total_tokens: S.Number,
  ts: S.String,
});
export type TRequestItem = S.Schema.Type<typeof RequestItem>;

export const RequestItemsResponse = S.Struct({
  items: S.Array(RequestItem),
});
export type TRequestItemsResponse = S.Schema.Type<typeof RequestItemsResponse>;

/**
 * Acknowledgement for `DELETE /api/stats/requests` — drops every row
 * inside one (model, endpoint, time window) group for the authed user.
 * The overview table calls this when the user clicks the trash icon
 * on a group row.
 */
export const DeleteRequestGroupResponse = S.Struct({
  ok: S.Boolean,
  deleted: S.Number,
});
export type TDeleteRequestGroupResponse = S.Schema.Type<
  typeof DeleteRequestGroupResponse
>;
