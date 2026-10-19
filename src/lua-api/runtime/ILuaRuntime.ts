/**
 * Lua runtime adapter boundary.
 *
 * The module does NOT ship a real Lua interpreter. This interface defines the
 * contract a real adapter (WASM, native binding, child process, etc.) must
 * implement so the public `Core.*` API stays stable.
 *
 * Adapters are responsible for the actual sandboxing guarantees listed in
 * section 9 of the task brief (time limits, memory limits, restricted
 * filesystem/OS access). TypeScript cannot enforce those on its own.
 */

export type LuaRuntimeState =
  | "uninitialized"
  | "ready"
  | "running"
  | "stopped"
  | "error"
  | "disposed";

export const LUA_RUNTIME_STATES: readonly LuaRuntimeState[] = [
  "uninitialized",
  "ready",
  "running",
  "stopped",
  "error",
  "disposed",
] as const;

export interface LuaRuntimeInitializeOptions {
  /** Hard cap for script execution time (ms). Adapter-enforced when possible. */
  defaultTimeoutMs?: number;
  /** Soft memory cap (bytes) for the interpreter. Adapter-enforced when possible. */
  memoryLimitBytes?: number;
  /** When true, the adapter should expose only a whitelisted standard library. */
  sandboxed?: boolean;
}

export interface LuaScriptMetadata {
  scriptId: string;
  name: string;
  version?: string;
  /** Arbitrary metadata recorded alongside the script. */
  attributes?: Record<string, unknown>;
}

export interface ILuaRuntime {
  initialize(options?: LuaRuntimeInitializeOptions): Promise<void>;
  loadScript(source: string, metadata: LuaScriptMetadata): Promise<string>;
  executeScript(scriptId: string): Promise<void>;
  stopScript(scriptId: string): Promise<void>;
  unloadScript(scriptId: string): Promise<void>;
  /**
   * Register a global binding visible to all scripts.
   * Used for shared, non-isolated bindings (e.g. shared helpers).
   */
  registerGlobal(name: string, value: unknown): void;
  /**
   * Optional: register a global binding visible only to a single script.
   * Adapters that support per-script environments should implement this to
   * guarantee isolation of `Core.events`, `Core.config`, `Core.log`, and
   * `Core.custom` between scripts. When omitted, the ScriptManager falls back
   * to `registerGlobal` and logs a warning.
   */
  registerScriptGlobal?(scriptId: string, name: string, value: unknown): void;
  getState(): LuaRuntimeState;
  dispose(): Promise<void>;
}