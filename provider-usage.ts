import { Schema as S } from "effect";

/**
 * Uniform usage snapshot — THE canonical struct every provider's usage
 * read reduces into, at the daemon delegation boundary.
 *
 * Each OAuth-backed provider reports usage in a wildly different shape,
 * and vendors RESHAPE those payloads without notice (OpenAI has already
 * collapsed Codex's 5h-primary + weekly-secondary pair into a single
 * weekly primary window mid-flight):
 *
 *   - Anthropic Pro/Max ("claude_code"): OAuth usage endpoint with
 *     `utilization` + `resets_at` per rolling window (5h, 7d, and
 *     model-scoped 7d windows).
 *   - ChatGPT Codex ("chatgpt"): `backend-api/wham/usage` with
 *     `used_percent` + `limit_window_seconds` + `reset_at` windows under
 *     `rate_limit`.
 *   - Kimi Code: `{ usage, limits[] }` rows; Grok: a monthly quota.
 *
 * Rather than push that variance into the client, each delegate reduces
 * its vendor payload into this ONE discriminated union as early as
 * possible — everything downstream (relay persistence, the calibration
 * estimator, the UI) only ever sees this shape, so a vendor-side change
 * is absorbed entirely inside that provider's reducer.
 */
/** One quota window — e.g. Claude's 5h + 7d, Codex's weekly. */
export const ProviderUsageWindow = S.Struct({
  /**
   * Human-readable window label — "5-hour", "7-day", "Sonnet 7-day", etc.
   * Doubles as the window's IDENTITY downstream (the calibration series
   * key), so reducers derive it from the window's DURATION whenever the
   * vendor states one — vendor-positional names ("Primary") survive a
   * reshape with a different meaning; a duration label re-keys instead.
   */
  label: S.String,
  /** 0–100 used percentage in this window. */
  percent_used: S.Number,
  /** Unix epoch milliseconds when this window resets, when known. */
  reset_at_ms: S.NullOr(S.Number),
  /**
   * Window length in milliseconds, when the vendor states one (e.g.
   * Codex's `limit_window_seconds`, Claude's key-implied 5h/7d). Absent
   * when the vendor only names the window.
   */
  window_ms: S.optional(S.Number),
});
export type TProviderUsageWindow = S.Schema.Type<typeof ProviderUsageWindow>;

export const ProviderUsageSnapshot = S.Union(
  /**
   * One or more quota windows + an overall status. Claude's
   * shared plan meters (`five_hour` + `seven_day`) and Codex's
   * `rate_limit` windows both flatten into this list. Model-scoped
   * Claude caps (Fable / Opus / Sonnet) and Codex promo pools (Spark)
   * ride on `extra_pools` instead — they meter different usage and
   * must not drive status or the tightest-window face.
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
    /**
     * Feature-scoped pools metering DIFFERENT usage than `windows` (e.g.
     * Codex's per-model promo pools under `additional_rate_limits`).
     * DISPLAY-ONLY: the relay persists only `windows` for calibration —
     * a separate pool priced against the main meter's K̂ would be wrong,
     * and pools must never become the card's tightest-window meter.
     */
    extra_pools: S.optional(S.Array(ProviderUsageWindow)),
    /**
     * Vendor credit state, when reported (Codex's `credits` +
     * `rate_limit_reset_credits`). Display-only — lets the card account
     * for capacity that exists OUTSIDE the quota windows.
     */
    credits: S.optional(
      S.Struct({
        /** Raw balance string as the vendor reports it ("0", "1250"). */
        balance: S.String,
        /** Vendor reports the balance as unlimited. */
        unlimited: S.optional(S.Boolean),
        /** Limit-reset credits available (each lifts a hit limit). */
        reset_credits: S.optional(S.Number),
      }),
    ),
  }),
  /**
   * Subscription plan / entitlements snapshot. No live quota number;
   * just "you're on plan X" — for a provider whose usage endpoint
   * exposes no per-window quota.
   */
  S.Struct({
    kind: S.Literal("plan"),
    plan: S.String,
    note: S.String,
  }),
  /**
   * Provider returned an error or doesn't surface anything usable — e.g. not
   * signed in, the vendor usage endpoint rejected the token, or the plan exposes
   * no quota window the daemon can read. The UI shows `reason`, plus an optional
   * `link` rendered as a button to the provider's own usage / billing page when
   * the figures can only be checked there.
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
