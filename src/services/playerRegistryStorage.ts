import type { PlayerInfo, PlayerStatus } from "../lua-api/types";

const STORAGE_KEY = "axion.players.registry.v1";
export const MAX_CACHED_PLAYERS = 1_000;
const PLAYER_STATUSES: PlayerStatus[] = ["online", "busy", "idle", "offline", "error"];

function newestPlayers(players: PlayerInfo[]): PlayerInfo[] {
  return [...players]
    .sort((left, right) =>
      (right.lastSeenAt ?? right.connectedAt ?? 0) - (left.lastSeenAt ?? left.connectedAt ?? 0),
    )
    .slice(0, MAX_CACHED_PLAYERS);
}

function isPlayerInfo(value: unknown): value is PlayerInfo {
  if (typeof value !== "object" || value === null) return false;
  const player = value as Record<string, unknown>;
  return typeof player.id === "string" &&
    player.id.length > 0 &&
    typeof player.name === "string" &&
    PLAYER_STATUSES.includes(player.status as PlayerStatus) &&
    Array.isArray(player.capabilities) &&
    player.capabilities.every(capability => typeof capability === "string") &&
    typeof player.metadata === "object" &&
    player.metadata !== null &&
    !Array.isArray(player.metadata);
}

export function loadCachedPlayers(): PlayerInfo[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return [];

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isPlayerInfo)) {
    throw new Error("Saved player registry has an invalid format");
  }
  const boundedPlayers = newestPlayers(parsed);
  if (boundedPlayers.length !== parsed.length) saveCachedPlayers(boundedPlayers);
  return boundedPlayers;
}

export function saveCachedPlayers(players: PlayerInfo[]): void {
  const serialized = JSON.stringify(newestPlayers(players));
  if (localStorage.getItem(STORAGE_KEY) !== serialized) {
    localStorage.setItem(STORAGE_KEY, serialized);
  }
}
