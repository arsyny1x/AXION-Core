/**
 * ScriptManager — lifecycle owner for user-provided Lua scripts.
 *
 * Responsibilities:
 *  - Track script metadata (id, name, version, enabled, runtime state, ...).
 *  - Drive the injected `ILuaRuntime` through load/execute/stop/unload.
 *  - Isolate per-script state by building a fresh `Core` scope per script.
 *  - Emit `script.*` lifecycle events and clean up on stop.
 *
 * Non-responsibilities (explicitly out of scope):
 *  - Persistence / script database.
 *  - A script editor UI.
 *  - Real Lua execution (delegated to the runtime adapter).
 */

import { err } from "../errors";
import type { EventBus } from "../api/events";
import type { CoreGlobal } from "../types";
import type { ILuaRuntime } from "../runtime/ILuaRuntime";
import type { IScriptManager, ScriptDescriptor, ScriptRecord } from "./ScriptTypes";
import { assertObject, assertString } from "../validation/validators";

export interface ScriptManagerOptions {
  runtime: ILuaRuntime;
  events: EventBus;
  log: {
  info: (m: string, meta?: Record<string, unknown>) => void;
  warn: (m: string, meta?: Record<string, unknown>) => void;
  error: (m: string, meta?: Record<string, unknown>) => void;
};
  createCoreScope: (scriptId: string) => CoreGlobal;
  /** Cleanup hook called when a script is unloaded (drops listeners, buffers, ...). */
  onScriptUnloaded?: (scriptId: string) => void;
}

export function createScriptManager(options: ScriptManagerOptions): IScriptManager {
  const scripts = new Map<string, ScriptRecord>();

  function toRecord(desc: ScriptDescriptor): ScriptRecord {
    return {
      id: desc.id,
      name: desc.name,
      source: desc.source,
      version: desc.version ?? "0.0.0",
      enabled: desc.enabled ?? true,
      runtimeState: "ready",
      lastExecutionAt: null,
      lastError: null,
      metadata: desc.metadata ? { ...desc.metadata } : {},
    };
  }

  function requireRecord(scriptId: string): ScriptRecord {
    const record = scripts.get(scriptId);
    if (!record) throw err.scriptNotFound(scriptId);
    return record;
  }

  return {
    async load(descriptor: ScriptDescriptor): Promise<ScriptRecord> {
      const desc = validateDescriptor(descriptor);
      if (scripts.has(desc.id)) throw err.scriptAlreadyLoaded(desc.id);

      // Register the Core global for this script (isolated when supported).
      const core = options.createCoreScope(desc.id);
      try {
        if (options.runtime.registerScriptGlobal) {
          options.runtime.registerScriptGlobal(desc.id, "Core", core);
        } else {
          options.runtime.registerGlobal("Core", core);
          options.log.warn(
            "Lua runtime does not support per-script globals; Core bindings are shared.",
          );
        }
        await options.runtime.loadScript(desc.source, {
          scriptId: desc.id,
          name: desc.name,
          version: desc.version,
          attributes: desc.metadata,
        });
      } catch (error) {
        options.onScriptUnloaded?.(desc.id);
        throw err.runtimeError(`Failed to load script "${desc.id}"`, {
          cause: String(error),
        });
      }

      const record = toRecord(desc);
      scripts.set(desc.id, record);
      options.events.dispatch("script.loaded", { scriptId: desc.id, name: desc.name });
      options.log.info(`Script loaded: ${desc.id}`, { name: desc.name, version: record.version });
      return { ...record };
    },

    async start(scriptId: string): Promise<void> {
      const record = requireRecord(scriptId);
      if (!record.enabled) {
        throw err.invalidState(`Script "${scriptId}" is disabled`);
      }
      try {
        await options.runtime.executeScript(scriptId);
        record.runtimeState = "running";
        record.lastExecutionAt = Date.now();
        record.lastError = null;
        options.events.dispatch("script.started", { scriptId });
        options.log.info(`Script started: ${scriptId}`);
      } catch (error) {
        record.runtimeState = "error";
        record.lastError = error instanceof Error ? error.message : String(error);
        options.events.dispatch("script.error", { scriptId, error: record.lastError });
        throw error;
      }
    },

    async stop(scriptId: string): Promise<void> {
      const record = requireRecord(scriptId);
      await options.runtime.stopScript(scriptId);
      record.runtimeState = "stopped";
      options.onScriptUnloaded?.(scriptId);
      options.events.dispatch("script.stopped", { scriptId });
      options.log.info(`Script stopped: ${scriptId}`);
    },

    async reload(scriptId: string, source?: string): Promise<void> {
      const record = requireRecord(scriptId);
      const newSource = source ?? record.source;
      assertString(newSource, "source", { allowEmpty: true });
      try {
        await options.runtime.stopScript(scriptId);
      } catch {
        // Not fatal — a stopped/never-started script may not be stoppable.
      }
      try {
        await options.runtime.unloadScript(scriptId);
      } catch {
        // Not fatal — script may not be loaded in the runtime yet.
      }

      // Re-register the per-script Core scope after reload.
      options.onScriptUnloaded?.(scriptId);
      const core = options.createCoreScope(scriptId);
      if (options.runtime.registerScriptGlobal) {
        options.runtime.registerScriptGlobal(scriptId, "Core", core);
      } else {
        options.runtime.registerGlobal("Core", core);
      }

      await options.runtime.loadScript(newSource, {
        scriptId,
        name: record.name,
        version: record.version,
        attributes: record.metadata,
      });
      record.source = newSource;
      record.runtimeState = "ready";
      record.lastError = null;
      options.events.dispatch("script.reloaded", { scriptId });
      options.log.info(`Script reloaded: ${scriptId}`);
    },

    async unload(scriptId: string): Promise<void> {
      requireRecord(scriptId);
      try {
        await options.runtime.stopScript(scriptId);
      } catch {
        /* tolerated */
      }
      try {
        await options.runtime.unloadScript(scriptId);
      } catch {
        /* tolerated */
      }
      options.onScriptUnloaded?.(scriptId);
      scripts.delete(scriptId);
      options.log.info(`Script unloaded: ${scriptId}`);
    },

    get(scriptId: string): ScriptRecord | null {
      const record = scripts.get(scriptId);
      return record ? { ...record } : null;
    },

    list(): ScriptRecord[] {
      return [...scripts.values()].map((r) => ({ ...r }));
    },

    async dispose(): Promise<void> {
      for (const id of [...scripts.keys()]) {
        try {
          await this.unload(id);
        } catch (error) {
          options.log.error(`Failed to unload script "${id}" during dispose: ${String(error)}`);
        }
      }
      scripts.clear();
    },
  };
}

function validateDescriptor(value: unknown): ScriptDescriptor {
  const obj = assertObject(value, "descriptor");
  const id = assertString(obj["id"], "id");
  const name = assertString(obj["name"], "name");
  const source = assertString(obj["source"], "source", { allowEmpty: true });
  const version = obj["version"] === undefined ? undefined : assertString(obj["version"], "version");
  const enabled = obj["enabled"] === undefined ? undefined : (obj["enabled"] as boolean);
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw err.invalidArgument("enabled must be a boolean");
  }
  const metadata = obj["metadata"] === undefined
    ? undefined
    : (assertObject(obj["metadata"], "metadata") as Record<string, unknown>);
  const out: ScriptDescriptor = { id, name, source };
  if (version !== undefined) out.version = version;
  if (enabled !== undefined) out.enabled = enabled;
  if (metadata !== undefined) out.metadata = metadata;
  return out;
}