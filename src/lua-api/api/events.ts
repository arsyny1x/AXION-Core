/**
 * Core.events — per-scope event subscription system.
 *
 * Design:
 *  - Standard Core events (CORE_EVENTS) are emitted only by the module itself
 *    in response to transport messages. Scripts may not `emit` them.
 *  - Scripts may `emit` free-form local events (must not collide with core
 *    event names) to coordinate internal logic.
 *  - Duplicate listeners (same callback + same event) are rejected so scripts
 *    cannot accidentally register the same handler twice.
 *  - `off` returns nothing; `on`/`once` return an unsubscribe function.
 */

import { err } from "../errors";
import { CORE_EVENTS, type EventCallback, type IEventsApi } from "../types";

interface ListenerRecord {
  callback: EventCallback;
  once: boolean;
}

export class EventBus implements IEventsApi {
  private readonly listeners = new Map<string, ListenerRecord[]>();
  private readonly localEventNames = new Set<string>();

  on(eventName: string, callback: EventCallback): () => void {
    const name = this.assertEventName(eventName, /* allowCore */ true, /* allowCustom */ true);
    const cb = this.assertCallback(callback);
    const list = this.listeners.get(name) ?? [];
    if (list.some((r) => r.callback === cb)) {
      throw err.invalidArgument(`Listener already registered for event "${name}"`, {
        event: name,
      });
    }
    list.push({ callback: cb, once: false });
    this.listeners.set(name, list);
    if (!this.isCoreEvent(name)) this.localEventNames.add(name);
    return () => this.off(name, cb);
  }

  once(eventName: string, callback: EventCallback): () => void {
    const name = this.assertEventName(eventName, true, true);
    const cb = this.assertCallback(callback);
    const list = this.listeners.get(name) ?? [];
    if (list.some((r) => r.callback === cb)) {
      throw err.invalidArgument(`Listener already registered for event "${name}"`, {
        event: name,
      });
    }
    list.push({ callback: cb, once: true });
    this.listeners.set(name, list);
    if (!this.isCoreEvent(name)) this.localEventNames.add(name);
    return () => this.off(name, cb);
  }

  off(eventName: string, callback: EventCallback): void {
    const name = this.assertEventName(eventName, true, true);
    const cb = this.assertCallback(callback);
    const list = this.listeners.get(name);
    if (!list) return;
    const next = list.filter((r) => r.callback !== cb);
    if (next.length === 0) this.listeners.delete(name);
    else this.listeners.set(name, next);
  }

  emit(eventName: string, payload?: unknown): void {
    const name = this.assertEventName(eventName, /* allowCore */ false, /* allowCustom */ true);
    this.dispatch(name, payload);
  }

  /** Internal dispatch — used by the module to fire core events. */
  dispatch(eventName: string, payload: unknown): void {
    const list = this.listeners.get(eventName);
    if (!list || list.length === 0) return;
    // Snapshot to make mutation during dispatch safe.
    const snapshot = [...list];
    for (const record of snapshot) {
      try {
        record.callback(payload);
      } catch (error) {
        // Do not swallow — report through the module's error channel via the
        // caller's logger. We re-throw asynchronously so other listeners run.
        queueMicrotask(() => {
          throw error;
        });
      }
      if (record.once) {
        const current = this.listeners.get(eventName);
        if (current) {
          const next = current.filter((r) => r !== record);
          if (next.length === 0) this.listeners.delete(eventName);
          else this.listeners.set(eventName, next);
        }
      }
    }
  }

  getAvailableEvents(): string[] {
    const custom = new Set<string>();
    for (const name of this.listeners.keys()) {
      if (!this.isCoreEvent(name)) custom.add(name);
    }
    for (const name of this.localEventNames) custom.add(name);
    return [...CORE_EVENTS, ...custom];
  }

  /** Remove every listener. Used when a script stops. */
  clear(): void {
    this.listeners.clear();
    this.localEventNames.clear();
  }

  private assertEventName(name: string, allowCore: boolean, allowCustom: boolean): string {
    if (typeof name !== "string" || name.length === 0) {
      throw err.invalidArgument("eventName must be a non-empty string");
    }
    if (this.isCoreEvent(name)) {
      if (!allowCore) {
        throw err.invalidArgument(`"${name}" is a reserved core event and cannot be emitted`, {
          event: name,
        });
      }
      return name;
    }
    if (!allowCustom) {
      throw err.invalidArgument(`"${name}" is not a registered event`);
    }
    return name;
  }

  private isCoreEvent(name: string): name is (typeof CORE_EVENTS)[number] {
    return (CORE_EVENTS as readonly string[]).includes(name);
  }

  private assertCallback(cb: unknown): EventCallback {
    if (typeof cb !== "function") {
      throw err.invalidArgument("callback must be a function");
    }
    return cb as EventCallback;
  }
}

export function createEventsApi(): EventBus {
  return new EventBus();
}