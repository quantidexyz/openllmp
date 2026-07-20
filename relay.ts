import { Schema as S } from "effect";
import { RelayCommandLifecycleFrame } from "./control-channel";
import {
  DaemonCommand,
  DaemonCommandAck,
  SubscriptionProviderSlug,
} from "./daemon";
import {
  ChannelCloseReason,
  ChannelOpenError,
  SessionId,
  TunnelForwardHeaders,
  TunnelResponseHeaders,
  TunnelSurface,
} from "./mux";

// ─── Daemon relay (push over a Sandbox WebSocket, in-memory routing) ──
//
// A persistent WebSocket each end (daemon AND browser) holds to a relay
// running in a Vercel Sandbox. The relay routes commands IN MEMORY: a
// watcher's `enqueue` is forwarded straight to the matching daemon socket
// and the daemon's terminal `ack` rides back as a live `command_lifecycle`
// frame — there is no `daemon_commands` mailbox and no Neon CDC. The one
// durable write the relay keeps is `api_key_activity` presence/status, read
// by the stateless `/v1/*` proxy + a cold dashboard load. See
// `docs/proposals/daemon-owned-state-stateless-relay.md`.

/** Which end a connect ticket authorizes. A `daemon` socket receives
 *  commands for its `key_id` and sends acks/status; a `watcher` socket
 *  (a dashboard tab) enqueues commands for keys its `user_id` owns and
 *  receives status/presence pushes. */
export const RelayRole = S.Literal("daemon", "watcher");
export type TRelayRole = S.Schema.Type<typeof RelayRole>;

/** Domain-separation label for the connect-ticket HMAC. Shared by the cloud
 *  signer (`packages/api/lib/relay-ticket.ts`) and the relay verifier
 *  (`packages/daemon-relay/src/ticket.ts`) so the two can never drift. */
export const RELAY_TICKET_LABEL = "openllm-relay-ticket-v1";

/** The port the in-sandbox WS server listens on — declared in `ports` at
 *  `Sandbox.getOrCreate` (cloud) and bound by the relay. A fixed internal
 *  constant (the public surface is the sandbox's own domain), shared so the
 *  provisioner's `sandbox.domain(port)` and the relay's listener agree. */
export const RELAY_PORT = 8080;

export type TRelayDatabaseTarget = "pre-production" | "production";

/**
 * The relay identity (sandbox name + TTL class) for the current deployment,
 * derived from `VERCEL_ENV` — the only remaining discriminator now that a
 * single `DATABASE_URL_UNPOOLED` selects the Neon database per environment
 * (Vercel injects the matching value in each env; local dev points it at the
 * dev branch). `production` only on the Vercel production deployment;
 * everything else (preview, `vercel dev`, plain `next dev`, tests) is
 * `pre-production`. Pure (a function of its input) so the DB client, the cloud
 * provisioner, and the in-sandbox relay all agree from the same signal.
 */
export const resolveDatabaseTarget = (
  vercelEnv: string | undefined,
): TRelayDatabaseTarget =>
  vercelEnv === "production" ? "production" : "pre-production";

/** The name of the retired daemon-relay logical-replication slot. The relay no
 *  longer subscribes it (commands route in memory) — this is kept ONLY so
 *  `packages/db/migrate.ts` can DROP a leftover slot on deploy (Phase 5
 *  demolition). The matching `daemon_relay_pub` publication is dropped by
 *  `migrations/0007_chunky_expediter.sql` using its literal name. */
export const RELAY_SLOT = "daemon_relay_slot";

/** The per-environment relay identity — just the sandbox name now (the
 *  publication/slot the CDC era carried are gone). Pure derivation (no env, no
 *  I/O) so the cloud provisioner and the relay agree. */
export type TRelayNames = {
  readonly relayName: string;
};

export const relayNamesFor = (target: TRelayDatabaseTarget): TRelayNames => ({
  relayName: `daemon-relay-${target}`,
});

