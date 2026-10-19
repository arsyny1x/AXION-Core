import { err } from "../../lua-api/errors";
import {
  PROTOCOL_VERSION,
  createEnvelope,
  type CoreMessageEnvelope,
  type ICoreTransport,
  type TransportConnectOptions,
} from "../../lua-api/transport/ICoreTransport";
import type { ConnectionState } from "../../lua-api/types";
import type { AXIONTaskRequestPayload, AXIONTaskResponse } from "./protocol";
export type { AXIONTaskFailure, AXIONTaskRequestPayload, AXIONTaskResponse } from "./protocol";

export interface AXIONConnectConfig extends TransportConnectOptions {
  protocolVersion?: string;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
}

export interface AXIONApi {
  connect(config: AXIONConnectConfig): Promise<void>;
  report(state: Record<string, unknown>): Promise<void>;
  request(task: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<AXIONTaskResponse>;
  on(event: string, callback: (payload: unknown) => void): () => void;
  getState(): Record<string, unknown> | null;
  cancel(taskId: string): Promise<void>;
  disconnect(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: AXIONTaskResponse) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AXIONClient implements AXIONApi {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeState?: () => void;
  private latestState: Record<string, unknown> | null = null;
  private config: AXIONConnectConfig | null = null;
  private desiredConnection = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;

  constructor(
    private readonly transport: ICoreTransport,
    private readonly createId: () => string = () => `axion-${++this.sequence}`,
  ) {
    this.unsubscribeMessage = transport.onMessage((message) => this.handleMessage(message));
    this.unsubscribeState = transport.onStateChange?.((state) => this.handleStateChange(state));
  }

  async connect(config: AXIONConnectConfig): Promise<void> {
    if (config.protocolVersion && config.protocolVersion !== PROTOCOL_VERSION) {
      throw err.transportError("Unsupported protocol version", {
        expected: PROTOCOL_VERSION,
        received: config.protocolVersion,
      });
    }
    if (config.reconnectDelayMs !== undefined && config.reconnectDelayMs < 0) {
      throw err.invalidArgument("reconnectDelayMs must be >= 0");
    }
    this.config = { ...config };
    this.desiredConnection = true;
    await this.transport.connect(config);
  }

  async report(state: Record<string, unknown>): Promise<void> {
    this.ensureConnected();
    if (!isRecord(state)) throw err.invalidArgument("state must be an object");
    this.latestState = { ...state };
    await this.transport.send(this.envelope("client.status", this.latestState));
  }

  request(
    task: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<AXIONTaskResponse> {
    this.ensureConnected();
    if (!task.trim()) throw err.invalidArgument("task must be a non-empty string");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw err.invalidArgument("timeoutMs must be a positive finite number");
    }
    const taskId = this.createId();
    const taskRequest: AXIONTaskRequestPayload = { task, taskId, payload };
    const message = this.envelope("task.request", taskRequest, taskId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        reject(err.timeout(`Task "${task}" timed out after ${timeoutMs}ms`, { taskId }));
      }, timeoutMs);
      this.pending.set(taskId, { resolve, reject, timer });
      void this.transport.send(message).catch((error: unknown) => {
        this.finishRequest(taskId, undefined, error);
      });
    });
  }

  on(event: string, callback: (payload: unknown) => void): () => void {
    if (!event.trim()) throw err.invalidArgument("event must be a non-empty string");
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(callback);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.listeners.delete(event);
    };
  }

  getState(): Record<string, unknown> | null {
    return this.latestState === null ? null : { ...this.latestState };
  }

  async cancel(taskId: string): Promise<void> {
    this.ensureConnected();
    if (!taskId.trim()) throw err.invalidArgument("taskId must be a non-empty string");
    await this.transport.send(this.envelope("task.cancel", { taskId }));
    this.finishRequest(taskId, undefined, err.cancelled(`Task "${taskId}" was cancelled`));
  }

  async disconnect(): Promise<void> {
    this.desiredConnection = false;
    this.clearReconnectTimer();
    for (const taskId of this.pending.keys()) {
      this.finishRequest(taskId, undefined, err.cancelled("Client disconnected"));
    }
    await this.transport.disconnect();
  }

  dispose(): void {
    this.desiredConnection = false;
    this.clearReconnectTimer();
    this.unsubscribeMessage();
    this.unsubscribeState?.();
    for (const taskId of this.pending.keys()) {
      this.finishRequest(taskId, undefined, err.cancelled("Client disposed"));
    }
    this.listeners.clear();
  }

  private handleMessage(message: CoreMessageEnvelope): void {
    if (message.protocolVersion !== PROTOCOL_VERSION) return;
    const correlationId = message.correlationId;
    if (correlationId && (message.type === "task.assigned" || message.type === "task.result")) {
      try {
        this.finishRequest(correlationId, validateTaskResponse(message.payload, correlationId));
      } catch (error) {
        this.finishRequest(correlationId, undefined, error);
      }
    } else if (correlationId && message.type === "task.failure") {
      this.finishRequest(correlationId, undefined, err.transportError("Central task failed", {
        payload: message.payload,
      }));
    }
    this.emit(message.type, message.payload);
  }

  private handleStateChange(state: ConnectionState): void {
    this.emit("connection.state", state);
    if (
      this.desiredConnection
      && this.config?.autoReconnect !== false
      && (state === "disconnected" || state === "error")
    ) {
      this.scheduleReconnect();
    } else if (state === "connected") {
      this.clearReconnectTimer();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || !this.config) return;
    const delay = this.config.reconnectDelayMs ?? 1_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.desiredConnection || !this.config) return;
      void this.transport.connect(this.config).catch((error: unknown) => {
        this.emit("connection.error", error);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private envelope(
    type: "client.status" | "task.request" | "task.cancel",
    payload: unknown,
    correlationId?: string,
  ): CoreMessageEnvelope {
    return createEnvelope(type, payload, {
      id: this.createId(),
      clientId: this.config?.clientId,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  private finishRequest(taskId: string, value?: AXIONTaskResponse, error?: unknown): void {
    const pending = this.pending.get(taskId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(taskId);
    if (error !== undefined) pending.reject(error);
    else if (value !== undefined) pending.resolve(value);
    else pending.reject(err.transportError("Task request completed without a response", { taskId }));
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  private ensureConnected(): void {
    if (this.transport.getState() !== "connected") throw err.transportDisconnected();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTaskResponse(value: unknown, expectedTaskId: string): AXIONTaskResponse {
  if (!isRecord(value) || value["taskId"] !== expectedTaskId) {
    throw err.transportError("Central returned a malformed task response", { taskId: expectedTaskId });
  }
  const status = value["status"];
  if (
    status !== "accepted"
    && status !== "assigned"
    && status !== "matched"
    && status !== "no_match"
    && status !== "completed"
  ) {
    throw err.transportError("Central returned an unsupported task response status", {
      taskId: expectedTaskId,
      status,
    });
  }
  const response: AXIONTaskResponse = { taskId: expectedTaskId, status };
  if ("data" in value) response.data = value["data"];
  return response;
}
