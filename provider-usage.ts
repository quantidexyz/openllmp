import { Schema as S } from "effect";

/**
 * Uniform usage snapshot returned by `POST /api/providers/{slug}/usage`.
 *
 * Each OAuth-backed provider reports usage in a wildly different shape:
 *
 *   - Anthropic Pro/Max ("claude_code") exposes `anthropic-ratelimit-
 *     unified-*` response headers on every `/v1/messages` call (and on
 *     `count_tokens`, which is free) — a percent-remaining + reset
 *     timestamp for the rolling 5h window.
 *   - ChatGPT Codex ("chatgpt") exposes a `backend-api/me` endpoint
 *     with subscription plan + entitlements; no per-window quota.
 *   - Kimi Code has NO documented per-user quota endpoint, so we fall
 *     back to a count of THIS gateway's own calls (from
 *     `public.requests`) for the current day.
 *
 * Rather than push that variance into the client, the server
 * normalises every provider into this discriminated union. The UI
 * branches on `kind` and renders accordingly.
 */
/** One quota window — Claude has 5h + 7d; Codex has primary + secondary. */
export const ProviderUsageWindow = S.Struct({
  /** Human-readable window label — "5-hour", "7-day", "Sonnet 7-day", etc. */
  label: S.String,
  /** 0–100 used percentage in this window. */
  percent_used: S.Number,
  /** Unix epoch milliseconds when this window resets, when known. */
  reset_at_ms: S.NullOr(S.Number),
});
export type TProviderUsageWindow = S.Schema.Type<typeof ProviderUsageWindow>;

export const ProviderUsageSnapshot = S.Union(
  /**
   * One or more quota windows + an overall status. Claude's
   * `claude.ai/api/organizations/{id}/usage` returns five_hour +
   * seven_day + optional Sonnet/Opus-scoped 7-day windows; Codex's
   * `chatgpt.com/backend-api/wham/usage` returns primary_window +
   * secondary_window. Both flatten into this list.
   */
  S.Struct({
    kind: S.Literal("quota"),
    status: S.Literal("allowed", "allowed_warning", "rejected"),
    /** Optional plan/tier shown alongside the bars. */
    plan: S.optional(S.String),
    windows: S.Array(ProviderUsageWindow),
    /** Short human-readable note ("Pro plan — 5h window"). */
    note: S.String,
    /**
     * Unix epoch ms when these figures were last fetched LIVE from the
     * vendor. Stamped by the daemon's usage cache when it serves a cached
     * snapshot; lets the UI show "updated Xm ago". Absent on a fresh read.
     */
    as_of_ms: S.optional(S.Number),
    /**
     * True when these are the LAST KNOWN GOOD figures, served because a
     * live refresh failed (typically the vendor usage endpoint is
     * rate-limited, which is independent of inference). The numbers are
     * still meaningful — just not this-instant — so the UI renders them
     * with a "cached" badge rather than an error. Absent/false on a fresh
     * read. See `packages/daemon/src/usage-cache.ts`.
     */
    stale: S.optional(S.Boolean),
  }),
  /**
   * Subscription plan / entitlements snapshot. No live quota number;
   * just "you're on plan X". Use for ChatGPT.
   */
  S.Struct({
    kind: S.Literal("plan"),
    plan: S.String,
    note: S.String,
  }),
  /**
   * Provider returned an error or doesn't surface anything usable — including
   * a provider that exposes NO usage API to the CLI token at all (Grok: xAI
   * forbids usage queries from the OAuth token). The UI shows `reason`, plus an
   * optional `link` rendered as a button to the provider's own usage / billing
   * page when the figures can only be checked there.
   */
  S.Struct({
    kind: S.Literal("unavailable"),
    reason: S.String,
    link: S.optional(S.String),
  }),
);
export type TProviderUsageSnapshot = S.Schema.Type<
  typeof ProviderUsageSnapshot
>;

/**
 * Response shape for `GET /api/credentials/{provider}/blob`. Returns
 * the user's OWN ciphertext + nonce so the browser can decrypt
 * locally and forward the plaintext token to the usage endpoint
 * above. Gated on session auth; the caller can only ever fetch
 * blobs they themselves wrote.
 */
export const CredentialBlobResponse = S.Struct({
  provider: S.String,
  ciphertext: S.String,
  nonce: S.String,
});
export type TCredentialBlobResponse = S.Schema.Type<
  typeof CredentialBlobResponse
>;