// ─── Sandbox origin tags (deprovisioning) ─────────────────────────────
//
// The provisioner tags each relay sandbox with the stable ORIGIN that uses it
// — the deployment "place" (production URL / preview branch URL / local
// hostname) — plus a freshness timestamp, refreshed on healthy channel
// fetches. The cleanup cron groups boxes by origin and gracefully stops a
// superseded box (same origin, older freshness, different bundle hash) —
// see `lib/relay-sandbox-cleanup.ts`.

/** Tag key: the sanitized stable origin that provisioned/uses this box. */
export const RELAY_TAG_ORIGIN = "origin";
/** Tag key: unix-ms (decimal string) of the origin's last claim/refresh. */
export const RELAY_TAG_ORIGIN_AT = "origin-at";

/** The env signals the origin is derived from. `localHostname` is caller-
 *  provided (`os.hostname()`) so this stays pure and testable. */
export type TRelayOriginInputs = {
  readonly vercelEnv: string | undefined;
  readonly projectProductionUrl: string | undefined;
  readonly branchUrl: string | undefined;
  readonly deploymentUrl: string | undefined;
  readonly localHostname: string | undefined;
};

/** Sandbox tag values must be short, plain tokens. Lowercase, strip the
 *  protocol + trailing slash, squash anything outside [a-z0-9._-], cap at 64.
 *  Returns null when nothing usable remains so the caller can fall back. */
const sanitizeOriginTag = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 64);
  return cleaned === "" ? null : cleaned;
};

/**
 * The STABLE origin identity for sandbox tagging — stable across deploys of
 * the same "place", so the cleanup cron's per-origin change detection fires:
 *   production → the project production URL (not the per-deploy VERCEL_URL);
 *   preview    → the branch URL (stable per git branch), falling back to the
 *                per-deploy URL only when the branch URL is absent;
 *   local/test → `local-<hostname>` so two developers never supersede each
 *                other's boxes.
 * Pure (a function of its inputs) per the convention above.
 */
export const resolveRelayOrigin = (inputs: TRelayOriginInputs): string => {
  if (inputs.vercelEnv === "production") {
    return sanitizeOriginTag(inputs.projectProductionUrl) ?? "production";
  }
  if (inputs.vercelEnv === "preview") {
    return (
      sanitizeOriginTag(inputs.branchUrl) ??
      sanitizeOriginTag(inputs.deploymentUrl) ??
      "preview"
    );
  }
  const host = sanitizeOriginTag(inputs.localHostname);
  return host === null ? "local" : `local-${host}`;
};

/**
 * The decoded claims of a connect ticket. The cloud (`/api/daemon/channel`)
 * mints these after validating the caller (`sk-llm` key → `daemon`, Neon
 * Auth session → `watcher`) and HMAC-signs them; the relay verifies the
 * signature and trusts these claims (it does NO DB-side auth in the
 * Sandbox). `key_id` is present iff `role === "daemon"`. `exp` is a unix-ms
 * deadline kept short (~60s) so a leaked ticket is near-useless.
 */
export const RelayTicketClaims = S.Struct({
  role: RelayRole,
  user_id: S.String,
  key_id: S.optional(S.String),
  exp: S.Number,
});
export type TRelayTicketClaims = S.Schema.Type<typeof RelayTicketClaims>;

/** GET /api/daemon/channel → the live relay WSS URL + a connect ticket. Both
 *  daemon and browser dial `wss_url`, presenting `ticket` in their first
 *  `hello` frame. The URL is the sandbox's own domain (`wss://<sandbox-host>`);
 *  it can rotate when the relay cycles, so clients re-fetch this on every
 *  (re)connect rather than caching the host. */
export const RelayChannelResponse = S.Struct({
  wss_url: S.String,
  /** Short-lived HMAC connect ticket (opaque `<b64url(claims)>.<hmac>`). */
  ticket: S.String,
});
export type TRelayChannelResponse = S.Schema.Type<typeof RelayChannelResponse>;

