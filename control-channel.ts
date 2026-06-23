import { Schema as S } from "effect";
import { DaemonCommandKind } from "./daemon";

// ─── Control channel — the live command lifecycle ────────────────────
//
// The stateless-relay contract: the relay is a pure socket binder (Browser
// WS ↔ Daemon WS) and the daemon is the source of truth. A command is a
// self-contained request → lifecycle → response with NO persistence — no
// `daemon_commands` mailbox, no history, no replay (it lives only as long as
// its sockets). This file owns the command lifecycle the browser drives its
// optimistic UI off; `device-state.ts` owns the snapshot the daemon pushes.
// See `docs/proposals/daemon-owned-state-stateless-relay.md`.
//
// NB: distinct from the daemon's local `packages/daemon/src/control-channel.ts`
// (the partysocket transport impl). This is the SHARED wire contract both ends
// and the relay decode against.

export type { TDaemonCommand, TDaemonCommandKind } from "./daemon";
// Re-export the closed command vocabulary so a consumer can import the whole
// control-channel contract from one module.
export { DaemonCommand, DaemonCommandKind } from "./daemon";

/**
 * The command lifecycle — daemon-asserted, pushed live over the socket.
 * Replaces the old `DaemonCommandAck { status: "done" | "error" }` binary with
 * a five-state progression:
 *
 *   pending  — browser → relay sent; no daemon ack yet (browser-local).
 *   ack      — the daemon received the command and began running it.
 *   done     — completed; the `-s` probe shows the box state actually changed.
 *   not_done — completed; the `-s` probe shows it was already in the desired
 *              state (a measured no-op). Reserved for a daemon-measured no-op —
 *              NEVER a transport rejection (an offline daemon yields `error`).
 *   error    — failed (or the relay had no live daemon socket: `daemon_offline`);
 *              carries `message`.
 *
 * `done`/`not_done` for the install/uninstall family come from the pre/post
 * `install.sh -s` probe (a measured fact, not a handler claim); commands with no
 * `-s` probe (connect/logout/refresh/…) return them from the handler.
 */
export const CommandState = S.Literal(
  "pending",
  "ack",
  "done",
  "not_done",
  "error",
);
export type TCommandState = S.Schema.Type<typeof CommandState>;

/** The terminal subset of `CommandState` — the states a command finally rests
 *  in. `pending`/`ack` are transient. */
export const TerminalCommandState = S.Literal("done", "not_done", "error");
export type TTerminalCommandState = S.Schema.Type<typeof TerminalCommandState>;

/**
 * One snapshot of a command's progress. The browser correlates by the `req_id`
 * it minted at enqueue; `kind` is informational (display / dedup). `message` is
 * a brief, human-readable line set on `error` (e.g. `daemon_offline`) and
 * optionally on `not_done`.
 */
export const CommandLifecycle = S.Struct({
  req_id: S.String,
  key_id: S.String,
  kind: DaemonCommandKind,
  state: CommandState,
  message: S.optional(S.String),
});
export type TCommandLifecycle = S.Schema.Type<typeof CommandLifecycle>;

// ─── New relay → watcher frames (stateless-relay transport) ──────────
//
// These supersede the old `enqueue_ack` / `status_push` / `presence` frames in
// `relay.ts` once Phase 3 lands. Defined additively here so later phases import
// a stable contract; the full `RelayFrame` union swap happens with the relay
// rewrite.

/** relay → watcher. A live update on a command the watcher enqueued. The
 *  terminal frame (`done`/`not_done`/`error`) is the receipt — there is no
 *  durable row to read back. */
export const RelayCommandLifecycleFrame = S.Struct({
  type: S.Literal("command_lifecycle"),
  lifecycle: CommandLifecycle,
});
export type TRelayCommandLifecycleFrame = S.Schema.Type<
  typeof RelayCommandLifecycleFrame
>;
