import { Schema as S } from "effect";

const FunctionCall = S.Struct({
  name: S.String,
  arguments: S.String,
});

const ToolCall = S.Struct({
  id: S.String,
  type: S.Literal("function"),
  function: FunctionCall,
});
export type TToolCall = S.Schema.Type<typeof ToolCall>;

/**
 * Prompt-cache breakpoint. OpenAI-format clients (and LiteLLM's
 * `ChatCompletionCachedContent`) mark a content block / message / tool
 * with `cache_control: {type:"ephemeral"}` to make everything up to and
 * including it a cacheable prefix on the Anthropic wire. Dropping it
 * silently disables prompt caching → ~10x token cost on agent loops.
 */
const CacheControl = S.Struct({ type: S.Literal("ephemeral") });
export type TCacheControl = S.Schema.Type<typeof CacheControl>;

const TextPart = S.Struct({
  type: S.Literal("text"),
  text: S.String,
  cache_control: S.optional(S.NullOr(CacheControl)),
});

const ImageUrlPart = S.Struct({
  type: S.Literal("image_url"),
  image_url: S.Struct({
    url: S.String,
    detail: S.optional(S.Literal("auto", "low", "high")),
  }),
  cache_control: S.optional(S.NullOr(CacheControl)),
});

const InputAudioPart = S.Struct({
  type: S.Literal("input_audio"),
  input_audio: S.Struct({
    data: S.String,
    format: S.Literal("wav", "mp3"),
  }),
});

/**
 * OpenAI-native file attachment (PDFs etc.). `file_data` is a data URL
 * (`data:<mime>;base64,<b64>`); `file_id` references a provider-side
 * uploaded file. The canonical carrier for Anthropic `document` blocks
 * on cross-provider hops.
 */
const FilePart = S.Struct({
  type: S.Literal("file"),
  file: S.Struct({
    file_data: S.optional(S.String),
    file_id: S.optional(S.String),
    filename: S.optional(S.String),
  }),
  cache_control: S.optional(S.NullOr(CacheControl)),
});
export type TFilePart = S.Schema.Type<typeof FilePart>;

const ContentPart = S.Union(TextPart, ImageUrlPart, InputAudioPart, FilePart);

const MessageContent = S.Union(S.String, S.Array(ContentPart));

const SystemMessage = S.Struct({
  role: S.Literal("system"),
  content: MessageContent,
  name: S.optional(S.String),
  cache_control: S.optional(S.NullOr(CacheControl)),
});

const UserMessage = S.Struct({
  role: S.Literal("user"),
  content: MessageContent,
  name: S.optional(S.String),
  cache_control: S.optional(S.NullOr(CacheControl)),
});

const AssistantMessage = S.Struct({
  role: S.Literal("assistant"),
  content: S.optional(S.NullOr(MessageContent)),
  name: S.optional(S.String),
  tool_calls: S.optional(S.Array(ToolCall)),
  refusal: S.optional(S.NullOr(S.String)),
  /** LiteLLM / OpenAI Responses → chat stream (`reasoning_content` deltas). */
  reasoning_content: S.optional(S.NullishOr(S.String)),
  /** Terminal `response.completed` reasoning round-trip (LiteLLM `Delta.reasoning_items`). */
  reasoning_items: S.optional(S.NullishOr(S.Array(S.Unknown))),
  cache_control: S.optional(S.NullOr(CacheControl)),
});

const ToolMessage = S.Struct({
  role: S.Literal("tool"),
  content: MessageContent,
  tool_call_id: S.String,
  cache_control: S.optional(S.NullOr(CacheControl)),
});

export const ChatMessage = S.Union(
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
);
export type TChatMessage = S.Schema.Type<typeof ChatMessage>;

const FunctionDef = S.Struct({
  name: S.String,
  description: S.optional(S.String),
  parameters: S.optional(S.Unknown),
  strict: S.optional(S.Boolean),
});

const Tool = S.Struct({
  type: S.Literal("function"),
  function: FunctionDef,
  cache_control: S.optional(S.NullOr(CacheControl)),
});