// ─── WebSocket frame envelope ────────────────────────────────────────
//
// One tagged union shared by all four parties. Each variant documents its
// direction; a given end only emits the subset it owns and ignores the
// rest. JSON over text frames.

/** client → relay (first frame). A daemon may piggyback its initial
 *  status snapshot; a watcher sends ticket only. */
export const RelayHelloFrame = S.Struct({
  type: S.Literal("hello"),
  ticket: S.String,
  /** Daemon protocol capability; absent daemons retain legacy compatibility. */
  protocol_version: S.optional(S.Number),
  /** Open-vocabulary peer capability list.
   * Unknown capabilities preserve forward compatibility. */
  caps: S.optional(S.Array(S.String)),
  /** Daemon only: initial per-provider `TDaemonStatus` snapshot, folded
   *  into `api_key_activity.daemon_status_json` on connect. */
  status: S.optional(S.Unknown),
});
export type TRelayHelloFrame = S.Schema.Type<typeof RelayHelloFrame>;

/** relay → client. Handshake accepted; carries the current presence snapshot so
 *  a freshly-attached dashboard paints immediately. */
export const RelayWelcomeFrame = S.Struct({
  type: S.Literal("welcome"),
  /** Watcher only: the AUTHORITATIVE set of the user's key ids that have a live
   *  daemon socket on the relay right now, from its in-memory registry. The
   *  dashboard treats membership as presence — keys absent here are offline by
   *  authority of the relay that owns every socket — so a stale-`true`
   *  `api_key_activity` row (ungraceful relay death) is corrected the instant a
   *  watcher (re)connects. Live status keeps flowing via `status_push`. */
  snapshot: S.optional(S.Array(S.String)),
  /** Daemon only: relay-assigned connection epoch for ordered snapshots. */
  daemon_session_id: S.optional(S.String),
  daemon_session_started_at_ms: S.optional(S.Number),
  protocol_version: S.optional(S.Number),
  /** Relay capabilities. */
  caps: S.optional(S.Array(S.String)),
  /** Per-serving-daemon capability snapshots, parallel to `snapshot`. */
  snapshot_caps: S.optional(
    S.Record({ key: S.String, value: S.Array(S.String) }),
  ),
});
export type TRelayWelcomeFrame = S.Schema.Type<typeof RelayWelcomeFrame>;

/** relay → daemon. One command to run, routed in memory the instant the watcher
 *  enqueues it (no durable mailbox). `id` is a relay-generated uuid. */
export const RelayCommandFrame = S.Struct({
  type: S.Literal("command"),
  command: DaemonCommand,
});
export type TRelayCommandFrame = S.Schema.Type<typeof RelayCommandFrame>;

/** daemon → relay. A terminal command result; the relay forwards it to the
 *  originating watcher as a `command_lifecycle` frame (no `daemon_commands`
 *  row to update). */
export const RelayAckFrame = S.Struct({
  type: S.Literal("ack"),
  ack: DaemonCommandAck,
});
export type TRelayAckFrame = S.Schema.Type<typeof RelayAckFrame>;

/** daemon → relay. Heartbeat + per-provider snapshot. `active:false` is the
 *  graceful-exit beacon. The relay folds the snapshot into
 *  `api_key_activity.daemon_status_json` (durable, read by the proxy + a cold
 *  HTTP load) and fans it out to the user's watchers (`status_push`). */
export const RelayStatusFrame = S.Struct({
  type: S.Literal("status"),
  active: S.optional(S.Boolean),
  status: S.optional(S.Unknown),
  /** Present for protocol-v2 daemon status snapshots. */
  daemon_session_id: S.optional(S.String),
  status_seq: S.optional(S.Number),
  acks: S.optional(S.Array(DaemonCommandAck)),
});
export type TRelayStatusFrame = S.Schema.Type<typeof RelayStatusFrame>;

