import { Schema as S } from "effect";
import { DefaultTier, ExtendedModel } from "./models";

/**
 * Wire format a custom-API endpoint speaks. Reuses the same two
 * canonical formats the registry tracks today; the proxy dispatches
 * through `openaiProvider` or `anthropicProvider` accordingly.
 *
 * Used ONLY for the one-shot `/v1/models` discovery probe — the
 * credential blob no longer stores it and the per-user catalog no
 * longer attaches it to entries (wire format is now derived per
 * MODEL via `CustomApiModelKind` below).
 *
 * Defined here (not in `./credentials`) to keep the dependency
 * direction one-way (`credentials.ts` may depend on `./config`).
 */
export const CustomApiWireFormat = S.Literal("openai", "anthropic");
export type TCustomApiWireFormat = S.Schema.Type<typeof CustomApiWireFormat>;

/**
 * Per-model surface + wire choice. One endpoint can serve a mix of
 * chat / embeddings / image models, and chat models can speak either
 * the OpenAI or the Anthropic wire — packed into one tagged value
 * the dashboard collects via a single per-row select.
 *
 * - `chat_openai`    /v1/chat/completions, OpenAI canonical wire
 * - `chat_anthropic` /v1/messages or canonical chat, Anthropic wire
 * - `embeddings`     /v1/embeddings, OpenAI wire (the only embeddings
 *                    surface upstream specs implement)
 * - `image_openai`   /v1/images/generations, OpenAI-compatible image
 *                    gen — what aggregating gateways (LiteLLM,
 *                    openllm itself, OpenRouter, …) expose,
 *                    regardless of the underlying model.
 *
 * Native Google AI Studio (`generateContent`) is intentionally
 * absent: its model list is at `/v1beta/models` with a different
 * envelope shape than the OpenAI-style `/v1/models` our discovery
 * probe expects, so it cannot be reached via the discover-then-pick
 * flow. Use the built-in `google/*` catalog entries on the API-keys
 * tab when you want direct Google AI Studio access.
 */
export const CustomApiModelKind = S.Literal(
  "chat_openai",
  "chat_anthropic",
  "embeddings",
  "image_openai",
);
export type TCustomApiModelKind = S.Schema.Type<typeof CustomApiModelKind>;

export const FallbackGroup = S.Struct({
  name: S.String,
  models: S.Array(S.String),
});
export type TFallbackGroup = S.Schema.Type<typeof FallbackGroup>;

/** LiteLLM-style `[trigger, alternateModels]` rows (`*` = default alternates). */
export const ModelFallbackBinding = S.Tuple(S.String, S.Array(S.String));
export type TModelFallbackBinding = S.Schema.Type<typeof ModelFallbackBinding>;

/**
 * One discovered model the user has opted IN to. The dashboard's
 * `/v1/models` probe returns a flat list of upstream ids; the user
 * picks which to enable with a checkbox and assigns a `kind` per
 * row. We deliberately do NOT auto-include the entire upstream
 * catalogue — large gateways can return hundreds of models, most
 * of which the user will never call.
 */
export const CustomApiCatalogModel = S.Struct({
  id: S.String,
  kind: CustomApiModelKind,
});
export type TCustomApiCatalogModel = S.Schema.Type<
  typeof CustomApiCatalogModel
>;

/**
 * Per-user catalog entry for a custom OpenAI/Anthropic-compatible
 * endpoint the user has registered on the `/providers` page. The
 * SECRET half (base URL + api key) lives encrypted in
 * `public.credentials` under provider slug `custom:<name>` — only
 * the opt-in model list (id + kind) is stored here so the dashboard
 * can populate fallback dropdowns without unlocking the vault.
 */
export const CustomApiCatalogEntry = S.Struct({
  name: S.String,
  models: S.Array(CustomApiCatalogModel),
});
export type TCustomApiCatalogEntry = S.Schema.Type<
  typeof CustomApiCatalogEntry
>;

export const ExtraConfig = S.Struct({
  search_provider: S.optional(S.String),
  custom_apis: S.optional(S.Array(CustomApiCatalogEntry)),
  /**
   * Subscription-OAuth providers (`claude_code` / `chatgpt` / `kimi_code`)
   * the user has connected via SOME local daemon. These have no cloud
   * credential row — the daemon holds the credential — so this per-user
   * marker is how `/v1/models` knows to LIST their models, making them
   * configurable (fallback chains, prefs) from ANY machine. Live
   * runnability is gated separately per-machine on daemon reachability
   * (the dashboard shows "reconfigure on this machine" when the local
   * daemon isn't connected). Set on connect; never auto-removed.
   */
  subscription_providers: S.optional(S.Array(S.String)),
  /**
   * Default tier aliases (`ultra` / `plus` / `lite`) the user explicitly
   * DELETED from the chains editor. Derivation of virtual default chains
   * skips these — without the marker, a deleted derived chain would
   * silently reappear on the next load. Removing the marker (re-adding
   * the alias via the editor) reverts it to auto-derived.
   */
  disabled_default_aliases: S.optional(S.Array(DefaultTier)),
});
export type TExtraConfig = S.Schema.Type<typeof ExtraConfig>;

export const UserConfig = S.Struct({
  fallback_groups: S.Array(FallbackGroup),
  model_fallback_bindings: S.optional(S.Array(ModelFallbackBinding)),
  extra: ExtraConfig,
});
export type TUserConfig = S.Schema.Type<typeof UserConfig>;

export const RequiredProviderTerm = S.Struct({
  provider: S.String,
  url: S.String,
  version: S.String,
  display_name: S.String,
});
export type TRequiredProviderTerm = S.Schema.Type<typeof RequiredProviderTerm>;

export const GlobalConfig = S.Struct({
  terms_version: S.String,
  terms_url: S.String,
  privacy_url: S.String,
  required_provider_terms: S.Array(RequiredProviderTerm),
  default_aliases: S.Record({ key: S.String, value: S.String }),
  model_catalog: S.Array(ExtendedModel),
  search_provider: S.String,
  plugin_allow_list: S.Array(S.String),
});
export type TGlobalConfig = S.Schema.Type<typeof GlobalConfig>;

// All stored credentials are API-key (BYOK); subscription OAuth lives on
// the local daemon, never the DB — so there's no kind/expiry/refresh here.
export const ProviderCredential = S.Struct({
  provider: S.String,
  has_credential: S.Boolean,
});
export type TProviderCredential = S.Schema.Type<typeof ProviderCredential>;
