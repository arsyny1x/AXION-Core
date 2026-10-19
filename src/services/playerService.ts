/**
 * PlayerService — authoritative, real-time registry of players connected to
 * AXION Core.
 *
 * In Tauri it mirrors Agent connections from the local legacy WebSocket
 * adapter. In browser development it can also consume the shared Lua API
 * event bus.
 *
 * There is no mock data in this service.
 */

import { getLuaApi } from "./luaApiService";
import type { LuaApiModule } from "../lua-api";
import type { PlayerInfo, PlayerStatus } from "../lua-api/types";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeLog } from "./logService";
import { loadCachedPlayers, saveCachedPlayers } from "./playerRegistryStorage";

export const MAX_SCRIPT_BYTES = 16 * 1024;
const MIN_SCRIPT_INTERVAL_MS = 1_000;

export interface ScriptSendResult {
  agentId: string;
  error: string | null;
}

export interface PlayerRegistrySnapshot {
  players: PlayerInfo[];
  updatedAt: number;
  fetchedAt?: number;
  connected: boolean;
  serverError: string | null;
}

interface AxionServerStatus {
  running: boolean;
  host: string;
  port: number;
  connectedAgents: number;
  error: string | null;
}

type Listener = (snapshot: PlayerRegistrySnapshot) => void;
type HeartbeatListener = (agentId: string, lastSeenAt: number) => void;

class PlayerService {
  private players = new Map<string, PlayerInfo>();
  private playersSnapshot: PlayerInfo[] = [];
  private listeners = new Set<Listener>();
  private heartbeatListeners = new Set<HeartbeatListener>();
  private unsubscribers: Array<() => void> = [];
  private api: LuaApiModule | null = null;
  private connected = false;
  private serverError: string | null = null;
  private fetchedAt: number | undefined;
  private started = false;
  private lifecycleGeneration = 0;
  private executingAgents = new Set<string>();
  private lastScriptSentAt = new Map<string, number>();
  private cacheLoaded = false;

