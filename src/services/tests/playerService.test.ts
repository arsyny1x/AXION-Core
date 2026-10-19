import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { playerService } from "../playerService";

const { nativeHandlers } = vi.hoisted(() => ({
  nativeHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, callback: (event: { payload: unknown }) => void) => {
    nativeHandlers.set(name, callback);
    return Promise.resolve(() => nativeHandlers.delete(name));
  }),
}));

vi.mock("../luaApiService", () => ({
  getLuaApi: () => ({
    events: { on: vi.fn(() => vi.fn()) },
    transport: { getState: () => "disconnected" },
  }),
}));

afterEach(() => {
  playerService.stop();
  nativeHandlers.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("PlayerService native event lifecycle", () => {
  it("unsubscribes successful listeners when another listener fails to register", async () => {
    const unsubscribe = vi.fn();
    const unsubscribeLateListener = vi.fn();
    let resolveLateListener: ((unsubscribe: () => void) => void) | undefined;
    vi.mocked(listen)
      .mockResolvedValueOnce(unsubscribe)
      .mockRejectedValueOnce(new Error("event registration failed"))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveLateListener = resolve;
      }))
      .mockResolvedValueOnce(unsubscribe)
      .mockResolvedValueOnce(unsubscribe);

    playerService.start();
    await vi.waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledTimes(3);
    });

    resolveLateListener?.(unsubscribeLateListener);
    await vi.waitFor(() => {
      expect(unsubscribeLateListener).toHaveBeenCalledOnce();
    });
    expect(listen).toHaveBeenCalledTimes(5);
  });

  it("does not publish or persist unchanged agent updates and isolates heartbeats", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem,
    });
    playerService.start();
    await vi.waitFor(() => expect(nativeHandlers.size).toBe(5));
    await new Promise(resolve => setTimeout(resolve, 0));

    const snapshots: Array<{ players: ReturnType<typeof playerService.getPlayers> }> = [];
    playerService.subscribe(snapshot => snapshots.push(snapshot));
    const initialNotifications = snapshots.length;
    const player = {
      id: "heartbeat-player",
      name: "Heartbeat Player",
      status: "online",
      capabilities: [],
      metadata: {},
    };
    nativeHandlers.get("axion-agent-connected")?.({ payload: player });
    expect(snapshots).toHaveLength(initialNotifications + 1);
    const publishedPlayers = snapshots[snapshots.length - 1]?.players;
    const persistedWrites = setItem.mock.calls.length;

    nativeHandlers.get("axion-agent-updated")?.({
      payload: playerService.getPlayer(player.id),
    });
    expect(snapshots).toHaveLength(initialNotifications + 1);
    expect(setItem).toHaveBeenCalledTimes(persistedWrites);

    nativeHandlers.get("axion-agent-heartbeat")?.({
      payload: { id: player.id, lastSeenAt: Date.now() + 10_000 },
    });
    expect(snapshots).toHaveLength(initialNotifications + 1);
    expect(snapshots[snapshots.length - 1]?.players).toBe(publishedPlayers);
    expect(playerService.getPlayer(player.id)?.lastSeenAt).toBeGreaterThan(playerService.getPlayer(player.id)?.connectedAt ?? 0);
    expect(setItem).toHaveBeenCalledTimes(persistedWrites);
  });
});
