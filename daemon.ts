import { Schema as S } from "effect";
import { FallbackGroup, ModelFallbackBinding } from "./config";
import { ProviderUsageSnapshot } from "./provider-usage";
import { RequestStatus } from "./stats";

// ─── GET /api/daemon/bootstrap (daemon → cloud) ──────────────────────
//
// One snapshot with everything the local pipeline needs to resolve a
// chain + price-free dispatch: the model catalog, the provider prefixes,
// and the authenticated user's fallback config. Pulled at boot and
// refreshed on a TTL so the daemon stays in lockstep with cloud config
// without recompiling.

export const DaemonCatalogEntry = S.Struct({
  model_id: S.String,
  provider: S.String,
  provider_model_id: S.String,
  input_token_limit: S.NullOr(S.Number),
  output_token_limit: S.NullOr(S.Number),
});
export type TDaemonCatalogEntry = S.Schema.Type<typeof DaemonCatalogEntry>;

export const DaemonBootstrap = S.Struct({
  catalog: S.Array(DaemonCatalogEntry),
  provider_prefixes: S.Array(S.String),
  user_fallback_groups: S.Array(FallbackGroup),
  user_model_fallback_bindings: S.Array(ModelFallbackBinding),
  /**
   * Per-user HMAC key the daemon uses to VERIFY the `?__plan=` the cloud
   * 307s to it (the cloud signs with the same key). Lets the daemon reject
   * a `__plan` forged by another local process. Null when the cloud has no
   * signing secret configured (dev) — the daemon then accepts unsigned
   * plans. See `docs/proposals/coreless-daemon-passthrough.md` §9.
   */
  plan_signing_key: S.optional(S.NullOr(S.String)),
  /**
   * The daemon binary version the cloud currently publishes (bare semver, no
   * leading `v` — matches the daemon's compiled `DAEMON_VERSION`). The daemon
   * compares it against its own and SELF-UPDATES when they differ (converge to
   * published — the cloud is the source of truth, so republishing an older tag
   * rolls daemons back). Null/absent when no release is published yet (or the
   * cloud is too old to advertise it) — the daemon then never self-updates.
   * See `packages/daemon/src/self-update.ts`.
   */
  latest_version: S.optional(S.NullOr(S.String)),
});
export type TDaemonBootstrap = S.Schema.Type<typeof DaemonBootstrap>;

/**
 * Wire contracts for the local daemon ⇄ cloud control plane and for the
 * daemon's own localhost control surface.
 *
 * Compliance note: the only daemon→cloud payloads are config pulls and
 * the metadata-only request row below. No subscription token and no
 * prompt/completion content ever crosses this boundary.
 */

// ─── POST /api/daemon/requests (daemon → cloud) ──────────────────────
//
// One `public.requests` row for a subscription hop the daemon ran
// locally. `user_id` / `key_id` are deliberately ABSENT: the cloud
// derives both from the authenticating `sk-llm-...` key, so a daemon can
// only ever record rows for its own owner.
//
// No `cost_usd` either — the daemon reports only TOKEN COUNTS; the cloud
// is the single pricing source of truth and computes cost from these
// tokens in `daemonRecordHandler` (`costFor`). Keeping cost off the wire
// is why no pricing table is duplicated onto the daemon.
export const DaemonRecordRequest = S.Struct({
  model: S.String,
  provider: S.String,
  status: RequestStatus,
  tokens_in: S.Number,
  tokens_out: S.Number,
  latency_ms: S.Number,
  idempotency_key: S.optional(S.NullOr(S.String)),
  error: S.optional(S.NullOr(S.String)),
  endpoint: S.optional(S.NullOr(S.String)),
});
export type TDaemonRecordRequest = S.Schema.Type<typeof DaemonRecordRequest>;

// ─── POST /api/daemon/search (daemon → cloud) ────────────────────────
//
// The content-free web_search callback (coreless proposal §5). When a
// subscription model the daemon is serving calls the openllm web_search
// tool, the daemon POSTs ONLY the query here; the cloud recovers the DEK
// from the daemon's `sk-llm` key, runs the search with the user's vault
// search credential, and returns the results. The conversation never
// crosses — only the query (a tool input bound for a third-party engine).
export const DaemonSearchRequest = S.Struct({ query: S.String });
export type TDaemonSearchRequest = S.Schema.Type<typeof DaemonSearchRequest>;

