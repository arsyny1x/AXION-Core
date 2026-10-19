/**
 * Core.client — client identity and lifecycle.
 *
 * The client registration flow:
 *   1. Validate options.
 *   2. Ensure the transport is connected.
 *   3. Send `client.register` and (in the real system) await an ack from the
 *      Central Core. The mock transport does not reply, so registration
 *      resolves locally once the message is sent.
 */

import { err } from "../errors";
import {
  CLIENT_STATES,
  CONNECTION_STATES,
  type ClientInfo,
  type ClientRegisterOptions,
  type ConnectionState,
  type IClientApi,
} from "../types";
import {
  assertObject,
  assertOneOf,
  assertString,
  assertStringArray,
} from "../validation/validators";
import { createEnvelope, type ICoreTransport } from "../transport/ICoreTransport";
import type { EventBus } from "./events";

export interface ClientApiDeps {
  transport: ICoreTransport;
  events: EventBus;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  now: () => number;
  uuid: () => string;
  /** Optional timeout for connect/register round-trips. */
  registerTimeoutMs?: number;
}

const DEFAULT_TIMEOUT = 15_000;

export function createClientApi(deps: ClientApiDeps): IClientApi {
  let id: string | null = null;
  let name: string | null = null;
  let capabilities: string[] = [];
  let metadata: Record<string, unknown> = {};
  let registeredAt: number | null = null;

  function info(): ClientInfo {
    return {
      id,
      name,
      capabilities: [...capabilities],
      metadata: { ...metadata },
      connectionState: deps.transport.getState(),
      registeredAt,
    };
  }

  return {
    async register(options: ClientRegisterOptions): Promise<ClientInfo> {
      if (id !== null) throw err.alreadyRegistered();
      const opts = validateRegisterOptions(options);
      ensureConnected(deps.transport);

      const envelope = createEnvelope("client.register", opts, {
        id: deps.uuid(),
        clientId: opts.metadata?.["clientId"] as string | undefined,
      });

      const timeoutMs = deps.registerTimeoutMs ?? DEFAULT_TIMEOUT;
      await withTimeout(deps.transport.send(envelope), timeoutMs, "client.register");

      id = (opts.metadata?.["clientId"] as string | undefined) ?? deps.uuid();
      name = opts.name;
      capabilities = opts.capabilities ?? [];
      metadata = opts.metadata ?? {};
      registeredAt = deps.now();

      deps.log.info(`Client registered: ${name} (${id})`);
      deps.events.dispatch("client.registered", {
        clientId: id,
        name,
        capabilities: [...capabilities],
        registeredAt,
      });
      return info();
    },

    async unregister(): Promise<void> {
      if (id === null) return;
      ensureConnected(deps.transport);
      const envelope = createEnvelope("client.unregister", { clientId: id }, {
        id: deps.uuid(),
        clientId: id,
      });
      await withTimeout(deps.transport.send(envelope), DEFAULT_TIMEOUT, "client.unregister");
      deps.log.info(`Client unregistered: ${id}`);
      id = null;
      name = null;
      capabilities = [];
      metadata = {};
      registeredAt = null;
    },

    getId: () => id,
    getInfo: info,
    getConnectionState: () => assertConnectionState(deps.transport.getState()),
    getCapabilities: () => [...capabilities],
    updateMetadata(next: Record<string, unknown>): void {
      assertObject(next, "metadata");
      metadata = { ...metadata, ...next };
    },
  };
}

function validateRegisterOptions(value: unknown): ClientRegisterOptions {
  const obj = assertObject(value, "options");
  const name = assertString(obj["name"], "name");
  const capabilities = obj["capabilities"] === undefined
    ? undefined
    : assertStringArray(obj["capabilities"], "capabilities");
  const metadata = obj["metadata"] === undefined
    ? undefined
    : assertObject(obj["metadata"], "metadata");
  const out: ClientRegisterOptions = { name };
  if (capabilities) out.capabilities = capabilities;
  if (metadata) out.metadata = metadata;
  return out;
}

function ensureConnected(transport: ICoreTransport): void {
  const state = transport.getState();
  if (state !== "connected") throw err.transportDisconnected(`Transport state is "${state}"`);
}

function assertConnectionState(state: ConnectionState): ConnectionState {
  return assertOneOf(state, CONNECTION_STATES, "connectionState");
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0 || !Number.isFinite(ms)) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(err.timeout(`Timeout after ${ms}ms during ${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Silence unused import warning while preserving intent for future use.
void CLIENT_STATES;