import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LuaFactory, type LuaEngine } from "wasmoon";
import { writeLog } from "./logService";
import { indexInventory, searchInventoryItems, type SearchableInventoryItem } from "./serverInventorySearch";

const TOKEN_STORAGE_KEY = "axion.server-scripts.token.v1";
const LEGACY_TOKEN_STORAGE_KEY = "autohub.server-scripts.token.v1";
const SCRIPT_STORAGE_KEY = "axion.server-scripts.v1";
const LEGACY_SCRIPT_STORAGE_KEY = "autohub.server-scripts.v1";
const MAX_SCRIPT_RESULT_BYTES = 16 * 1024;
const MAX_SCRIPT_SOURCE_BYTES = 64 * 1024;
const MAX_EXPORTED_FUNCTIONS = 64;
const serverScriptFactory = new LuaFactory();

export interface ServerScript {
  id: string;
  name: string;
  source: string;
  customGameId: string;
}

export interface InventoryItem {
  name: string;
  quantity: number;
  itemId?: string | null;
  category: string;
  value?: string | number | boolean;
}

export interface InventorySnapshot {
  playerId: string;
  accountId: string;
  customGameId: string;
  agentId: string;
  agentName: string;
  categories?: string[];
  items: InventoryItem[];
  updatedAt: number;
  online: boolean;
}

interface ScriptInvocation {
  requestId: string;
  function: string;
  customGameId: string;
  args: unknown;
}

interface AgentIdentity {
  id: string;
}

interface ScriptRuntime {
  engine: LuaEngine;
  functions: Record<string, (...args: unknown[]) => unknown>;
  source: string;
}

const inventoryByAgent = new Map<string, InventorySnapshot>();
const inventorySearchIndex = new Map<string, Map<string, SearchableInventoryItem[]>>();
const connectedAgents = new Set<string>();
const runtimesByScript = new Map<string, ScriptRuntime>();
const functionsByName = new Map<string, (...args: unknown[]) => unknown>();
const inventoryListeners = new Set<(snapshots: InventorySnapshot[]) => void>();
const eventUnlisteners: Array<() => void> = [];
let initializePromise: Promise<void> | null = null;
let savedScriptsPromise: Promise<{ scripts: ServerScript[]; errors: string[] }> | null = null;
let savedScriptsReloadPromise: Promise<{ scripts: ServerScript[]; errors: string[] }> | null = null;

function inventoryKey(snapshot: Pick<InventorySnapshot, "customGameId" | "accountId">): string {
  return `${snapshot.customGameId}/${snapshot.accountId}`;
}

function scriptScopeKey(customGameId: string, scriptId: string): string {
  return `${customGameId}/${scriptId}`;
}

function functionScopeKey(customGameId: string, functionName: string): string {
  return `${customGameId}/${functionName}`;
}

function emitInventories(): void {
  const snapshots = getInventorySnapshot();
  for (const listener of inventoryListeners) listener(snapshots);
}

function setInventorySearchIndex(key: string, snapshot: InventorySnapshot): void {
  let gameIndex = inventorySearchIndex.get(snapshot.customGameId);
  if (!gameIndex) {
    gameIndex = new Map();
    inventorySearchIndex.set(snapshot.customGameId, gameIndex);
  }
  gameIndex.set(key, indexInventory(snapshot));
}

function getApiToken(): string {
  const saved = localStorage.getItem(TOKEN_STORAGE_KEY) ?? localStorage.getItem(LEGACY_TOKEN_STORAGE_KEY);
  if (saved && !localStorage.getItem(TOKEN_STORAGE_KEY)) localStorage.setItem(TOKEN_STORAGE_KEY, saved);
  if (saved) return saved;

  const bytes = new Uint8Array(32);
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random token generation is not available");
  }
  globalThis.crypto.getRandomValues(bytes);
  const token = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  return token;
}

function updateInventory(snapshot: InventorySnapshot) {
  const updated = {
    ...snapshot,
    online: connectedAgents.has(snapshot.agentId),
  };
  const key = inventoryKey(updated);
  inventoryByAgent.set(key, updated);
  setInventorySearchIndex(key, updated);
  emitInventories();
}

export function replaceInventorySnapshot(snapshot: InventorySnapshot): void {
  updateInventory(snapshot);
}