  /** Wire the service to the running Lua API module. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadPlayerCache();
    const generation = ++this.lifecycleGeneration;

    const api = getLuaApi();
    this.api = api;
    const events = api.events;

    const offConnected = events.on("client.connected", () => {
      this.connected = true;
      writeLog("ok", "transport", "Client transport connected");
      this.emit();
      void this.requestSnapshot();
    });

    const offDisconnected = events.on("client.disconnected", () => {
      this.connected = false;
      writeLog("warn", "transport", "Client transport disconnected");
      const changed = this.markPlayersOffline();
      const prunedPlayers = this.pruneOfflinePlayers();
      if (changed || prunedPlayers) this.persistPlayerCache();
      this.emit();
    });

    const offPlayerConnected = events.on("player.connected", (payload: unknown) => {
      const p = normalizePlayer(payload);
      if (!p) return;
      p.connectedAt = p.connectedAt ?? Date.now();
      p.lastSeenAt = Date.now();
      if (!this.upsertPlayer(p)) return;
      this.persistPlayerCache();
      writeLog("ok", `agent:${p.id}`, `Connected: ${p.name}`);
      this.emit();
    });

    const offPlayerUpdated = events.on("player.updated", (payload: unknown) => {
      const p = normalizePlayer(payload);
      if (!p) return;
      if (!this.upsertPlayer(p)) return;
      if (p.status === "offline") this.pruneOfflinePlayers();
      this.persistPlayerCache();
      this.emit();
    });

    const offPlayerDisconnected = events.on("player.disconnected", (payload: unknown) => {
      const id = extractId(payload);
      if (!id) return;
      const existing = this.players.get(id);
      if (existing && this.upsertPlayer({ ...existing, status: "offline", lastSeenAt: Date.now() })) {
        this.pruneOfflinePlayers();
        this.persistPlayerCache();
      }
      writeLog("warn", `agent:${id}`, "Disconnected");
      this.emit();
    });

    const offPlayerList = events.on("player.list", (payload: unknown) => {
      const list = extractList(payload);
      if (!list) return;
      this.fetchedAt = Date.now();
      let changed = this.markPlayersOffline(false);
      for (const raw of list) {
        const p = normalizePlayer(raw);
        if (p) {
          const existing = this.players.get(p.id);
          p.lastSeenAt = p.lastSeenAt ?? existing?.lastSeenAt ?? Date.now();
          const updated = existing ? { ...existing, ...p } : p;
          if (!samePlayerInfo(existing, updated)) {
            this.players.set(p.id, updated);
            changed = true;
          }
        }
      }
      const prunedPlayers = this.pruneOfflinePlayers(false);
      if (changed || prunedPlayers) {
        this.refreshPlayersSnapshot();
        this.persistPlayerCache();
      }
      this.pruneScriptRateLimits();
      this.emit();
    });

    this.unsubscribers = [
      offConnected,
      offDisconnected,
      offPlayerConnected,
      offPlayerUpdated,
      offPlayerDisconnected,
      offPlayerList,
    ];

    if (isTauri()) void this.connectNativeEvents(generation);

    // If the transport is already connected when the UI mounts, request a snapshot.
    if (api.transport.getState() === "connected") {
      this.connected = true;
      void this.requestSnapshot();
    }
  }

  stop(): void {
    this.started = false;
    this.lifecycleGeneration += 1;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeHeartbeats(listener: HeartbeatListener): () => void {
    this.heartbeatListeners.add(listener);
    return () => this.heartbeatListeners.delete(listener);
  }

  getPlayers(): PlayerInfo[] {
    return [...this.players.values()];
  }

  getPlayer(id: string): PlayerInfo | null {
    return this.players.get(id) ?? null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Refresh the list from the local Tauri server or connected host transport. */
  async requestSnapshot(): Promise<void> {
    if (isTauri()) {
      try {
        const [agents, server] = await Promise.all([
          invoke<PlayerInfo[]>("axion_list_agents"),
          invoke<AxionServerStatus>("axion_server_status"),
        ]);
        let playersChanged = this.markPlayersOffline(false);
        for (const agent of agents) {
          const normalized = normalizePlayer(agent);
          if (!normalized) continue;
          const existing = this.players.get(normalized.id);
          const updated = existing ? { ...existing, ...normalized } : normalized;
          if (!samePlayerInfo(existing, updated)) {
            this.players.set(normalized.id, updated);
            playersChanged = true;
          }
        }
        const prunedPlayers = this.pruneOfflinePlayers(false);
        if (playersChanged || prunedPlayers) {
          this.refreshPlayersSnapshot();
          this.persistPlayerCache();
        }
        this.pruneScriptRateLimits();
        const wasConnected = this.connected;
        this.connected = server.running;
        this.serverError = server.error;
        this.fetchedAt = Date.now();
        writeLog("info", "player-service", `Agent snapshot refreshed (${this.players.size} agents)`);
        if (wasConnected !== this.connected) {
          writeLog(
            this.connected ? "ok" : "warn",
            "axion-server",
            this.connected ? "Local agent server started" : "Local agent server stopped",
          );
        }
        if (server.error) writeLog("error", "axion-server", server.error);
        this.emit();
      } catch (error) {
        this.serverError = error instanceof Error ? error.message : String(error);
        writeLog("error", "player-service", `Could not refresh agent list: ${this.serverError}`);
        this.emit();
      }
      return;
    }

    const api = this.api;
    if (!api) return;
    if (api.transport.getState() !== "connected") return;
    try {
      await api.transport.send({
        id: api.utils.uuid(),
        type: "player.request",
        timestamp: Date.now(),
        protocolVersion: "1.0.0",
        payload: {},
      });
      this.fetchedAt = Date.now();
      this.emit();
    } catch (error) {
      writeLog("error", "player-service", `Could not request agent snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async setAgentStatus(
    agentId: string,
    status: Extract<PlayerStatus, "online" | "busy" | "idle">,
  ): Promise<void> {
    if (!isTauri()) throw new Error("Changing Agent status is available in AXION Core only");
    const updated = await invoke<PlayerInfo>("axion_set_agent_status", {
      agentId,
      status,
    });
    if (!this.upsertPlayer(normalizePlayer(updated) ?? updated)) return;
    this.persistPlayerCache();
    writeLog("info", `agent:${agentId}`, `Status changed to ${status}`);
    this.emit();
  }

  async killAgentInstance(agentId: string): Promise<void> {
    if (!isTauri()) throw new Error("Stopping an Agent instance is available in AXION Core only");
    await invoke<void>("axion_kill_agent_instance", { agentId });
    writeLog("warn", `agent:${agentId}`, "Agent instance stopped");
  }

  async deleteAgent(agentId: string): Promise<void> {
    if (!isTauri()) throw new Error("Deleting an account is available in AXION Core only");
    await invoke<void>("axion_delete_agent", { agentId });
    const removed = this.players.delete(agentId);
    if (removed) this.refreshPlayersSnapshot();
    this.lastScriptSentAt.delete(agentId);
    if (removed) this.persistPlayerCache();
    writeLog("warn", `agent:${agentId}`, "Agent account deleted");
    this.emit();
  }

  async executeScript(agentId: string, script: string): Promise<void> {
    if (!isTauri()) throw new Error("Executing a script is available in AXION Core only");
    const messageBytes = new TextEncoder().encode(`execute ${script}`).byteLength;
    if (messageBytes > MAX_SCRIPT_BYTES) {
      throw new Error(`Script exceeds the ${MAX_SCRIPT_BYTES / 1024} KiB AXION WebSocket message limit`);
    }
    if (this.executingAgents.has(agentId)) {
      throw new Error("A script is already being sent to this player; wait for it to finish");
    }

    const now = Date.now();
    const elapsed = now - (this.lastScriptSentAt.get(agentId) ?? 0);
    if (elapsed < MIN_SCRIPT_INTERVAL_MS) {
      throw new Error(`Please wait ${Math.ceil((MIN_SCRIPT_INTERVAL_MS - elapsed) / 1000)} seconds before sending another script to this player`);
    }

    this.executingAgents.add(agentId);
    this.lastScriptSentAt.set(agentId, now);
    try {
      await invoke<void>("axion_execute_script", { agentId, script });
      writeLog("ok", `agent:${agentId}`, `Script sent (${messageBytes} bytes)`);
    } catch (error) {
      writeLog("error", `agent:${agentId}`, `Script send failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      this.executingAgents.delete(agentId);
    }
  }

  async executeScripts(agentIds: string[], script: string): Promise<ScriptSendResult[]> {
    if (!isTauri()) throw new Error("Executing a script is available in AXION Core only");
    const uniqueAgentIds = [...new Set(agentIds)];
    if (uniqueAgentIds.length === 0) return [];
    const messageBytes = new TextEncoder().encode(`execute ${script}`).byteLength;
    if (messageBytes > MAX_SCRIPT_BYTES) {
      throw new Error(`Script exceeds the ${MAX_SCRIPT_BYTES / 1024} KiB AXION WebSocket message limit`);
    }

    const now = Date.now();
    const results: ScriptSendResult[] = [];
    const readyAgentIds: string[] = [];
    for (const agentId of uniqueAgentIds) {
      if (this.executingAgents.has(agentId)) {
        results.push({ agentId, error: "A script is already being sent to this player; wait for it to finish" });
        continue;
      }

      const elapsed = now - (this.lastScriptSentAt.get(agentId) ?? 0);
      if (elapsed < MIN_SCRIPT_INTERVAL_MS) {
        results.push({
          agentId,
          error: `Please wait ${Math.ceil((MIN_SCRIPT_INTERVAL_MS - elapsed) / 1000)} seconds before sending another script to this player`,
        });
        continue;
      }
      readyAgentIds.push(agentId);
    }

    if (readyAgentIds.length === 0) return results;
    for (const agentId of readyAgentIds) {
      this.executingAgents.add(agentId);
      this.lastScriptSentAt.set(agentId, now);
    }
    try {
      const sentResults = await invoke<ScriptSendResult[]>("axion_execute_scripts", {
        agentIds: readyAgentIds,
        script,
      });
      for (const result of sentResults) {
        writeLog(
          result.error ? "error" : "ok",
          `agent:${result.agentId}`,
          result.error ?? `Script sent (${messageBytes} bytes)`,
        );
      }
      return [...results, ...sentResults];
    } catch (error) {
      writeLog("error", "player-service", `Batch script send failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      for (const agentId of readyAgentIds) this.executingAgents.delete(agentId);
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  private upsertPlayer(player: PlayerInfo): boolean {
    const existing = this.players.get(player.id);
    const updated = existing ? { ...existing, ...player } : player;
    if (samePlayerInfo(existing, updated)) return false;
    this.players.set(player.id, updated);
    this.refreshPlayersSnapshot();
    return true;
  }

  private markPlayersOffline(refreshSnapshot = true): boolean {
    let changed = false;
    for (const [id, player] of this.players) {
      if (player.status === "offline") continue;
      this.players.set(id, { ...player, status: "offline" });
      changed = true;
    }
    if (changed && refreshSnapshot) this.refreshPlayersSnapshot();
    return changed;
  }

  private refreshPlayersSnapshot(): void {
    this.playersSnapshot = [...this.players.values()];
  }

  private pruneOfflinePlayers(refreshSnapshot = true): boolean {
    const offlinePlayers = [...this.players.values()]
      .filter(player => player.status === "offline")
      .sort((left, right) =>
        (right.lastSeenAt ?? right.connectedAt ?? 0) - (left.lastSeenAt ?? left.connectedAt ?? 0),
      );
    let changed = false;
    for (const player of offlinePlayers.slice(1_000)) {
      this.players.delete(player.id);
      this.lastScriptSentAt.delete(player.id);
      changed = true;
    }
    if (changed && refreshSnapshot) this.refreshPlayersSnapshot();
    return changed;
  }

  private loadPlayerCache(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    try {
      for (const player of loadCachedPlayers()) {
        this.players.set(player.id, { ...player, status: "offline" });
      }
      this.refreshPlayersSnapshot();
    } catch (error) {
      writeLog("error", "player-service", `Could not load cached players: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persistPlayerCache(): void {
    try {
      saveCachedPlayers(this.playersSnapshot);
    } catch (error) {
      writeLog("error", "player-service", `Could not save cached players: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private snapshot(): PlayerRegistrySnapshot {
    return {
      players: this.playersSnapshot,
      updatedAt: Date.now(),
      fetchedAt: this.fetchedAt,
      connected: this.connected,
      serverError: this.serverError,
    };
  }

  private pruneScriptRateLimits(): void {
    for (const agentId of this.lastScriptSentAt.keys()) {
      if (!this.players.has(agentId)) this.lastScriptSentAt.delete(agentId);
    }
  }

  private async connectNativeEvents(generation: number): Promise<void> {
    const unlisten: Array<() => void> = [];
    let acceptingListeners = true;
    const registerListener = (registration: Promise<() => void>): Promise<void> =>
      registration.then((off) => {
        if (!acceptingListeners || !this.started || generation !== this.lifecycleGeneration) {
          off();
        } else {
          unlisten.push(off);
        }
      });

    try {
      await Promise.all([
        registerListener(listen<PlayerInfo>("axion-agent-connected", ({ payload }) => {
          const player = normalizePlayer(payload);
          if (!player) return;
          player.connectedAt = player.connectedAt ?? Date.now();
          player.lastSeenAt = Date.now();
          if (!this.upsertPlayer(player)) return;
          this.persistPlayerCache();
          this.emit();
        })),
        registerListener(listen<{ id: string }>("axion-agent-disconnected", ({ payload }) => {
          const player = this.players.get(payload.id);
          if (!player) return;
          if (!this.upsertPlayer({ ...player, status: "offline", lastSeenAt: Date.now() })) return;
          this.pruneOfflinePlayers();
          this.persistPlayerCache();
          this.emit();
        })),
        registerListener(listen<{ id: string }>("axion-agent-deleted", ({ payload }) => {
          const removed = this.players.delete(payload.id);
          this.lastScriptSentAt.delete(payload.id);
          if (!removed) return;
          this.refreshPlayersSnapshot();
          this.persistPlayerCache();
          this.emit();
        })),
        registerListener(listen<{ id: string; lastSeenAt: number }>("axion-agent-heartbeat", ({ payload }) => {
          const player = this.players.get(payload.id);
          if (!player || player.lastSeenAt === payload.lastSeenAt) return;
          this.players.set(payload.id, { ...player, lastSeenAt: payload.lastSeenAt });
          for (const listener of this.heartbeatListeners) {
            listener(payload.id, payload.lastSeenAt);
          }
        })),
        registerListener(listen<PlayerInfo>("axion-agent-updated", ({ payload }) => {
          const player = normalizePlayer(payload);
          if (!player) return;
          const existing = this.players.get(player.id);
          if (existing?.lastSeenAt !== undefined) {
            player.lastSeenAt = existing.lastSeenAt;
          }
          if (!this.upsertPlayer(player)) return;
          if (player.status === "offline") this.pruneOfflinePlayers();
          this.persistPlayerCache();
          this.emit();
        })),
      ]);
      if (!this.started || generation !== this.lifecycleGeneration) {
        unlisten.forEach((off) => off());
        return;
      }
      this.unsubscribers.push(...unlisten);
      writeLog("ok", "player-service", "Native agent event listeners attached");
      await this.requestSnapshot();
    } catch (error) {
      acceptingListeners = false;
      unlisten.forEach((off) => off());
      if (this.started && generation === this.lifecycleGeneration) {
        this.serverError = error instanceof Error ? error.message : String(error);
        writeLog("error", "player-service", `Native event setup failed: ${this.serverError}`);
        this.emit();
      }
    }
  }
}

export const playerService = new PlayerService();

// ---------------------------------------------------------------------------
// Payload normalization — never trust the wire
// ---------------------------------------------------------------------------

function normalizePlayer(value: unknown): PlayerInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === "string" && v.id.length > 0 ? v.id : null;
  if (!id) return null;

  const player: PlayerInfo = {
    id,
    name: typeof v.name === "string" ? v.name : id,
    status: normalizeStatus(v.status),
    capabilities: Array.isArray(v.capabilities)
      ? v.capabilities.filter((c): c is string => typeof c === "string")
      : [],
    metadata:
      v.metadata && typeof v.metadata === "object" && !Array.isArray(v.metadata)
        ? (v.metadata as Record<string, unknown>)
        : {},
  };
  if (typeof v.level === "number") player.level = v.level;
  if (typeof v.job === "string") player.job = v.job;
  if (typeof v.guild === "string") player.guild = v.guild;
  if (typeof v.server === "string") player.server = v.server;
  if (typeof v.placeId === "string" || typeof v.placeId === "number") {
    player.placeId = String(v.placeId);
  }
  if (typeof v.region === "string") player.region = v.region;
  if (typeof v.connectedAt === "number") player.connectedAt = v.connectedAt;
  if (typeof v.lastSeenAt === "number") player.lastSeenAt = v.lastSeenAt;
  return player;
}

function samePlayerInfo(left: PlayerInfo | undefined, right: PlayerInfo): boolean {
  if (!left) return false;
  const leftValues = left as unknown as Record<string, unknown>;
  const rightValues = right as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftValues), ...Object.keys(rightValues)]);
  for (const key of keys) {
    const leftValue = leftValues[key];
    const rightValue = rightValues[key];
    if (key === "capabilities") {
      if (!Array.isArray(leftValue) || !Array.isArray(rightValue) ||
          leftValue.length !== rightValue.length ||
          leftValue.some((value, index) => value !== rightValue[index])) return false;
    } else if (key === "metadata") {
      if (!leftValue || !rightValue || typeof leftValue !== "object" || typeof rightValue !== "object") {
        if (leftValue !== rightValue) return false;
      } else {
        const leftMetadata = leftValue as Record<string, unknown>;
        const rightMetadata = rightValue as Record<string, unknown>;
        const metadataKeys = Object.keys(leftMetadata);
        if (metadataKeys.length !== Object.keys(rightMetadata).length ||
            metadataKeys.some(metadataKey => !Object.is(leftMetadata[metadataKey], rightMetadata[metadataKey]))) {
          return false;
        }
      }
    } else if (!Object.is(leftValue, rightValue)) {
      return false;
    }
  }
  return true;
}

function normalizeStatus(value: unknown): PlayerStatus {
  if (
    value === "online" ||
    value === "busy" ||
    value === "idle" ||
    value === "offline" ||
    value === "error"
  ) {
    return value;
  }
  return "online";
}

function extractId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" ? v.id : null;
}

function extractList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.players)) return v.players;
  }
  return null;
}