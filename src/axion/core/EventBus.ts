import type { EventPublisher } from "./contracts";
import { AXIONAggregateError } from "./errors";

export class EventBus implements EventPublisher {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(eventName: string, callback: (payload: unknown) => void): () => void {
    if (!eventName.trim()) throw new Error("eventName must be a non-empty string");
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(callback);
    this.listeners.set(eventName, listeners);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.listeners.delete(eventName);
    };
  }

  emit(eventName: string, payload?: unknown): void {
    const listeners = this.listeners.get(eventName);
    if (!listeners) return;
    const errors: unknown[] = [];
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AXIONAggregateError(errors, `One or more listeners failed for "${eventName}"`);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
