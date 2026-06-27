import { Schema as S } from "effect";

// ─── OpenAI provider options ─────────────────────────────────────────────────

export const OpenAIProviderOptions = S.Struct({
  providerModelId: S.String,
});
export type TOpenAIProviderOptions = S.Schema.Type<
  typeof OpenAIProviderOptions
>;

export const OpenAIEndpointKind = S.Literal(
  "chat",
  "embeddings",
  "images",
  "audio_transcription",
  "audio_speech",
);
export type TOpenAIEndpointKind = S.Schema.Type<typeof OpenAIEndpointKind>;

// ─── Anthropic tool shape (request side) ─────────────────────────────────────

export const AnthropicTool = S.Struct({
  name: S.String,
  description: S.optional(S.String),
  // `input_schema` is required for custom tools but optional for the
  // native server-side tools (`web_search_20250305`, `computer_20241022`,
  // `bash_20241022`, etc.) which Anthropic identifies by `type` instead.
  input_schema: S.optional(S.Unknown),
  type: S.optional(S.String),
  // A breakpoint on a tool makes the whole tool catalogue a cacheable
  // prefix — Claude Code marks the last tool. LiteLLM:
  // `llms/anthropic/chat/transformation.py` (~L783-799).
  cache_control: S.optional(
    S.NullOr(S.Struct({ type: S.Literal("ephemeral") })),
  ),
});
export type TAnthropicTool = S.Schema.Type<typeof AnthropicTool>;

// ─── Anthropic wire types — request ──────────────────────────────────────────

const AnthropicCacheControl = S.Struct({ type: S.Literal("ephemeral") });

const AnthropicTextBlock = S.Struct({
  type: S.Literal("text"),
  text: S.String,
  cache_control: S.optional(S.NullOr(AnthropicCacheControl)),
});

const AnthropicImageSource = S.Union(
  S.Struct({
    type: S.Literal("base64"),
    media_type: S.String,
    data: S.String,
  }),
  S.Struct({ type: S.Literal("url"), url: S.String }),
);

const AnthropicImageBlock = S.Struct({
  type: S.Literal("image"),
  source: AnthropicImageSource,
  cache_control: S.optional(S.NullOr(AnthropicCacheControl)),
});

const AnthropicToolUseBlock = S.Struct({
  type: S.Literal("tool_use"),
  id: S.String,
  name: S.String,
  input: S.Unknown,
  cache_control: S.optional(S.NullOr(AnthropicCacheControl)),
});

const AnthropicToolResultBlock = S.Struct({
  type: S.Literal("tool_result"),
  tool_use_id: S.String,
  content: S.Union(S.String, S.Array(AnthropicTextBlock)),
  is_error: S.optional(S.Boolean),
  cache_control: S.optional(S.NullOr(AnthropicCacheControl)),
});

const AnthropicThinkingBlock = S.Struct({
  type: S.Literal("thinking"),
  thinking: S.String,
  signature: S.optional(S.String),
});

/** Server-side context compaction summary blocks (Anthropic streaming + JSON responses). */
const AnthropicCompactionBlock = S.Struct({
  type: S.Literal("compaction"),
  content: S.optional(S.Unknown),
});

export const AnthropicContentBlock = S.Union(
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  AnthropicCompactionBlock,
);
export type TAnthropicContentBlock = S.Schema.Type<
  typeof AnthropicContentBlock
>;

export const AnthropicMessage = S.Struct({
  // `system` joins `user`/`assistant` as of the Claude 4.8-era clients
  // (Claude Code v2.1.157+), which inline a system turn in `messages[]`
  // when the `mid-conversation-system-2026-04-07` beta is active —
  // exactly the beta we started forwarding correctly in PR #12. Anthropic
  // ACCEPTS that shape under the beta, so the routing-time parse must
  // accept it too or `/v1/messages` 400s before we can forward.
  //   - Passthrough (anthropic / claude_code first hop): the raw body
  //     is forwarded verbatim with the beta header, and Anthropic
  //     honours the inline system turn — this literal just stops our
  //     own parse from rejecting it.
  //   - Cross-provider fallback hop: `splitAnthropicMessage` in
  //     `adapters/messages/request.ts` maps the inline system turn to
  //     the canonical `system` role for the non-Anthropic upstream.
  role: S.Literal("user", "assistant", "system"),
  content: S.Union(S.String, S.Array(AnthropicContentBlock)),
});
export type TAnthropicMessage = S.Schema.Type<typeof AnthropicMessage>;

