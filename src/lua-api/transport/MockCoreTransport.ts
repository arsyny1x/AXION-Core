/**
 * In-memory mock transport used for development and tests.
 *
 * IMPORTANT: This is NOT a real network transport. It does not open sockets,
 * authenticate, or speak any wire protocol. It exists purely so the module's
 * contracts can be exercised without a Central Core.
 */

import { err } from "../errors";
import type { ConnectionState } from "../types";
import {
  createEnvelope,
  PROTOCOL_VERSION,
  type CoreMessageEnvelope,
  type ICoreTransport,
  type TransportConnectOptions,
  type TransportMessageHandler,
  type TransportStateHandler,
} from "./ICoreTransport";

export interface MockCoreTransportOptions {
  /** Delay (ms) applied to connect()/send() to simulate latency. */
  latencyMs?: number;
  /** When true, connect() fails once and returns an error state. */
  failNextConnect?: boolean;
  /** Default protocol version override (rarely needed). */
  protocolVersion?: string;
}

export class MockCoreTransport implements ICoreTransport {
  private state: ConnectionState = "disconnected";
  private readonly messageHandlers = new Set<TransportMessageHandler>();
  private readonly stateHandlers = new Set<TransportStateHandler>();
  private readonly opts: Required<MockCoreTransportOptions>;
  private sent: CoreMessageEnvelope[] = [];

  constructor(options: MockCoreTransportOptions = {}) {
    this.opts = {
      latencyMs: options.latencyMs ?? 0,
      failNextConnect: options.failNextConnect ?? false,
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    };
  }

  async connect(options: TransportConnectOptions = {}): Promise<void> {
    if (this.state === "connected") return;
    this.setState("connecting");
    await this.delay();
    if (this.opts.failNextConnect) {
      this.opts.failNextConnect = false;
      this.setState("error");
      throw err.transportError("Mock transport configured to fail the next connect");
    }
    if (options.timeoutMs !== undefined && options.timeoutMs < 0) {
      this.setState("error");
      throw err.invalidArgument("timeoutMs must be >= 0");
    }
    this.setState("connected");
  }

  async disconnect(): Promise<void> {
    if (this.state === "disconnected") return;
    await this.delay();
    this.setState("disconnected");
  }

  async send(message: CoreMessageEnvelope): Promise<void> {
    if (this.state !== "connected") {
      throw err.transportDisconnected();
    }
    if (message.protocolVersion !== this.opts.protocolVersion) {
      throw err.transportError("Protocol version mismatch", {
        expected: this.opts.protocolVersion,
        received: message.protocolVersion,
      });
    }
    await this.delay();
    this.sent.push(message);
  }

  onMessage(callback: TransportMessageHandler): () => void {
    this.messageHandlers.add(callback);
    return () => this.messageHandlers.delete(callback);
  }

  onStateChange(callback: TransportStateHandler): () => void {
    this.stateHandlers.add(callback);
    // Immediately notify the current state so subscribers aren't left blind.
    callback(this.state);
    return () => this.stateHandlers.delete(callback);
  }

  getState(): ConnectionState {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // Test / development helpers (not part of ICoreTransport)
  // ---------------------------------------------------------------------------

  /** Simulate an inbound message from the Central Core. */
  emitMessage(message: CoreMessageEnvelope): void {
    for (const handler of [...this.messageHandlers]) {
      handler(message);
    }
  }

  /** Simulate a connection-state transition. */
  setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of [...this.stateHandlers]) {
      handler(state);
    }
  }

  /** Inspect messages sent through this transport (useful in tests). */
  getSentMessages(): readonly CoreMessageEnvelope[] {
    return this.sent;
  }

  /** Clear recorded outbound messages. */
  clearSent(): void {
    this.sent = [];
  }

  /** Build an envelope that respects this transport's protocol version. */
  buildEnvelope = createEnvelope;

  private delay(): Promise<void> {
    if (this.opts.latencyMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.opts.latencyMs));
  }
}