export function removeInventorySnapshot(customGameId: string, accountId: string): void {
  const key = inventoryKey({ customGameId, accountId });
  inventoryByAgent.delete(key);
  inventorySearchIndex.get(customGameId)?.delete(key);
  if (inventorySearchIndex.get(customGameId)?.size === 0) {
    inventorySearchIndex.delete(customGameId);
  }
  emitInventories();
}

function collectInventoryItems(
  customGameId: string,
  options: { query?: string; includeOffline: boolean; agentId?: string; onlineOnly?: boolean },
) {
  return searchInventoryItems(
    inventorySearchIndex.get(customGameId)?.values() ?? [],
    customGameId,
    connectedAgents,
    options,
  );
}

function buildServerApi(customGameId: string) {
  return {
    Game: { customGameId },
    Items: {
      search(query: unknown, includeOffline: unknown = false) {
        if (typeof query !== "string") {
          throw new Error("Server.Items.search expects a text query");
        }
        const normalizedQuery = query.trim();
        if (!normalizedQuery) return [];
        return collectInventoryItems(customGameId, {
          query: normalizedQuery,
          includeOffline: includeOffline === true,
        });
      },
      getOnline(agentId?: unknown) {
        if (agentId != null && typeof agentId !== "string") {
          throw new Error("Server.Items.getOnline expects an optional Agent ID");
        }
        return collectInventoryItems(customGameId, {
          includeOffline: false,
          onlineOnly: true,
          ...(typeof agentId === "string" ? { agentId } : {}),
        });
      },
    },
    Players: {
      isOnline(playerId: unknown) {
        return typeof playerId === "string" &&
          connectedAgents.has(playerId) &&
          [...inventoryByAgent.values()].some(
            inventory => inventory.customGameId === customGameId && inventory.agentId === playerId,
          );
      },
    },
  };
}

async function sendInvocationResponse(
  requestId: string,
  result: unknown,
  error: string | null,
): Promise<void> {
  await invoke("axion_server_script_respond", {
    requestId,
    result: result ?? null,
    error,
  });
}