const AnthropicSystemBlock = S.Union(S.String, S.Array(AnthropicTextBlock));

const AnthropicToolChoice = S.Union(
  S.Struct({ type: S.Literal("auto") }),
  S.Struct({ type: S.Literal("any") }),
  S.Struct({ type: S.Literal("tool"), name: S.String }),
  S.Struct({ type: S.Literal("none") }),
);

/**
 * Extended-thinking knob. `enabled` carries an explicit budget;
 * `adaptive` lets Claude 4.6+ decide the budget itself (paired with
 * `output_config.effort` to set the target effort level).
 */
export const AnthropicThinking = S.Union(
  S.Struct({
    type: S.Literal("enabled"),
    budget_tokens: S.Number,
  }),
  S.Struct({ type: S.Literal("adaptive") }),
);
export type TAnthropicThinking = S.Schema.Type<typeof AnthropicThinking>;

/**
 * Adaptive-thinking effort levels Anthropic accepts on
 * `output_config.effort`. Only honoured by Claude 4.6+; other models
 * 400 if this is set (see `providers/anthropic/adaptive-thinking.ts`).
 */
export const AnthropicEffort = S.Literal(
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
);
export type TAnthropicEffort = S.Schema.Type<typeof AnthropicEffort>;

export const AnthropicOutputConfig = S.Struct({
  effort: S.optional(AnthropicEffort),
});
export type TAnthropicOutputConfig = S.Schema.Type<
  typeof AnthropicOutputConfig
>;

export const AnthropicRequest = S.Struct({
  model: S.String,
  messages: S.Array(AnthropicMessage),
  max_tokens: S.Number,
  system: S.optional(AnthropicSystemBlock),
  temperature: S.optional(S.Number),
  top_p: S.optional(S.Number),
  top_k: S.optional(S.Number),
  stop_sequences: S.optional(S.Array(S.String)),
  stream: S.optional(S.Boolean),
  tools: S.optional(S.Array(AnthropicTool)),
  tool_choice: S.optional(AnthropicToolChoice),
  metadata: S.optional(S.Struct({ user_id: S.optional(S.String) })),
  thinking: S.optional(AnthropicThinking),
  output_config: S.optional(AnthropicOutputConfig),
});
export type TAnthropicRequest = S.Schema.Type<typeof AnthropicRequest>;

// ─── Anthropic wire types — response ─────────────────────────────────────────

export const AnthropicStopReason = S.Literal(
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
);
export type TAnthropicStopReason = S.Schema.Type<typeof AnthropicStopReason>;

export const AnthropicUsage = S.Struct({
  input_tokens: S.Number,
  output_tokens: S.Number,
  cache_creation_input_tokens: S.optional(S.NullOr(S.Number)),
  cache_read_input_tokens: S.optional(S.NullOr(S.Number)),
});
export type TAnthropicUsage = S.Schema.Type<typeof AnthropicUsage>;

export const AnthropicResponse = S.Struct({
  id: S.String,
  type: S.Literal("message"),
  role: S.Literal("assistant"),
  model: S.String,
  content: S.Array(AnthropicContentBlock),
  stop_reason: S.NullOr(AnthropicStopReason),
  stop_sequence: S.NullOr(S.String),
  usage: AnthropicUsage,
});
export type TAnthropicResponse = S.Schema.Type<typeof AnthropicResponse>;

// ─── Anthropic wire types — streaming events ─────────────────────────────────

const AnthropicMessageStartEvent = S.Struct({
  type: S.Literal("message_start"),
  message: S.Struct({
    id: S.String,
    type: S.Literal("message"),
    role: S.Literal("assistant"),
    model: S.String,
    content: S.Array(AnthropicContentBlock),
    stop_reason: S.NullOr(AnthropicStopReason),
    stop_sequence: S.NullOr(S.String),
    usage: AnthropicUsage,
  }),
});

const AnthropicContentBlockStartEvent = S.Struct({
  type: S.Literal("content_block_start"),
  index: S.Number,
  content_block: AnthropicContentBlock,
});