export const DaemonSearchResponse = S.Struct({
  /** Tool-result string fed back to the model on the follow-up turn. */
  content: S.String,
  /** Native Anthropic `server_tool_use` block (messages-surface splice). */
  server_tool_use: S.Unknown,
  /** Native Anthropic `web_search_tool_result` block. */
  tool_result: S.Unknown,
});
export type TDaemonSearchResponse = S.Schema.Type<typeof DaemonSearchResponse>;

// ─── Daemon control relay (cloud ⇄ daemon over the WebSocket relay) ──
//
// The daemon dials OUT and holds ONE WebSocket to the relay (it fetches the
// channel via `GET /api/daemon/channel`); the dashboard enqueues control
// commands via its own watcher socket (or `POST /api/daemon/cmd` as a
// fallback). Commands, acks and status all ride relay frames (see
// `packages/schema/relay.ts`); the relay writes `api_key_activity` so presence
// is server-side, no `x-openllm-daemon` header. See
// `docs/proposals/daemon-relay-websocket-push.md`.

/** The closed set of subscription-provider slugs a control command may
 *  address — the ONLY values that can ever reach a daemon delegate or the
 *  isolated-CLI installer. The daemon's `TCliProvider` derives from this. */
export const SubscriptionProviderSlug = S.Literal(
  "claude_code",
  "chatgpt",
  "kimi_code",
);
export type TSubscriptionProviderSlug = S.Schema.Type<
  typeof SubscriptionProviderSlug
>;

/** Integration areas served by the gateway install pipeline. */
export const DaemonIntegrationKind = S.Literal("skill", "plugin", "setup");
export type TDaemonIntegrationKind = S.Schema.Type<
  typeof DaemonIntegrationKind
>;

// Catalogued-artifact selector (an integration slug / target). Interpolated
// into a gateway URL whose script is SHA-256-gated before execution — never
// executed directly. The conservative charset keeps URL/shell metacharacters
// out of even that indirect path.
const ArtifactSlug = S.String.pipe(S.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/));

// Opaque base64 blob (an X25519 sealed box / SPKI public key) — decrypted or
// parsed by the recipient, never executed. Padding restricted to at most two
// '=' characters only at the end (valid base64 format).
const Base64Blob = S.String.pipe(S.pattern(/^[A-Za-z0-9+/]+={0,2}$/));

const ProviderPayload = S.Struct({ slug: SubscriptionProviderSlug });
const IntegrationPayload = S.Struct({
  kind: DaemonIntegrationKind,
  slug: ArtifactSlug,
  target: S.optional(ArtifactSlug),
});
/** A remote-Claude headless-login code submission: the X25519-sealed OAuth
 *  authorization code the user pasted from the hosted callback page. Opened on
 *  the target daemon and written to the waiting `claude auth login` stdin. The
 *  code is single-use + PKCE-bound (useless without the daemon's in-process
 *  verifier); sealed so the cloud relays it blind. See
 *  `docs/proposals/headless-claude-login-paste-back.md`. */
const SubmitLoginCodePayload = S.Struct({
  slug: SubscriptionProviderSlug,
  sealed: Base64Blob,
});
const SetAutoUpdatePayload = S.Struct({ enabled: S.Boolean });
/** `refresh` scoped to one provider's usage cache; bare `{}` clears all. */
const RefreshPayload = S.Struct({
  slug: S.optional(SubscriptionProviderSlug),
});
/** Payload-less commands (`status` / `update`): accept an absent payload or a
 *  bare `{}` so every union member carries the field (uniform access). */
const EmptyPayload = S.Struct({});

/**
 * The CLOSED control-command vocabulary — one struct per kind, literal-
 * discriminated, every payload field a constrained scalar (a provider-slug
 * enum, a charset-pinned artifact slug, a boolean, an opaque base64 blob).
 * NO field may carry a command string, script body, args array, URL, or
 * free filesystem path — adding one is a deliberate, reviewable schema
 * change, not something `S.Unknown` admits. A command outside this set
 * fails decode at the parse boundary on BOTH ends (cloud/relay enqueue +
 * the daemon's relay socket) before any handler runs. See
 * `docs/proposals/daemon-os-sandbox-and-typed-control.md` §2.
 *
 * Built once and addressed three ways so the vocabularies can never drift:
 * bare (enqueue validation), `id` (relay delivery wire), `key_id`
 * (dashboard enqueue wire).
 */
