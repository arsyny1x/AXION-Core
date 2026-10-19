/**
 * Transport adapter boundary.
 *
 * The Lua API module does not implement networking. It depends on this
 * interface so that a WebSocket, IPC, or in-process adapter can be plugged in
 * later without changes to the public `Core.*` API.
 */

import type { ConnectionState } from "../types";

export const PROTOCOL_VERSION = "1.0.0";

export type CoreMessageType =
  // Client -> Core
  | "client.register"
  | "client.unregister"
  | "client.status"
  | "task.request"
  | "task.progress"
  | "task.result"
  | "task.failure"
  | "task.cancel"
  | "client.error"
  | "heartbeat"
  // Player registry (Client -> Core)
  | "player.request"
  // Core -> Client
  | "client.registered"
  | "task.assigned"
  | "task.updated"
  | "task.cancelled"
  | "core.status"
  | "core.error"
  // Player registry (Core -> Client)
  | "player.connected"
  | "player.disconnected"
  | "player.updated"
  | "player.list";

export interface CoreMessageEnvelope<TPayload = unknown> {
  /** Unique message identifier. */
  id: string;
  /** Message kind; drives routing on both ends. */
  type: CoreMessageType;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Present when the sender knows the client id. */
  clientId?: string;
  /** Present when the message is a response to a prior message. */
  correlationId?: string;
  /** Envelope protocol version (independent of app version). */
  protocolVersion: string;
  /** Application-level payload. */
  payload: TPayload;
}

export interface TransportConnectOptions {
  url?: string;
  clientId?: string;
  auth?: Record<string, unknown>;
  timeoutMs?: number;
}

export type TransportMessageHandler = (message: CoreMessageEnvelope) => void;
export type TransportStateHandler = (state: ConnectionState) => void;

export interface ICoreTransport {
  connect(options: TransportConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  send(message: CoreMessageEnvelope): Promise<void>;
  onMessage(callback: TransportMessageHandler): () => void;
  /**
   * Optional but recommended. Used by the module to emit
   * `client.connected` / `client.disconnected` events reliably.
   */
  onStateChange?(callback: TransportStateHandler): () => void;
  getState(): ConnectionState;
}

/** Helper for building envelopes with sane defaults. */
export function createEnvelope<TPayload>(
  type: CoreMessageType,
  payload: TPayload,
  opts: {
    id: string;
    timestamp?: number;
    clientId?: string;
    correlationId?: string;
  },
): CoreMessageEnvelope<TPayload> {
  const envelope: CoreMessageEnvelope<TPayload> = {
    id: opts.id,
    type,
    timestamp: opts.timestamp ?? Date.now(),
    protocolVersion: PROTOCOL_VERSION,
    payload,
  };
  if (opts.clientId) envelope.clientId = opts.clientId;
  if (opts.correlationId) envelope.correlationId = opts.correlationId;
  return envelope;
}