/** watcher → relay. The dashboard enqueues a control command for one of the
 *  user's keys. The relay authorizes it by REGISTRY MEMBERSHIP — a watcher may
 *  address `key_id` K iff a daemon socket for K is connected with the same
 *  `user_id` (off that daemon's ticket) — then routes it to that socket in
 *  memory. `req_id` correlates the relay's `enqueue_ack`; omit it for
 *  fire-and-forget. */
export const RelayEnqueueFrame = S.Struct({
  type: S.Literal("enqueue"),
  req_id: S.optional(S.String),
  key_id: S.String,
  kind: S.String,
  payload: S.optional(S.Unknown),
});
export type TRelayEnqueueFrame = S.Schema.Type<typeof RelayEnqueueFrame>;

/** relay → watcher. The result of an `enqueue` carrying a `req_id`: the
 *  relay-generated command id on success, or an error (`daemon_offline` /
 *  `invalid_command`). */
export const RelayEnqueueAckFrame = S.Struct({
  type: S.Literal("enqueue_ack"),
  req_id: S.String,
  ok: S.Boolean,
  id: S.optional(S.String),
  error: S.optional(S.String),
});
export type TRelayEnqueueAckFrame = S.Schema.Type<typeof RelayEnqueueAckFrame>;

/** relay → watcher. A daemon's status snapshot for one key landed; push it
 *  to the dashboard. */
export const RelayStatusPushFrame = S.Struct({
  type: S.Literal("status_push"),
  key_id: S.String,
  status: S.Unknown,
  daemon_session_id: S.optional(S.String),
  daemon_session_started_at_ms: S.optional(S.Number),
  status_seq: S.optional(S.Number),
});
export type TRelayStatusPushFrame = S.Schema.Type<typeof RelayStatusPushFrame>;

/** relay → watcher. A key's daemon presence flipped (socket open/close). */
export const RelayPresenceFrame = S.Struct({
  type: S.Literal("presence"),
  key_id: S.String,
  active: S.Boolean,
  /** Present when an active daemon advertises capabilities. */
  caps: S.optional(S.Array(S.String)),
});
export type TRelayPresenceFrame = S.Schema.Type<typeof RelayPresenceFrame>;

// ─── Subscription tunnel (consumer ⇄ relay ⇄ serving daemon) ─────────
//
// A consumer (browser watcher socket, or another daemon's socket) opens a
// virtual byte channel through the relay to a SERVING daemon, which
// dispatches the request against its own local `/v1/*` data plane and
// streams the response back. Same-user only (registry-membership auth,
// exactly like `enqueue`); the vendor subscription token never crosses —
// only OpenLLM-wire request/response bytes do. The relay never buffers:
// frames are forwarded synchronously between the two endpoint sockets.
// See `docs/features/sub-tunnel-and-chat-sessions.md` §1.

/** Max raw bytes per `tunnel_data` chunk (pre-base64). Shared by the
 *  serving daemon's response splitter and any consumer request splitter so
 *  frames stay well under WS payload bounds after b64 inflation. */
export const TUNNEL_CHUNK_MAX = 48 * 1024;

/** Base64 length of a maximal chunk (4 chars per 3 raw bytes — 48 KiB is
 *  a multiple of 3, so no padding slack). Bounds every `data_b64` field so
 *  a peer can't ship an arbitrarily large frame past the splitters. */
export const TUNNEL_CHUNK_B64_MAX = (TUNNEL_CHUNK_MAX / 3) * 4;

/** Idle deadline for a tunnel with no frame activity in either direction —
 *  the relay closes both ends `reason:"timeout"` on its keepalive tick. */
export const TUNNEL_IDLE_TIMEOUT_MS = 120_000;

/** consumer → relay → serving daemon. Open a tunnel to the daemon serving
 *  `key_id`. The CONSUMER mints `tunnel_id` (uuid); the relay authorizes by
 *  registry membership (same `user_id`, live daemon socket, not the sender
 *  itself) and forwards the frame verbatim. */