async function handleInvocation(invocation: ScriptInvocation): Promise<void> {
  const source = `server-script:${invocation.customGameId}/${invocation.function}`;
  writeLog("info", source, `Invocation started (${invocation.requestId})`);
  try {
    const key = functionScopeKey(invocation.customGameId, invocation.function);
    let scriptFunction = functionsByName.get(key);
    if (!scriptFunction) {
      const { errors } = await reloadSavedServerScripts();
      scriptFunction = functionsByName.get(key);
      if (!scriptFunction) {
        const scopePrefix = `${invocation.customGameId}/`;
        const exports = [...functionsByName.keys()]
          .filter(functionKey => functionKey.startsWith(scopePrefix))
          .map(functionKey => functionKey.slice(scopePrefix.length))
          .sort();
        const loadedScopes = [...new Set(
          [...functionsByName.keys()].map(functionKey => functionKey.slice(0, functionKey.indexOf("/"))),
        )].sort();
        const details = [
          `Server Script function "${invocation.function}" was not found in scope "${invocation.customGameId}"`,
          `loaded exports in that scope: ${exports.length > 0 ? exports.join(", ") : "none"}`,
          `loaded scopes: ${loadedScopes.length > 0 ? loadedScopes.join(", ") : "none"}`,
          errors.length > 0 ? `script load errors: ${errors.join("; ")}` : "",
        ].filter(Boolean).join("; ");
        throw new Error(details);
      }
    }
    const result = await scriptFunction(invocation.args ?? {});
    const serialized = JSON.stringify(result ?? null);
    if (serialized === undefined) {
      throw new Error("Server Script result must be JSON serializable");
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_SCRIPT_RESULT_BYTES) {
      throw new Error("Server Script result exceeds the 16 KiB limit");
    }
    await sendInvocationResponse(invocation.requestId, JSON.parse(serialized) as unknown, null);
    writeLog("ok", source, `Invocation completed (${invocation.requestId})`);
  } catch (error) {
    writeLog("error", source, `Invocation failed (${invocation.requestId}): ${error instanceof Error ? error.message : String(error)}`);
    await sendInvocationResponse(
      invocation.requestId,
      null,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function initializeServerScripts(): Promise<void> {
  if (!isTauri()) {
    return Promise.reject(new Error("Server Scripts native features require AXION Core Desktop."));
  }
  if (initializePromise) return initializePromise;

  writeLog("info", "server-scripts", "Initializing Server Scripts API");
  initializePromise = (async () => {
    const registerEvents = async () => {
      eventUnlisteners.push(await listen<ScriptInvocation>("axion-server-script-invoke", event => {
          void handleInvocation(event.payload).catch(error => {
            console.error("Could not return the Server Script response", error);
          });
        }));
      eventUnlisteners.push(await listen<InventorySnapshot>("axion-item-cache-updated", event => {
        updateInventory(event.payload);
      }));
      eventUnlisteners.push(await listen<{ playerId: string }>("axion-item-cache-offline", event => {
        connectedAgents.delete(event.payload.playerId);
        for (const snapshot of inventoryByAgent.values()) {
          if (snapshot.agentId === event.payload.playerId) {
            inventoryByAgent.set(inventoryKey(snapshot), { ...snapshot, online: false });
          }
        }
        emitInventories();
      }));
      eventUnlisteners.push(await listen<AgentIdentity>("axion-agent-connected", event => {
        connectedAgents.add(event.payload.id);
        for (const snapshot of inventoryByAgent.values()) {
          if (snapshot.agentId === event.payload.id) {
            inventoryByAgent.set(inventoryKey(snapshot), { ...snapshot, online: true });
          }
        }
        emitInventories();
      }));
      eventUnlisteners.push(await listen<{ id: string }>("axion-agent-disconnected", event => {
        connectedAgents.delete(event.payload.id);
        for (const snapshot of inventoryByAgent.values()) {
          if (snapshot.agentId === event.payload.id) {
            inventoryByAgent.set(inventoryKey(snapshot), { ...snapshot, online: false });
          }
        }
        emitInventories();
      }));
    };
    await registerEvents();

    await refreshInventoryCache();

    await invoke("axion_server_script_set_token", { token: getApiToken() });
    const apiStatus = await invoke<{ running: boolean; host: string; port: number; error?: string | null }>("axion_server_script_api_status");
    if (!apiStatus.running) {
      throw new Error(apiStatus.error ?? `Server Scripts API is not listening on ${apiStatus.host}:${apiStatus.port}`);
    }
    writeLog("ok", "server-scripts", `Server Scripts API listening on ${apiStatus.host}:${apiStatus.port}`);
  })().catch(error => {
    while (eventUnlisteners.length > 0) eventUnlisteners.pop()?.();
    initializePromise = null;
    writeLog("error", "server-scripts", `Server Scripts initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });

  return initializePromise;
}

export function getServerScriptApiToken(): string {
  return getApiToken();
}

export async function refreshInventoryCache(): Promise<void> {
  const [inventories, agents] = await Promise.all([
    invoke<InventorySnapshot[]>("axion_item_cache_list"),
    invoke<AgentIdentity[]>("axion_list_agents"),
  ]);
  connectedAgents.clear();
  for (const agent of agents) connectedAgents.add(agent.id);
  inventoryByAgent.clear();
  inventorySearchIndex.clear();
  for (const inventory of inventories) {
    const normalizedInventory = {
      ...inventory,
      online: connectedAgents.has(inventory.agentId),
    };
    const key = inventoryKey(normalizedInventory);
    inventoryByAgent.set(key, normalizedInventory);
    setInventorySearchIndex(key, normalizedInventory);
  }
  emitInventories();
}

function readSavedScripts(): ServerScript[] {
  const saved = localStorage.getItem(SCRIPT_STORAGE_KEY) ?? localStorage.getItem(LEGACY_SCRIPT_STORAGE_KEY);
  if (!saved) return [];
  if (!localStorage.getItem(SCRIPT_STORAGE_KEY)) localStorage.setItem(SCRIPT_STORAGE_KEY, saved);
  const parsed: unknown = JSON.parse(saved);
  if (!Array.isArray(parsed)) throw new Error("Saved Server Scripts data must be a list");
  return parsed.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.source !== "string"
    ) {
      throw new Error(`Saved Server Script ${index + 1} is invalid`);
    }
    return {
      id: entry.id,
      name: entry.name,
      source: entry.source,
      customGameId: typeof entry.customGameId === "string" ? entry.customGameId : "BLOX_FRUITS",
    };
  });
}

export function loadSavedServerScripts(): Promise<{ scripts: ServerScript[]; errors: string[] }> {
  if (savedScriptsPromise) return savedScriptsPromise;
  savedScriptsPromise = (async () => {
    await initializeServerScripts();
    const scripts = readSavedScripts();
    const errors: string[] = [];
    for (const script of scripts) {
      try {
        await loadServerScript(script);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push(`${script.name}: ${detail}`);
        writeLog("error", `server-script:${script.customGameId}/${script.id}`, `Load failed: ${detail}`);
      }
    }
    return { scripts, errors };
  })().catch(error => {
    savedScriptsPromise = null;
    throw error;
  });
  return savedScriptsPromise;
}

export function invalidateSavedServerScripts(): void {
  savedScriptsPromise = null;
}

function reloadSavedServerScripts(): Promise<{ scripts: ServerScript[]; errors: string[] }> {
  if (savedScriptsReloadPromise) return savedScriptsReloadPromise;
  savedScriptsReloadPromise = (async () => {
    if (savedScriptsPromise) await savedScriptsPromise;
    savedScriptsPromise = null;
    return loadSavedServerScripts();
  })().finally(() => {
    savedScriptsReloadPromise = null;
  });
  return savedScriptsReloadPromise;
}

export async function loadServerScript(script: ServerScript): Promise<string[]> {
  await initializeServerScripts();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(script.customGameId)) {
    throw new Error("Server Script customGameId must contain 1-64 letters, numbers, _ or -");
  }
  if (new TextEncoder().encode(script.source).byteLength > MAX_SCRIPT_SOURCE_BYTES) {
    throw new Error("Server Script source exceeds the 64 KiB limit");
  }
  const scopeKey = scriptScopeKey(script.customGameId, script.id);
  const currentRuntime = runtimesByScript.get(scopeKey);
  if (currentRuntime?.source === script.source) {
    return Object.keys(currentRuntime.functions);
  }
  const engine = await serverScriptFactory.createEngine({ functionTimeout: 4_000 });
  engine.global.set("Server", buildServerApi(script.customGameId));

  try {
    const returned = await engine.doString(script.source);
    if (!returned || typeof returned !== "object" || Array.isArray(returned)) {
      throw new Error("A Server Script must return a table of named functions");
    }
    const scriptFunctions: Record<string, (...args: unknown[]) => unknown> = {};
    for (const [name, value] of Object.entries(returned)) {
      if (Object.keys(scriptFunctions).length >= MAX_EXPORTED_FUNCTIONS) {
        throw new Error(`A Server Script can export at most ${MAX_EXPORTED_FUNCTIONS} functions`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "function") {
        throw new Error(`Invalid Server Script export "${name}": expected a named function`);
      }
      const functionKey = functionScopeKey(script.customGameId, name);
      const existing = functionsByName.get(functionKey);
      if (existing && currentRuntime?.functions[name] !== existing) {
        throw new Error(`The function name "${name}" is already exported by another script`);
      }
      scriptFunctions[name] = value as (...args: unknown[]) => unknown;
    }
    if (Object.keys(scriptFunctions).length === 0) {
      throw new Error("A Server Script must export at least one function");
    }

    unloadServerScript(script.id, script.customGameId);
    runtimesByScript.set(scopeKey, { engine, functions: scriptFunctions, source: script.source });
    for (const [name, scriptFunction] of Object.entries(scriptFunctions)) {
      functionsByName.set(functionScopeKey(script.customGameId, name), scriptFunction);
    }
    writeLog("ok", `server-script:${script.customGameId}/${script.id}`, `Loaded exports: ${Object.keys(scriptFunctions).join(", ")}`);
    return Object.keys(scriptFunctions);
  } catch (error) {
    engine.global.close();
    writeLog("error", `server-script:${script.customGameId}/${script.id}`, `Load failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export function unloadServerScript(scriptId: string, customGameId: string): void {
  const scopeKey = scriptScopeKey(customGameId, scriptId);
  const runtime = runtimesByScript.get(scopeKey);
  if (!runtime) return;
  for (const name of Object.keys(runtime.functions)) {
    const functionKey = functionScopeKey(customGameId, name);
    if (functionsByName.get(functionKey) === runtime.functions[name]) functionsByName.delete(functionKey);
  }
  runtime.engine.global.close();
  runtimesByScript.delete(scopeKey);
  writeLog("info", `server-script:${customGameId}/${scriptId}`, "Unloaded");
}

export function getInventorySnapshot(): InventorySnapshot[] {
  return [...inventoryByAgent.values()].map(snapshot => ({
    ...snapshot,
    online: connectedAgents.has(snapshot.agentId),
  }));
}

export function subscribeInventory(
  listener: (snapshots: InventorySnapshot[]) => void,
): () => void {
  inventoryListeners.add(listener);
  listener(getInventorySnapshot());
  return () => inventoryListeners.delete(listener);
}