const AnthropicTextDelta = S.Struct({
  type: S.Literal("text_delta"),
  text: S.String,
});

const AnthropicInputJsonDelta = S.Struct({
  type: S.Literal("input_json_delta"),
  partial_json: S.String,
});

const AnthropicThinkingDelta = S.Struct({
  type: S.Literal("thinking_delta"),
  thinking: S.String,
});

const AnthropicSignatureDelta = S.Struct({
  type: S.Literal("signature_delta"),
  signature: S.String,
});

const AnthropicCompactionDelta = S.Struct({
  type: S.Literal("compaction_delta"),
  content: S.optional(S.Unknown),
});

const AnthropicContentBlockDeltaEvent = S.Struct({
  type: S.Literal("content_block_delta"),
  index: S.Number,
  delta: S.Union(
    AnthropicTextDelta,
    AnthropicInputJsonDelta,
    AnthropicThinkingDelta,
    AnthropicSignatureDelta,
    AnthropicCompactionDelta,
  ),
});

const AnthropicContentBlockStopEvent = S.Struct({
  type: S.Literal("content_block_stop"),
  index: S.Number,
});

const AnthropicMessageDeltaEvent = S.Struct({
  type: S.Literal("message_delta"),
  delta: S.Struct({
    stop_reason: S.NullOr(AnthropicStopReason),
    stop_sequence: S.NullOr(S.String),
  }),
  usage: S.Struct({
    output_tokens: S.Number,
    input_tokens: S.optional(S.NullOr(S.Number)),
    cache_creation_input_tokens: S.optional(S.NullOr(S.Number)),
    cache_read_input_tokens: S.optional(S.NullOr(S.Number)),
  }),
});

const AnthropicMessageStopEvent = S.Struct({
  type: S.Literal("message_stop"),
});

const AnthropicPingEvent = S.Struct({ type: S.Literal("ping") });

const AnthropicErrorEvent = S.Struct({
  type: S.Literal("error"),
  error: S.Struct({ type: S.String, message: S.String }),
});

export const AnthropicStreamEvent = S.Union(
  AnthropicMessageStartEvent,
  AnthropicContentBlockStartEvent,
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStopEvent,
  AnthropicMessageDeltaEvent,
  AnthropicMessageStopEvent,
  AnthropicPingEvent,
  AnthropicErrorEvent,
);
export type TAnthropicStreamEvent = S.Schema.Type<typeof AnthropicStreamEvent>;

// ─── Anthropic provider options ──────────────────────────────────────────────

export const AnthropicProviderOptions = S.Struct({
  providerModelId: S.String,
  apiVersion: S.optional(S.String),
  defaultMaxTokens: S.optional(S.Number),
});
export type TAnthropicProviderOptions = S.Schema.Type<
  typeof AnthropicProviderOptions
>;

// ─── Google AI Studio — image generation (Nano Banana / Imagen) ──────────────

// generativelanguage.googleapis.com/v1beta returns image bytes inline.
const GoogleImageInlineData = S.Struct({
  mime_type: S.optional(S.String),
  mimeType: S.optional(S.String),
  data: S.String,
});

const GoogleImagePart = S.Union(
  S.Struct({ text: S.String }),
  S.Struct({ inlineData: GoogleImageInlineData }),
);

const GoogleImageCandidate = S.Struct({
  content: S.optional(
    S.Struct({
      parts: S.optional(S.Array(GoogleImagePart)),
      role: S.optional(S.String),
    }),
  ),
  finishReason: S.optional(S.NullOr(S.String)),
});

export const GoogleImageRequest = S.Struct({
  contents: S.Array(
    S.Struct({
      parts: S.Array(S.Struct({ text: S.String })),
    }),
  ),
  generationConfig: S.Struct({
    response_modalities: S.Array(S.String),
    // Gemini's generateContent nests aspect ratio under `imageConfig`;
    // there is no `sampleCount` (it returns one image per call). Sending
    // `sampleCount`/`aspectRatio` at the generationConfig top level 400s
    // with "Unknown name ... at 'generation_config'".
    imageConfig: S.optional(
      S.Struct({
        aspectRatio: S.optional(S.String),
      }),
    ),
  }),
});
export type TGoogleImageRequest = S.Schema.Type<typeof GoogleImageRequest>;