export const RelayTunnelOpenFrame = S.Struct({
  type: S.Literal("tunnel_open"),
  tunnel_id: S.String,
  key_id: S.String,
  method: S.Literal("POST"),
  surface: TunnelSurface,
  headers: S.optional(TunnelForwardHeaders),
  /** Consuming-device tag, threaded into serving-side usage recording. */
  consumer: S.optional(S.Literal("browser", "daemon")),
});
export type TRelayTunnelOpenFrame = S.Schema.Type<typeof RelayTunnelOpenFrame>;

export const TunnelOpenError = S.Literal(
  "daemon_offline",
  "tunnel_refused",
  "tunnel_busy",
  "invalid_tunnel",
  "overloaded",
);
export type TTunnelOpenError = S.Schema.Type<typeof TunnelOpenError>;

/** serving daemon → relay → consumer (or relay-minted on auth failure). */
export const RelayTunnelOpenAckFrame = S.Struct({
  type: S.Literal("tunnel_open_ack"),
  tunnel_id: S.String,
  ok: S.Boolean,
  error: S.optional(TunnelOpenError),
});
export type TRelayTunnelOpenAckFrame = S.Schema.Type<
  typeof RelayTunnelOpenAckFrame
>;

/** Both directions. One body chunk, base64 (frames are JSON text — binary WS
 *  frames are dropped). `seq` starts at 0 per direction (WS is ordered; seq
 *  is a cheap integrity assert + room for credit-based flow control later).
 *  The first `dir:"res"` frame carries `status` + `res_headers`. */
export const RelayTunnelDataFrame = S.Struct({
  type: S.Literal("tunnel_data"),
  tunnel_id: S.String,
  seq: S.Number,
  dir: S.Literal("req", "res"),
  data_b64: S.String,
  status: S.optional(S.Number),
  res_headers: S.optional(TunnelResponseHeaders),
});
export type TRelayTunnelDataFrame = S.Schema.Type<typeof RelayTunnelDataFrame>;

/** Sender-side EOF for one direction (request fully sent / response fully
 *  streamed). A tunnel completes normally after both directions end. */
export const RelayTunnelEndFrame = S.Struct({
  type: S.Literal("tunnel_end"),
  tunnel_id: S.String,
  dir: S.Literal("req", "res"),
});
export type TRelayTunnelEndFrame = S.Schema.Type<typeof RelayTunnelEndFrame>;

export const TunnelCloseReason = S.Literal(
  "done",
  "consumer_gone",
  "daemon_gone",
  "timeout",
  "protocol_error",
  "overloaded",
);
export type TTunnelCloseReason = S.Schema.Type<typeof TunnelCloseReason>;

/** Either side / relay-minted — hard teardown. The serving daemon aborts its
 *  in-flight dispatch; the consumer errors its pending Response stream. */
export const RelayTunnelCloseFrame = S.Struct({
  type: S.Literal("tunnel_close"),
  tunnel_id: S.String,
  reason: S.optional(TunnelCloseReason),
});
export type TRelayTunnelCloseFrame = S.Schema.Type<
  typeof RelayTunnelCloseFrame
>;

// ─── Device chat sessions (browser ⇄ relay ⇄ daemon PTY) ─────────────
//
// A watcher opens a LONG-LIVED full-duplex channel to a daemon, which
// spawns (or re-attaches) a vendor CLI under a PTY in
// `~/.openllm/sessions/<id>/` and streams the TUI both ways. Mirrors the
// tunnel splice (consumer-minted id, same-user registry auth, per-frame
// in-memory forward, chunk cap) but is its OWN family: a PTY has no
// request/response shape, no per-direction EOF, and must survive quiet
// periods (sessions are excluded from the tunnel idle sweep — the daemon
// owns detached-session reaping). See
// `docs/features/sub-tunnel-and-chat-sessions.md` §2.2.

