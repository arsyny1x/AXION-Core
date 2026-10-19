import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCachedPlayers, MAX_CACHED_PLAYERS, saveCachedPlayers } from "../playerRegistryStorage";
import type { PlayerInfo } from "../../lua-api/types";

function installStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return values;
}

const player: PlayerInfo = {
  id: "player-123",
  name: "Player One",
  status: "online",
  capabilities: [],
  metadata: {},
  connectedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_001_000,
};

describe("playerRegistryStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads an empty cache when no players have connected yet", () => {
    installStorage();
    expect(loadCachedPlayers()).toEqual([]);
  });

  it("persists previously connected player details for offline restoration", () => {
    const storage = installStorage();
    saveCachedPlayers([player]);

    expect(storage.get("axion.players.registry.v1")).toContain("Player One");
    expect(loadCachedPlayers()).toEqual([player]);
  });

  it("rejects corrupted cached player data", () => {
    const storage = installStorage();
    storage.set("axion.players.registry.v1", '[{"id":"player-123","name":"Player One"}]');

    expect(() => loadCachedPlayers()).toThrow("Saved player registry has an invalid format");
    expect(storage.get("axion.players.registry.v1")).toContain("Player One");
  });

  it("caps the persisted offline registry to the most recently seen players", () => {
    const storage = installStorage();
    const players = Array.from({ length: MAX_CACHED_PLAYERS + 1 }, (_, index) => ({
      ...player,
      id: `player-${index}`,
      lastSeenAt: index,
    }));
    saveCachedPlayers(players);

    expect(loadCachedPlayers()).toHaveLength(MAX_CACHED_PLAYERS);
    expect(loadCachedPlayers()[0].id).toBe(`player-${MAX_CACHED_PLAYERS}`);
    expect(storage.get("axion.players.registry.v1")).not.toContain('"id":"player-0"');
  });
});
