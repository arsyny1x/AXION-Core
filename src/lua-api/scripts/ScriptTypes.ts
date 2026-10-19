/**
 * Script lifecycle types.
 */

import type { LuaRuntimeState } from "../runtime/ILuaRuntime";

export interface ScriptDescriptor {
  id: string;
  name: string;
  source: string;
  version?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ScriptRecord {
  id: string;
  name: string;
  source: string;
  version: string;
  enabled: boolean;
  runtimeState: LuaRuntimeState;
  lastExecutionAt: number | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
}

export interface IScriptManager {
  load(descriptor: ScriptDescriptor): Promise<ScriptRecord>;
  start(scriptId: string): Promise<void>;
  stop(scriptId: string): Promise<void>;
  reload(scriptId: string, source?: string): Promise<void>;
  unload(scriptId: string): Promise<void>;
  get(scriptId: string): ScriptRecord | null;
  list(): ScriptRecord[];
  dispose(): Promise<void>;
}