const commandVariants = <F extends S.Struct.Fields>(addressing: F) =>
  [
    S.Struct({
      ...addressing,
      kind: S.Literal("connect"),
      payload: ProviderPayload,
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("connect_device_code"),
      payload: ProviderPayload,
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("cancel_connect"),
      payload: ProviderPayload,
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("logout"),
      payload: ProviderPayload,
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("cli_install"),
      payload: ProviderPayload,
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("install_integration"),
      payload: IntegrationPayload,
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("uninstall_integration"),
      payload: IntegrationPayload,
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("submit_login_code"),
      payload: SubmitLoginCodePayload,
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("set_auto_update"),
      payload: SetAutoUpdatePayload,
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("refresh"),
      payload: S.optional(RefreshPayload),
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("status"),
      payload: S.optional(EmptyPayload),
    }),
    S.Struct({
      ...addressing,
      kind: S.Literal("update"),
      payload: S.optional(EmptyPayload),
    }),
  ] as const;

/** The bare `{ kind, payload }` vocabulary — what an enqueue boundary (the
 *  relay's watcher `enqueue` frame, `enqueueCommand` in `packages/api`)
 *  validates before writing a `daemon_commands` row. */
export const DaemonCommandBody = S.Union(...commandVariants({}));
export type TDaemonCommandBody = S.Schema.Type<typeof DaemonCommandBody>;

/** Every kind in the closed vocabulary (the union's discriminants). */
export type TDaemonCommandKind = TDaemonCommandBody["kind"];

/** Runtime literal of the closed command vocabulary — the discriminant only,
 *  no payload. Used by `control-channel.ts`'s `CommandLifecycle` to echo which
 *  command a lifecycle frame is reporting on. The `_kindDriftGuard` below makes
 *  this fail to compile if it ever drifts from the `commandVariants` union, so
 *  the two stay in lockstep without duplicating the payload mapping. */
export const DaemonCommandKind = S.Literal(
  "connect",
  "connect_device_code",
  "cancel_connect",
  "logout",
  "cli_install",
  "install_integration",
  "uninstall_integration",
  "submit_login_code",
  "set_auto_update",
  "refresh",
  "status",
  "update",
);
type TDaemonCommandKindLiteral = S.Schema.Type<typeof DaemonCommandKind>;
// Bidirectional assignability assertion: the literal and the union's
// discriminant must be the SAME set. Adding a kind to `commandVariants` without
// adding it here (or vice-versa) breaks this line at compile time.
type _AssertSameKinds = [TDaemonCommandKind] extends [TDaemonCommandKindLiteral]
  ? [TDaemonCommandKindLiteral] extends [TDaemonCommandKind]
    ? true
    : never
  : never;
const _kindDriftGuard: _AssertSameKinds = true;
void _kindDriftGuard;

/** One control command delivered to the daemon over its relay socket.
 *  `id` is `daemon_commands.id` (bigserial), stringified for the wire. */
export const DaemonCommand = S.Union(...commandVariants({ id: S.String }));
export type TDaemonCommand = S.Schema.Type<typeof DaemonCommand>;

/** POST /api/daemon/cmd (dashboard → cloud) — enqueue for a target key
 *  (`key_id` must belong to the session user). */
export const DaemonCmdRequest = S.Union(
  ...commandVariants({ key_id: S.String }),
);
export type TDaemonCmdRequest = S.Schema.Type<typeof DaemonCmdRequest>;

/** A command result the daemon reports back over its relay socket (the
 *  `ack`/`status` frames in `relay.ts` carry these). */
export const DaemonCommandAck = S.Struct({
  id: S.String,
  status: S.Literal("done", "error"),
  result: S.optional(S.Unknown),
});
export type TDaemonCommandAck = S.Schema.Type<typeof DaemonCommandAck>;

// ─── Daemon control surface (browser → daemon, on localhost) ─────────