const GoogleImageUsageMetadata = S.Struct({
  promptTokenCount: S.optional(S.NullOr(S.Number)),
  candidatesTokenCount: S.optional(S.NullOr(S.Number)),
  totalTokenCount: S.optional(S.NullOr(S.Number)),
  cachedContentTokenCount: S.optional(S.NullOr(S.Number)),
});

export const GoogleImageResponse = S.Struct({
  candidates: S.optional(S.Array(GoogleImageCandidate)),
  usageMetadata: S.optional(GoogleImageUsageMetadata),
});
export type TGoogleImageResponse = S.Schema.Type<typeof GoogleImageResponse>;

export const GoogleImageProviderOptions = S.Struct({
  providerModelId: S.String,
});
export type TGoogleImageProviderOptions = S.Schema.Type<
  typeof GoogleImageProviderOptions
>;

// ─── Bedrock — Amazon Titan v2 embeddings ────────────────────────────────────

export const BedrockTitanV2Request = S.Struct({
  inputText: S.String,
  dimensions: S.optional(S.Number),
  normalize: S.optional(S.Boolean),
  embeddingTypes: S.optional(S.Array(S.Literal("float", "binary"))),
});
export type TBedrockTitanV2Request = S.Schema.Type<
  typeof BedrockTitanV2Request
>;

const BedrockTitanV2EmbeddingsByType = S.Struct({
  float: S.optional(S.Array(S.Number)),
  binary: S.optional(S.Array(S.Number)),
});

export const BedrockTitanV2Response = S.Struct({
  embedding: S.optional(S.Array(S.Number)),
  embeddingsByType: S.optional(BedrockTitanV2EmbeddingsByType),
  inputTextTokenCount: S.Number,
});
export type TBedrockTitanV2Response = S.Schema.Type<
  typeof BedrockTitanV2Response
>;

export const BedrockEmbedProviderOptions = S.Struct({
  providerModelId: S.String,
  region: S.String,
  accessKeyId: S.String,
  secretAccessKey: S.String,
  sessionToken: S.optional(S.String),
  dimensions: S.optional(S.Number),
  normalize: S.optional(S.Boolean),
});
export type TBedrockEmbedProviderOptions = S.Schema.Type<
  typeof BedrockEmbedProviderOptions
>;

// ─── ChatGPT (Codex / Responses) provider options ────────────────────────────

/**
 * Options for the `chatgpt` provider — chatgpt.com/backend-api/codex.
 *
 * `accountId` / `sessionId` ride in outbound headers per the Codex CLI
 * convention; both are pulled from the decrypted OAuth blob's `extras`.
 * `originator` and `userAgent` are server-tunable via environment
 * variables; defaults match the reference Python implementation.
 */
export const ChatGptProviderOptions = S.Struct({
  providerModelId: S.String,
  accountId: S.optional(S.String),
  sessionId: S.optional(S.String),
  originator: S.optional(S.String),
  userAgent: S.optional(S.String),
});
export type TChatGptProviderOptions = S.Schema.Type<
  typeof ChatGptProviderOptions
>;

// ─── Kimi Code provider options ──────────────────────────────────────────────
//
// Identity fields are populated by the LOCAL DAEMON from the official
// Kimi CLI's own headers (User-Agent + X-Msh-*), so upstream calls carry
// the real client identity rather than a synthesized one. All optional —
// absent on any non-daemon caller, in which case `kimiCodeAuthHeaders`
// sends only auth + content headers (no fabricated X-Msh-* device fields).
export const KimiCodeProviderOptions = S.Struct({
  providerModelId: S.String,
  userAgent: S.optional(S.String),
  platform: S.optional(S.String),
  version: S.optional(S.String),
  deviceId: S.optional(S.String),
  deviceName: S.optional(S.String),
  deviceModel: S.optional(S.String),
  osVersion: S.optional(S.String),
});
export type TKimiCodeProviderOptions = S.Schema.Type<
  typeof KimiCodeProviderOptions
>;

// (ChatGPT device-code OAuth wire types removed — subscription sign-in is
// the official Codex CLI's job, delegated by the local daemon; the gateway
// no longer runs any OAuth/device-code/token-exchange flow.)
