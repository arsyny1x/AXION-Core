/**
 * Mock Lua runtime used for integration tests only.
 *
 * IMPORTANT: This class does NOT execute Lua code. It records scripts and
 * globals so the module's contracts can be exercised without a real
 * interpreter. Any test that relies on it must not claim to verify Lua
 * semantics — only the surrounding TypeScript plumbing.
 */

import { err } from "../errors";
import type {
  ILuaRuntime,
  LuaRuntimeInitializeOptions,
  LuaRuntimeState,
  LuaScriptMetadata,
} from "./ILuaRuntime";

interface MockScriptRecord {
  scriptId: string;
  source: string;
  metadata: LuaScriptMetadata;
  loadedAt: number;
  executionCount: number;
  state: LuaRuntimeState;
}

export class MockLuaRuntime implements ILuaRuntime {
  private state: LuaRuntimeState = "uninitialized";
  private readonly scripts = new Map<string, MockScriptRecord>();
  private readonly globals = new Map<string, unknown>();
  private readonly scriptGlobals = new Map<string, Map<string, unknown>>();
  private nextId = 1;

  async initialize(_options: LuaRuntimeInitializeOptions = {}): Promise<void> {
    if (this.state === "disposed") {
      throw err.runtimeError("Runtime has been disposed");
    }
    this.state = "ready";
  }

  async loadScript(source: string, metadata: LuaScriptMetadata): Promise<string> {
    this.assertReady();
    if (typeof source !== "string") {
      throw err.invalidArgument("source must be a string");
    }
    const scriptId = metadata.scriptId || `mock-script-${this.nextId++}`;
    if (this.scripts.has(scriptId)) {
      throw err.scriptAlreadyLoaded(scriptId);
    }
    this.scripts.set(scriptId, {
      scriptId,
      source,
      metadata,
      loadedAt: Date.now(),
      executionCount: 0,
      state: "ready",
    });
    return scriptId;
  }

  async executeScript(scriptId: string): Promise<void> {
    this.assertReady();
    const record = this.scripts.get(scriptId);
    if (!record) throw err.scriptNotFound(scriptId);
    record.executionCount += 1;
    record.state = "running";
    this.state = "running";
    // NOTE: No Lua bytecode is executed here. This is a contract-level mock.
  }

  async stopScript(scriptId: string): Promise<void> {
    const record = this.scripts.get(scriptId);
    if (!record) throw err.scriptNotFound(scriptId);
    record.state = "stopped";
    this.state = "stopped";
  }

  async unloadScript(scriptId: string): Promise<void> {
    if (!this.scripts.delete(scriptId)) {
      throw err.scriptNotFound(scriptId);
    }
    this.scriptGlobals.delete(scriptId);
  }

  registerGlobal(name: string, value: unknown): void {
    this.globals.set(name, value);
  }

  registerScriptGlobal(scriptId: string, name: string, value: unknown): void {
    let map = this.scriptGlobals.get(scriptId);
    if (!map) {
      map = new Map();
      this.scriptGlobals.set(scriptId, map);
    }
    map.set(name, value);
  }

  getState(): LuaRuntimeState {
    return this.state;
  }

  async dispose(): Promise<void> {
    this.scripts.clear();
    this.globals.clear();
    this.scriptGlobals.clear();
    this.state = "disposed";
  }

  // ---------------------------------------------------------------------------
  // Test inspection helpers
  // ---------------------------------------------------------------------------

  getGlobal(name: string): unknown {
    return this.globals.get(name);
  }

  getScriptGlobal(scriptId: string, name: string): unknown {
    return this.scriptGlobals.get(scriptId)?.get(name);
  }

  getScriptRecord(scriptId: string): MockScriptRecord | undefined {
    return this.scripts.get(scriptId);
  }

  private assertReady(): void {
    if (this.state === "disposed") {
      throw err.runtimeError("Runtime has been disposed");
    }
    if (this.state === "uninitialized") {
      throw err.runtimeNotReady("Runtime has not been initialized");
    }
  }
}