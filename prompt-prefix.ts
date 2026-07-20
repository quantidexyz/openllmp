/**
 * ─── Gateway prompt prefix ─────────────────────────────────────────────
 *
 * A system-prompt prefix the gateway injects into EVERY chat model call
 * that flows through it (cloud runner AND local daemon walker — both go
 * through `buildUpstreamBody` in `@openllmsh/wire`). It steers agentic
 * clients toward the gateway's tier model and sub-agent conventions.
 *
 * Edit the text here — this file is the single place the prefix lives.
 * Injection is idempotent (a conversation already carrying it verbatim
 * is left untouched) and always rides AFTER any vendor-required preamble
 * (e.g. the Claude Code OAuth preamble, which must stay first).
 */
export const GATEWAY_PROMPT_PREFIX = [
  "--------------------------------MAIN POLICY--------------------------------",
    "Use `ultra` for authoritative tasks (framing, decisions, synthesis)",
    "Use `plus` for execution tasks that require some intelligence",
    "Use `lite` for repetitive tasks that require no intelligence",
    "if ultra, plus, lite models are not available, call v1/models to get equivalent tiers",
    "openllm model format is <provider>/<model_name> - it has resolution support when <provider> is missing",
    "NEVER spawn sub-agents without specifying a the model",
    "NEVER spawn sub-agents in an isolated worktrees",
    "ALWAYS spawn sub-agents in the same worktree",
    "ALWAYS prefer delegating work to sub-agents",
    "ONLY use the main session for orchestration of sub-agents",
    "--------------------------------END OF POLICY--------------------------------",
  ].join(" ");
  