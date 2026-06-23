import { Schema as S } from "effect";
import { RelayCommandLifecycleFrame } from "./control-channel";
import { DaemonCommand, DaemonCommandAck } from "./daemon";

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
});
export type TRelayStatusPushFrame = S.Schema.Type<typeof RelayStatusPushFrame>;

/** relay → watcher. A key's daemon presence flipped (socket open/close). */
export const RelayPresenceFrame = S.Struct({
  type: S.Literal("presence"),
  key_id: S.String,
  active: S.Boolean,
});
export type TRelayPresenceFrame = S.Schema.Type<typeof RelayPresenceFrame>;

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
  RelayPingFrame,
  RelayPongFrame,
);
export type TRelayFrame = S.Schema.Type<typeof RelayFrame>;