/** @deprecated Reaping now uses activity-based quiet time. */
export const SESSION_DETACHED_TTL_MS = 30 * 60_000;
/** Detached PTYs reap only after this long without output or busy activity. */
export const SESSION_QUIET_REAP_MS = 30 * 60_000;

/** watcher → relay → daemon. Open a device session on the daemon serving
 *  `key_id`. `mode`: `spawn` = fresh CLI in a new workspace; `attach` =
 *  re-bind a LIVE PTY (scrollback replays); `continue` = respawn a DEAD
 *  session in its existing workspace with the CLI's native continue flag
 *  where the daemon knows one. */
export const RelaySessionOpenFrame = S.Struct({
  type: S.Literal("session_open"),
  session_id: SessionId,
  key_id: S.String,
  cli: SubscriptionProviderSlug,
  cols: S.Number,
  rows: S.Number,
  mode: S.Literal("spawn", "attach", "continue"),
  title: S.optional(S.String.pipe(S.maxLength(80))),
});
export type TRelaySessionOpenFrame = S.Schema.Type<
  typeof RelaySessionOpenFrame
>;

export const SessionOpenError = S.Literal(
  "daemon_offline",
  "pty_unsupported",
  "cli_not_installed",
  "session_not_found",
  "session_busy",
  "overloaded",
  "spawn_failed",
);
export type TSessionOpenError = S.Schema.Type<typeof SessionOpenError>;

/** daemon → relay → watcher (or relay-minted on auth failure). `live` on
 *  a successful attach tells the consumer whether the PTY was still
 *  running (scrollback replay follows) or was respawned. */
export const RelaySessionOpenAckFrame = S.Struct({
  type: S.Literal("session_open_ack"),
  session_id: SessionId,
  ok: S.Boolean,
  error: S.optional(SessionOpenError),
  live: S.optional(S.Boolean),
});
export type TRelaySessionOpenAckFrame = S.Schema.Type<
  typeof RelaySessionOpenAckFrame
>;

/** Both directions. `dir:"out"` = PTY output → browser (xterm.write);
 *  `dir:"in"` = keystrokes → PTY. Base64 over the JSON text frame, capped
 *  at TUNNEL_CHUNK_MAX raw bytes per frame. */
export const RelaySessionIoFrame = S.Struct({
  type: S.Literal("session_io"),
  session_id: SessionId,
  dir: S.Literal("in", "out"),
  seq: S.Number,
  // Bounded to one maximal chunk after b64 inflation — matches the
  // sender-side `sendOut` splitter (TUNNEL_CHUNK_MAX raw bytes/frame).
  data_b64: S.String.pipe(S.maxLength(TUNNEL_CHUNK_B64_MAX)),
});
export type TRelaySessionIoFrame = S.Schema.Type<typeof RelaySessionIoFrame>;

/** watcher → relay → daemon. The terminal pane resized. */
export const RelaySessionResizeFrame = S.Struct({
  type: S.Literal("session_resize"),
  session_id: SessionId,
  cols: S.Number,
  rows: S.Number,
});
export type TRelaySessionResizeFrame = S.Schema.Type<
  typeof RelaySessionResizeFrame
>;

export const SessionCloseReason = S.Literal(
  /** Consumer detached (tab closed / navigated away) — the PTY LIVES ON
   *  (dormant) until the daemon's detached-TTL reaper fires. */
  "detach",
  /** The CLI process exited. */
  "done",
  /** Explicit user kill. */
  "killed",
  "consumer_gone",
  "daemon_gone",
  "timeout",
  "protocol_error",
);
export type TSessionCloseReason = S.Schema.Type<typeof SessionCloseReason>;

/** Either side / relay-minted — ends the CHANNEL. `detach` keeps the PTY
 *  alive daemon-side; every other reason implies the session is over or
 *  unreachable. */
export const RelaySessionCloseFrame = S.Struct({
  type: S.Literal("session_close"),
  session_id: SessionId,
  reason: S.optional(SessionCloseReason),
});
export type TRelaySessionCloseFrame = S.Schema.Type<
  typeof RelaySessionCloseFrame