const ToolChoiceLiteral = S.Literal("none", "auto", "required");

const ToolChoiceFunction = S.Struct({
  type: S.Literal("function"),
  function: S.Struct({ name: S.String }),
});

const ToolChoice = S.Union(ToolChoiceLiteral, ToolChoiceFunction);

const ResponseFormat = S.Union(
  S.Struct({ type: S.Literal("text") }),
  S.Struct({ type: S.Literal("json_object") }),
  S.Struct({
    type: S.Literal("json_schema"),
    json_schema: S.Struct({
      name: S.String,
      description: S.optional(S.String),
      schema: S.optional(S.Unknown),
      strict: S.optional(S.Boolean),
    }),
  }),
);

export const ChatCompletionRequest = S.Struct({
  model: S.String,
  messages: S.Array(ChatMessage),
  temperature: S.optional(S.Number),
  top_p: S.optional(S.Number),
  n: S.optional(S.Number),
  stream: S.optional(S.Boolean),
  stop: S.optional(S.Union(S.String, S.Array(S.String))),
  max_tokens: S.optional(S.Number),
  max_completion_tokens: S.optional(S.Number),
  presence_penalty: S.optional(S.Number),
  frequency_penalty: S.optional(S.Number),
  logit_bias: S.optional(S.Record({ key: S.String, value: S.Number })),
  logprobs: S.optional(S.Boolean),
  top_logprobs: S.optional(S.Number),
  seed: S.optional(S.Number),
  user: S.optional(S.String),
  tools: S.optional(S.Array(Tool)),
  tool_choice: S.optional(ToolChoice),
  parallel_tool_calls: S.optional(S.Boolean),
  /**
   * Opaque carrier for the inbound Responses-API `tools` array (Codex's
   * built-in tools: `custom` apply_patch, `web_search`, `image_generation`,
   * `tool_search`, alongside `function` tools). Canonical models only function
   * tools, so a Responses→chatgpt round-trip (Codex → daemon → chatgpt.com)
   * would otherwise lose them; this carries the ORIGINAL set verbatim and
   * `toChatGptRequest` re-emits it. Set by `fromResponsesRequest`, read ONLY by
   * `toChatGptRequest`, and STRIPPED before every openai-family upstream (it is
   * not a real OpenAI field). Mirrors `reasoning_items` (opaque Responses
   * carrier). See `@quantidexyz/openllmw/adapters/responses`.
   */
  responses_tools: S.optional(S.Array(S.Unknown)),
  stream_options: S.optional(
    S.Struct({
      include_usage: S.optional(S.Boolean),
    }),
  ),
  response_format: S.optional(ResponseFormat),
  // Full OpenAI-compatible enum (matches LiteLLM's accepted set so we
  // can translate the same range of efforts that `gpt-5` / Claude
  // canonical clients ship). `none` explicitly disables thinking.
  reasoning_effort: S.optional(
    S.Literal("minimal", "low", "medium", "high", "xhigh", "max", "none"),
  ),
  metadata: S.optional(S.Record({ key: S.String, value: S.String })),
  /**
   * OpenAI prompt-cache routing hint. A stable value across the turns of one
   * conversation routes them to the same cache machine, raising the cache-hit
   * rate (and, for subscription providers like Codex, cutting quota burn). A
   * real OpenAI field — forwarded verbatim to openai-family upstreams and
   * emitted by `toChatGptRequest` for the chatgpt/Codex wire (synthesized from
   * the conversation prefix when the caller doesn't supply one). Set by
   * `fromResponsesRequest` when a Codex client already carries it.
   */
  prompt_cache_key: S.optional(S.String),
});
export type TChatCompletionRequest = S.Schema.Type<
  typeof ChatCompletionRequest
>;

