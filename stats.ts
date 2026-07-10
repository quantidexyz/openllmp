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

export const UserStats = S.Struct({
  total_requests: S.Number,
  total_tokens_in: S.Number,
  total_tokens_out: S.Number,
  total_cost_usd: S.Number,
  /**
   * What the same window's usage would have cost at pure metered API
   * pricing: non-subscription rows contribute their real `cost_usd`;
   * subscription rows (which log cost 0) are re-priced from the static
   * catalog pricing at API-equivalent per-token rates. Drives the
   * overview savings bar (`total_api_equivalent_cost_usd -
   * total_cost_usd` = what OpenLLM subscription routing saved).
   */
  total_api_equivalent_cost_usd: S.Number,
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
