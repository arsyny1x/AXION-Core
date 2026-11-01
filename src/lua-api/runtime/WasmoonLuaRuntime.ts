import type { LuaEngine, LuaFactory } from "wasmoon";
import type {
  ILuaRuntime,
  LuaRuntimeInitializeOptions,
  LuaRuntimeState,
  LuaScriptMetadata,
} from "./ILuaRuntime";

export class WasmoonLuaRuntime implements ILuaRuntime {
  private factory: Promise<LuaFactory> | null = null;
  private engines = new Map<string, LuaEngine>();
  private state: LuaRuntimeState = "uninitialized";
  private globals = new Map<string, unknown>();
  private scriptGlobals = new Map<string, Map<string, unknown>>();
  private defaultTimeoutMs = 5000;

  async initialize(options: LuaRuntimeInitializeOptions = {}): Promise<void> {
    this.state = "ready";
    if (options.defaultTimeoutMs) this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  async loadScript(source: string, metadata: LuaScriptMetadata): Promise<string> {
    if (this.state === "disposed") throw new Error("Runtime disposed");
    if (this.engines.has(metadata.scriptId)) {
      throw new Error(`Script "${metadata.scriptId}" is already loaded`);
    }

    let engine: LuaEngine | undefined;
    try {
      const factory = await this.getFactory();
      engine = await factory.createEngine({ functionTimeout: this.defaultTimeoutMs });
      for (const [name, value] of this.globals) engine.global.set(name, value);

      const perScript = this.scriptGlobals.get(metadata.scriptId) ?? new Map<string, unknown>();
      for (const [name, value] of perScript) engine.global.set(name, value);

      engine.global.set("__source", source);
      await engine.doString(`__loaded = load(__source, "${metadata.scriptId}")`);
      this.scriptGlobals.set(metadata.scriptId, perScript);
      this.engines.set(metadata.scriptId, engine);
    } catch (error) {
      engine?.global.close();
      this.scriptGlobals.delete(metadata.scriptId);
      throw error;
    }
    return metadata.scriptId;
  }

  async executeScript(scriptId: string): Promise<void> {
    const engine = this.engines.get(scriptId);
    if (!engine) throw new Error(`Script "${scriptId}" not loaded`);
    this.state = "running";

    // Apply per-script globals before running
    const perScript = this.scriptGlobals.get(scriptId);
    if (perScript) for (const [k, v] of perScript) engine.global.set(k, v);

    try {
      const loadedScript = engine.global.get("__loaded");
      if (typeof loadedScript !== "function") {
        throw new Error(`Script "${scriptId}" has no executable chunk`);
      }
      await loadedScript();
    } catch (error) {
      if (error instanceof Error && error.message.includes("thread timeout exceeded")) {
        await this.stopScript(scriptId);
        throw new Error(`Script "${scriptId}" timed out: ${error.message}`);
      }
      throw error;
    }
  }

  async stopScript(scriptId: string): Promise<void> {
    const engine = this.engines.get(scriptId);
    if (!engine) return;
    try {
      engine.global.close();
    } finally {
      this.engines.delete(scriptId);
      this.scriptGlobals.delete(scriptId);
      this.state = "stopped";
    }
  }

  async unloadScript(scriptId: string): Promise<void> {
    await this.stopScript(scriptId);
  }

  registerGlobal(name: string, value: unknown): void {
    this.globals.set(name, value);
    for (const engine of this.engines.values()) engine.global.set(name, value);
  }

  registerScriptGlobal(scriptId: string, name: string, value: unknown): void {
    let map = this.scriptGlobals.get(scriptId);
    if (!map) {
      map = new Map();
      this.scriptGlobals.set(scriptId, map);
    }
    map.set(name, value);
    const engine = this.engines.get(scriptId);
    if (engine) engine.global.set(name, value);
  }

  getState(): LuaRuntimeState {
    return this.state;
  }

  private getFactory(): Promise<LuaFactory> {
    if (!this.factory) {
      this.factory = import("wasmoon").then(({ LuaFactory }) => new LuaFactory());
    }
    return this.factory;
  }

  async dispose(): Promise<void> {
    let closeFailed = false;
    let firstCloseError: unknown;
    for (const engine of this.engines.values()) {
      try {
        engine.global.close();
      } catch (error) {
        if (!closeFailed) firstCloseError = error;
        closeFailed = true;
      }
    }
    this.engines.clear();
    this.globals.clear();
    this.scriptGlobals.clear();
    this.state = "disposed";
    if (closeFailed) throw firstCloseError;
  }
}