export const Usage = S.Struct({
  prompt_tokens: S.Number,
  completion_tokens: S.Number,
  total_tokens: S.Number,
  prompt_tokens_details: S.optional(
    S.Struct({
      cached_tokens: S.optional(S.Number),
      cache_creation_tokens: S.optional(S.Number),
      audio_tokens: S.optional(S.Number),
    }),
  ),
  completion_tokens_details: S.optional(
    S.Struct({
      reasoning_tokens: S.optional(S.Number),
      audio_tokens: S.optional(S.Number),
      accepted_prediction_tokens: S.optional(S.Number),
      rejected_prediction_tokens: S.optional(S.Number),
    }),
  ),
});
export type TUsage = S.Schema.Type<typeof Usage>;

const FinishReason = S.Literal(
  "stop",
  "length",
  "content_filter",
  "tool_calls",
  "function_call",
);

const ChatChoice = S.Struct({
  index: S.Number,
  message: AssistantMessage,
  finish_reason: S.NullOr(FinishReason),
  logprobs: S.optional(S.NullOr(S.Unknown)),
});

export const ChatCompletionResponse = S.Struct({
  id: S.String,
  object: S.Literal("chat.completion"),
  created: S.Number,
  model: S.String,
  choices: S.Array(ChatChoice),
  usage: Usage,
  system_fingerprint: S.optional(S.NullOr(S.String)),
});
export type TChatCompletionResponse = S.Schema.Type<
  typeof ChatCompletionResponse
>;

// OpenAI-compatible providers (Alibaba DashScope / qwen, Kimi, etc.)
// don't strictly follow OpenAI's wire shape: continuation chunks may
// omit `finish_reason` entirely and set every "this isn't set this
// chunk" field to `null` (rather than dropping the key). If we treat
// these as schema violations the chunk is silently dropped at the
// `providerEventStream` decoder and the tool-call argument fragment it
// was carrying is lost — observed in prod as `Edit` / `Bash` called
// with missing required parameters (`command`, `file_path`, …) and
// `/compact` failing with "no valid text content" when the only
// surviving chunk is the terminal one.
//
// `S.NullishOr(X)` ≡ `X | null | undefined` and pairs with
// `S.optional(...)` to accept (1) absent, (2) explicit-null, and
// (3) the wanted type. Every nullable-by-OpenAI field uses it.
const ChatChunkDelta = S.Struct({
  role: S.optional(S.NullishOr(S.Literal("assistant"))),
  content: S.optional(S.NullishOr(S.String)),
  tool_calls: S.optional(
    S.NullishOr(
      S.Array(
        S.Struct({
          index: S.Number,
          id: S.optional(S.NullishOr(S.String)),
          type: S.optional(S.NullishOr(S.Literal("function"))),
          function: S.optional(
            S.NullishOr(
              S.Struct({
                name: S.optional(S.NullishOr(S.String)),
                arguments: S.optional(S.NullishOr(S.String)),
              }),
            ),
          ),
        }),
      ),
    ),
  ),
  refusal: S.optional(S.NullishOr(S.String)),
  reasoning_content: S.optional(S.NullishOr(S.String)),
  reasoning_items: S.optional(S.NullishOr(S.Array(S.Unknown))),
});

const ChatChunkChoice = S.Struct({
  index: S.Number,
  delta: ChatChunkDelta,
  // `finish_reason` is *optional* on continuation chunks for many
  // OpenAI-compatible providers (qwen3-coder, kimi, ...) — only the
  // terminal chunk carries it. `S.optional(S.NullishOr(...))` lets it
  // be absent, null, or a real reason without dropping the chunk.
  finish_reason: S.optional(S.NullishOr(FinishReason)),
  logprobs: S.optional(S.NullishOr(S.Unknown)),
});

export const ChatCompletionChunk = S.Struct({
  id: S.String,
  object: S.Literal("chat.completion.chunk"),
  created: S.Number,
  model: S.String,
  choices: S.Array(ChatChunkChoice),
  usage: S.optional(S.NullOr(Usage)),
  system_fingerprint: S.optional(S.NullOr(S.String)),
});
export type TChatCompletionChunk = S.Schema.Type<typeof ChatCompletionChunk>;