export const DaemonProviderConnection = S.Struct({
  provider: S.String,
  connected: S.Boolean,
  /** The daemon's ISOLATED copy of this vendor CLI is installed under
   *  ~/.openllm/cli/<provider>/ (NOT the user's PATH). When false the UI
   *  shows an Install button before Connect. */
  cli_installed: S.Boolean,
  /** Version of the isolated CLI, when installed + readable. */
  cli_version: S.optional(S.String),
  detail: S.optional(S.String),
  last_login_at_ms: S.optional(S.NullOr(S.Number)),
  /** A LIVE device-code flow awaiting the user (codex/kimi on a remote box):
   *  the verification URL + one-time code to surface so the dashboard can
   *  render a synced "open this link, enter this code" panel. Present only
   *  while a flow is pending; cleared the moment the credential lands. The
   *  card flips to Connected automatically on the next status push. */
  pending_auth: S.optional(
    S.NullOr(
      S.Struct({
        url: S.String,
        code: S.String,
        /** `device_code` (codex/kimi: surface URL + one-time code to enter in
         *  the browser, then poll) or `paste_code` (claude headless login:
         *  surface URL, then a paste-back input for the code the hosted
         *  callback page displays). Absent ⇒ `device_code`. */
        mode: S.optional(S.Literal("device_code", "paste_code")),
      }),
    ),
  ),
  /** The daemon is downloading/installing this provider's isolated CLI right
   *  now. Pushed immediately when a `cli_install` command starts so the card
   *  shows a synced "Installing…" state (survives a refresh, unlike a local
   *  optimistic flag); cleared when the install finishes + `cli_installed`
   *  flips true. */
  installing: S.optional(S.Boolean),
  /** Metadata-only usage snapshot for a CONNECTED provider, read locally by
   *  the daemon and pushed with its status. Absent when not connected or the
   *  read failed. */
  usage: S.optional(S.NullOr(ProviderUsageSnapshot)),
});
export type TDaemonProviderConnection = S.Schema.Type<
  typeof DaemonProviderConnection
>;

// POST /cli-install/:slug — install the daemon's isolated copy of a
// vendor CLI. Returns the resulting install state.
export const DaemonCliInstallResponse = S.Struct({
  provider: S.String,
  installed: S.Boolean,
  version: S.optional(S.NullOr(S.String)),
  detail: S.optional(S.String),
});
export type TDaemonCliInstallResponse = S.Schema.Type<
  typeof DaemonCliInstallResponse
>;

// Outcome of the daemon's last cloud bootstrap — drives the dashboard's
// 3-state Providers UI: needs a key (`no_key`/`invalid_key`) → show the
// API-key picker; `unreachable` → retry hint; `ok` → provider cards.
export const DaemonCloudState = S.Literal(
  "ok",
  "no_key",
  "invalid_key",
  "unreachable",
);
export type TDaemonCloudState = S.Schema.Type<typeof DaemonCloudState>;

/** One integration the daemon detected on its box (best-effort, per the
 *  claude-code target footprint). Lets the dashboard render a stateful
 *  Install vs ✓ installed / Uninstall button. See
 *  `docs/proposals/daemon-integration-triggers.md` §7. */
export const DaemonInstalledIntegration = S.Struct({
  kind: S.Literal("skill", "plugin", "setup"),
  slug: S.String,
  installed: S.Boolean,
});
export type TDaemonInstalledIntegration = S.Schema.Type<
  typeof DaemonInstalledIntegration
>;

// GET /status
export const DaemonStatus = S.Struct({
  daemon_version: S.String,
  /** Whether an sk-llm key is set (the daemon installs keyless). */
  key_configured: S.Boolean,
  /** Whether automatic self-update is enabled (OPT-OUT, default on). Drives the
   *  dashboard's auto-update switch; toggled via the `set_auto_update` command.
   *  Absent on daemons too old to report it — those always self-updated, so the
   *  switch then reads as on. See `packages/daemon/src/auto-update-pref.ts`. */
  auto_update: S.optional(S.Boolean),
  /** Result of the last bootstrap — see `DaemonCloudState`. */
  cloud_state: DaemonCloudState,
  /** This daemon's X25519 public key (SPKI DER, base64). Lets ANOTHER of the
   *  user's daemons SEAL a Claude setup-token to it for cross-machine copy
   *  (`/api/daemon/relay-credential`) — the cloud only ever relays ciphertext.
   *  Absent on daemons too old to publish one. */
  pubkey: S.optional(S.String),
  /** The loopback port this daemon's `/v1/*` + `/whoami` surface listens on
   *  (`OPENLLM_DAEMON_PORT`, default 8787). The dashboard probes
   *  `http://127.0.0.1:<port>/whoami` to learn which key's daemon is on THIS
   *  host — the single authoritative locality signal (answering your own
   *  loopback proves your own machine). Absent on daemons too old to publish
   *  it; the probe falls back to the default port. See
   *  `docs/proposals/this-machine-detection-audit.md`. */
  port: S.optional(S.Number),
  /** The OS-sandbox posture this daemon booted with (`sandbox/landlock.ts`):
   *  `enforced` (Landlock active), `off` (kill switch / dev opt-out),
   *  `unsupported` (non-Linux, or a kernel without Landlock — the systemd
   *  unit hardening may still confine the service), `error` (setup failed —
   *  fail-open, surfaced so an unconfined daemon is visible, not silent).
   *  Absent on daemons too old to report it. */
  sandbox: S.optional(S.Literal("enforced", "off", "unsupported", "error")),
  connections: S.Array(DaemonProviderConnection),
  /** Integrations detected installed on this box (claude-code target,
   *  best-effort). Absent on daemons too old to report it; the dashboard then
   *  offers both Install + Uninstall (idempotent). */
  integrations: S.optional(S.Array(DaemonInstalledIntegration)),
});
export type TDaemonStatus = S.Schema.Type<typeof DaemonStatus>;