>;

// ─── Mux channels (consumer ⇄ relay ⇄ serving daemon) ─────────────────

/** consumer → relay → serving daemon. Auth runs once when opening this
 * channel; after acceptance, all subsequent binary frames on both sockets
 * belong to this channel. */
export const RelayChannelOpenFrame = S.Struct({
  type: S.Literal("channel_open"),
  channel_id: S.String,
  key_id: S.String,
});
export type TRelayChannelOpenFrame = S.Schema.Type<
  typeof RelayChannelOpenFrame
>;

/** serving daemon → relay → consumer. The relay mints failure acknowledgements;
 * an accepting daemon's acknowledgement is echoed verbatim. */
export const RelayChannelOpenAckFrame = S.Struct({
  type: S.Literal("channel_open_ack"),
  channel_id: S.String,
  ok: S.Boolean,
  error: S.optional(ChannelOpenError),
});
export type TRelayChannelOpenAckFrame = S.Schema.Type<
  typeof RelayChannelOpenAckFrame
>;

/** Either side / relay-minted. `relay_restart` is a drain signal: consumers
 * reset in-flight streams and fall back to the JSON splice. */
export const RelayChannelCloseFrame = S.Struct({
  type: S.Literal("channel_close"),
  channel_id: S.String,
  reason: S.optional(ChannelCloseReason),
});
export type TRelayChannelCloseFrame = S.Schema.Type<
  typeof RelayChannelCloseFrame
>;

/** Keepalive (both directions). The relay pings below Cloudflare's
 *  proxied-WS idle bound; a missed pong is the relay's dead-peer signal. */
export const RelayPingFrame = S.Struct({ type: S.Literal("ping") });
export type TRelayPingFrame = S.Schema.Type<typeof RelayPingFrame>;

export const RelayPongFrame = S.Struct({ type: S.Literal("pong") });
export type TRelayPongFrame = S.Schema.Type<typeof RelayPongFrame>;

// NOTE: older daemon binaries also sent `received` (a per-command delivery
// receipt) and `resync` (a periodic "re-push my pending rows" floor). Both are
// retired — there is no durable mailbox to redeliver from anymore — so neither
// has a consumer. They are deliberately NOT in the union; an old daemon's frames
// fail decode and are silently dropped (`parseFrame` → null), the designed
// legacy tolerance.

/** The full frame union, discriminated on `type`. `command_lifecycle` (relay →
 *  watcher) is the stateless-relay command receipt: the relay forwards the
 *  daemon's terminal `ack` to the originating watcher as a live lifecycle
 *  update, so the dashboard releases an optimistic button off the socket — no
 *  DB `command_seq` cursor. See `control-channel.ts` +
 *  `docs/proposals/daemon-owned-state-stateless-relay.md`. */
export const RelayFrame = S.Union(
  RelayHelloFrame,
  RelayWelcomeFrame,
  RelayCommandFrame,
  RelayAckFrame,
  RelayStatusFrame,
  RelayEnqueueFrame,
  RelayEnqueueAckFrame,
  RelayStatusPushFrame,
  RelayPresenceFrame,
  RelayCommandLifecycleFrame,
  RelayTunnelOpenFrame,
  RelayTunnelOpenAckFrame,
  RelayTunnelDataFrame,
  RelayTunnelEndFrame,
  RelayTunnelCloseFrame,
  RelaySessionOpenFrame,
  RelaySessionOpenAckFrame,
  RelaySessionIoFrame,
  RelaySessionResizeFrame,
  RelaySessionCloseFrame,
  RelayChannelOpenFrame,
  RelayChannelOpenAckFrame,
  RelayChannelCloseFrame,
  RelayPingFrame,
  RelayPongFrame,
);
export type TRelayFrame = S.Schema.Type<typeof RelayFrame>;
