import { Schema as S } from "effect";

export const ModelCapability = S.Literal(
  "chat",
  "embedding",
  "transcription",
  "speech",
  "image_generation",
  "vision",
  "tools",
  "json_mode",
  "streaming",
  "reasoning",
);
export type TModelCapability = S.Schema.Type<typeof ModelCapability>;

// Built-in default-chain tiers. When a user has no fallback group with
// one of these names, the gateway derives a virtual chain from catalog
// entries flagged `default_tiers`, filtered to the user's available
// providers — configuration that works out of the gate with no
// onboarding step. Ordered best → cheapest; pickers prefer earlier
// entries.
export const DEFAULT_TIER_ALIASES = ["ultra", "plus", "lite"] as const;

export const DefaultTier = S.Literal(...DEFAULT_TIER_ALIASES);
export type TDefaultTier = S.Schema.Type<typeof DefaultTier>;

export const ModelCard = S.Struct({
  id: S.String,
  object: S.Literal("model"),
  created: S.Number,
  owned_by: S.String,
});
export type TModelCard = S.Schema.Type<typeof ModelCard>;

export const ModelList = S.Struct({
  object: S.Literal("list"),
  data: S.Array(ModelCard),
});
export type TModelList = S.Schema.Type<typeof ModelList>;

// `/v1/models` envelope as openllm actually serves it: an OpenAI-shape
// `ModelCard` carrying the extra metadata the dashboard's selectors
// need (display_name, capability gating). OpenAI/Anthropic SDK clients
// ignore the extra fields and parse only `id` + `object`; the dashboard
// gets a strongly-typed list it can group/filter without a second
// network round-trip against /api/credentials + the global catalog.
export const ExtendedModelCard = S.extend(
  ModelCard,
  S.Struct({
    provider: S.String,
    provider_model_id: S.String,
    display_name: S.String,
    capabilities: S.Array(ModelCapability),
    // Curated list of dim presets to show in the endpoint picker on
    // `/config`. Catalog-defined so the UI doesn't have to know which
    // values are "interesting" — `text-embedding-3-large` could
    // technically request any dim ≤ 3072, but most users only care
    // about 256 / 1024 / 1536 / 3072.
    dimension_presets: S.optional(S.Array(S.Number)),
    // Token budgets aligned with LiteLLM `model_prices_and_context_window.json`
    // (`max_input_tokens` / `max_output_tokens`). Exposed on `/v1/models` so
    // CLI clients (e.g. Claude Code) can size context before auto-compact.
    max_input_tokens: S.optional(S.Number),
    max_output_tokens: S.optional(S.Number),
    /** Prompt/context budget; equals `max_input_tokens` when present. */
    context_window: S.optional(S.Number),
  }),
);
export type TExtendedModelCard = S.Schema.Type<typeof ExtendedModelCard>;

export const ExtendedModelList = S.Struct({
  object: S.Literal("list"),
  data: S.Array(ExtendedModelCard),
});
export type TExtendedModelList = S.Schema.Type<typeof ExtendedModelList>;

export const ModelPricing = S.Struct({
  input_per_million: S.optional(S.Number),
  output_per_million: S.optional(S.Number),
  cache_read_per_million: S.optional(S.Number),
  cache_write_per_million: S.optional(S.Number),
  image_input_per_unit: S.optional(S.Number),
  audio_input_per_minute: S.optional(S.Number),
});
export type TModelPricing = S.Schema.Type<typeof ModelPricing>;

export const PricingEntry = S.extend(
  ModelPricing,
  S.Struct({ model_id: S.String, provider: S.String }),
);
export type TPricingEntry = S.Schema.Type<typeof PricingEntry>;

export const ExtendedModel = S.Struct({
  id: S.String,
  provider: S.String,
  provider_model_id: S.String,
  display_name: S.String,
  capabilities: S.Array(ModelCapability),
  /** @deprecated Prefer `max_input_tokens`; kept for older dashboard reads. */
  context_window: S.optional(S.Number),
  max_input_tokens: S.optional(S.Number),
  max_output_tokens: S.optional(S.Number),
  pricing: S.optional(ModelPricing),
  deprecated: S.optional(S.Boolean),
  // Embedding-only metadata — see ExtendedModelCard for semantics.
  dimension_presets: S.optional(S.Array(S.Number)),
  // Membership in derived default chains (`DEFAULT_TIER_ALIASES`).
  // Chat models only. A model can belong to several tiers (e.g. a
  // single-model subscription serving all three); the ARRAY ORDER is
  // its priority — index 0 is its primary tier, and within each chain
  // a model with the tier at a later index sorts after models that
  // hold it earlier. `tier_rank` breaks ties within the same index
  // across providers (lower = tried first) — explicit so quality
  // ordering is deliberate, not an accident of catalog array order.
  default_tiers: S.optional(S.Array(DefaultTier)),
  tier_rank: S.optional(S.Number),
});
export type TExtendedModel = S.Schema.Type<typeof ExtendedModel>;

export const AliasMap = S.Record({ key: S.String, value: S.String });
export type TAliasMap = S.Schema.Type<typeof AliasMap>;

// One model as reported by a provider's own list endpoint (e.g. OpenAI
// `GET /v1/models`, Moonshot `GET /coding/v1/models`). Deliberately
// minimal — only what upstreams actually report. Everything else
// (capabilities, tier chains, pricing, limits) stays catalog-owned and
// is hybrid-merged at read time (docs/proposals/live-provider-model-catalog.md).
export const ProviderModelEntry = S.Struct({
  /** Upstream model id, e.g. `gpt-5.2` — NOT the catalog `provider/model` id. */
  provider_model_id: S.String,
  display_name: S.optional(S.String),
  created: S.optional(S.Number),
  context_window: S.optional(S.Number),
});
export type TProviderModelEntry = S.Schema.Type<typeof ProviderModelEntry>;

// Payload of one `model_cache` row: the live model list one writer
// (daemon for subscription providers, cloud for API-key providers)
// observed for a single provider.
export const ProviderModelList = S.Array(ProviderModelEntry);
export type TProviderModelList = S.Schema.Type<typeof ProviderModelList>;