/**
 * Canonical payload the cloud HMAC-signs for the same-machine 307, and the
 * daemon re-derives to verify it (proposals: same-machine-307-redirect §9 +
 * daemon-presence-without-heartbeat). Order + separators are load-bearing —
 * both sides MUST assemble it identically, so it lives here, shared. Covers:
 * the ordered `__plan` (provider/model ids), the parallel `__pmids` (concrete
 * upstream `provider_model_id`s, so the daemon serves catalog-free), and the
 * `__origin` (the deployment that issued the 307, so the daemon forwards +
 * records back to it). Signing the lot makes the upstream ids and the
 * forward/record target tamper-evident.
 */
export const daemonPlanSigningPayload = (
  plan: string,
  providerModelIds: string,
  origin: string,
): string => `${plan}\n${providerModelIds}\n${origin}`;

/** Header a managed client sets when it FOLLOWED a 307 to its loopback and
 *  the daemon refused (stopped/crashed): "route me without the daemon", so the
 *  cloud skips subscription hops and serves the API-key fallthrough (§7.1). */
export const NO_DAEMON_HEADER = "x-openllm-no-daemon";

/** Headers the daemon stamps on EVERY cloud control call (poll/status/bootstrap
 *  /requests/relay/search) so the cloud can record which device a key's daemon
 *  runs on — `api_key_activity.device_id`/`device_label`. The id is the daemon's
 *  stable opaque per-machine UUID (`OPENLLM_DEVICE_ID` in `~/.openllm/daemon.env`); the label is the
 *  host's `os.hostname()` for the dashboard to show. Both metadata-only (no
 *  token, no content). Lets the dashboard tell two daemons behind one NAT apart
 *  — device code + IP, not IP alone. See
 *  `docs/proposals/daemon-device-aware-this-machine.md`. */
export const DAEMON_DEVICE_ID_HEADER = "x-openllm-device-id";
export const DAEMON_DEVICE_LABEL_HEADER = "x-openllm-device-label";

/** Header a BROWSER client (the dashboard "Try" card) sets to ask the cloud to
 *  describe a daemon redirect as a readable `200 { redirect, location }` JSON
 *  instead of a `307`. A browser `fetch` can't read a cross-origin 307 (it
 *  comes back as an opaqueredirect: status 0, no headers), so it can never
 *  follow the daemon hop itself. With this header the card reads `location` and
 *  fetches the daemon directly. Non-browser clients omit it and get the 307. */
export const REDIRECT_JSON_HEADER = "x-openllm-redirect-json";

// POST /config/api-key — set/update the daemon's sk-llm key after install.
export const DaemonSetApiKeyRequest = S.Struct({
  api_key: S.String,
});
export type TDaemonSetApiKeyRequest = S.Schema.Type<
  typeof DaemonSetApiKeyRequest
>;

export const DaemonSetApiKeyResponse = S.Struct({
  key_configured: S.Boolean,
  cloud_state: DaemonCloudState,
});
export type TDaemonSetApiKeyResponse = S.Schema.Type<
  typeof DaemonSetApiKeyResponse
>;

// POST /connect/:slug
export const DaemonConnectResponse = S.Struct({
  provider: S.String,
  connected: S.Boolean,
  detail: S.optional(S.String),
  /**
   * True when `connect` kicked off an async flow that hasn't finished yet
   * (Kimi's device-code login: browser opened, daemon polling in the
   * background). `detail` is then INFORMATIONAL guidance, not an error —
   * the UI renders it neutrally and the status stream flips to connected
   * when the flow completes. Absent/false on terminal results.
   */
  pending: S.optional(S.Boolean),
});
export type TDaemonConnectResponse = S.Schema.Type<
  typeof DaemonConnectResponse
>;

// GET /usage/:slug — reuses the existing snapshot shape verbatim.
export const DaemonUsageResponse = S.Struct({
  provider: S.String,
  snapshot: ProviderUsageSnapshot,
});
export type TDaemonUsageResponse = S.Schema.Type<typeof DaemonUsageResponse>;
