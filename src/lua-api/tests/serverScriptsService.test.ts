import { afterEach, describe, expect, it, vi } from "vitest";
import suiteSource from "../../../lua/test script lua/server.lua?raw";

const { invokeMock, listenMock, eventHandlers, responses } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  responses: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import {
  initializeServerScripts,
  loadServerScript,
  refreshInventoryCache,
  subscribeInventory,
  unloadServerScript,
} from "../../services/serverScriptsService";

describe("Server Scripts service", () => {
  afterEach(() => {
    unloadServerScript("test-server-script", "BLOX_FRUITS");
    unloadServerScript("other-game-script", "OTHER_GAME");
    unloadServerScript("test-server-script", "OTHER_GAME");
    unloadServerScript("suite-server-script", "AXION_TEST");
    eventHandlers.clear();
    responses.length = 0;
    localStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("invokes saved Lua exports with online-filtered inventory and returns JSON", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        values: new Map<string, string>(),
        getItem(key: string) { return this.values.get(key) ?? null; },
        setItem(key: string, value: string) { this.values.set(key, value); },
        clear() { this.values.clear(); },
      },
    });
    listenMock.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => {
      eventHandlers.set(name, callback);
      return () => eventHandlers.delete(name);
    });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "axion_item_cache_list") {
        return [
          {
            playerId: "player-online",
            agentId: "player-online",
            accountId: "account-online",
            customGameId: "BLOX_FRUITS",
            agentName: "Online player",
            items: [{ name: "Potion", quantity: 3, itemId: "potion", category: "materials" }],
            updatedAt: 100,
            online: true,
          },
          {
            playerId: "player-offline",
            agentId: "player-offline",
            accountId: "account-offline",
            customGameId: "BLOX_FRUITS",
            agentName: "Offline player",
            items: [{ name: "Potion", quantity: 8, itemId: "potion", category: "materials" }],
            updatedAt: 90,
            online: false,
          },
          {
            playerId: "player-empty",
            agentId: "player-empty",
            accountId: "account-empty",
            customGameId: "BLOX_FRUITS",
            agentName: "Empty inventory",
            items: [],
            updatedAt: 80,
            online: false,
          },
          {
            playerId: "other-online",
            agentId: "other-online",
            accountId: "account-other",
            customGameId: "OTHER_GAME",
            agentName: "Other game player",
            items: [{ name: "Potion", quantity: 99, itemId: "other-potion", category: "materials" }],
            updatedAt: 70,
            online: true,
          },
          {
            playerId: "axion-test-player",
            agentId: "axion-test-player",
            accountId: "account-axion-test",
            customGameId: "AXION_TEST",
            agentName: "AXION test player",
            items: [{
              name: "AXION_TEST_ITEM1",
              quantity: 7,
              itemId: "axion_test_item1",
              category: "materials",
            }],
            updatedAt: 60,
            online: false,
          },
        ];
      }
      if (command === "axion_list_agents") return [{ id: "player-online" }, { id: "other-online" }];
      if (command === "axion_server_script_api_status") return { running: true };
      if (command === "axion_server_script_respond") {
        responses.push(args ?? {});
        return undefined;
      }
      return undefined;
    });

    let latestInventories: Array<{ playerId: string; online: boolean; items: unknown[] }> = [];
    const unsubscribe = subscribeInventory(snapshots => { latestInventories = snapshots; });
    await initializeServerScripts();
    expect(latestInventories).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerId: "player-online", online: true }),
      expect.objectContaining({ playerId: "player-empty", items: [] }),
    ]));
    await loadServerScript({
      id: "test-server-script",
      name: "Inventory lookup",
      customGameId: "BLOX_FRUITS",
      source: `return {
        hello = function(args)
          return { ok = true, message = "Hello, " .. tostring(args.name or "AXION") .. "!" }
        end,
        search = function(args)
          local items = Server.Items.search(args.query, args.includeOffline == true)
          return {
            count = #items,
            firstPlayer = items[1] and items[1].playerId or "",
            online = Server.Players.isOnline("player-online"),
            gameId = Server.Game.customGameId
          }
        end,
        online_inventory = function(args)
          local items = Server.Items.getOnline(args.agentId)
          return {
            customGameId = Server.Game.customGameId,
            count = #items,
            items = items
          }
        end
      }`,
    });

    const invokeHandler = eventHandlers.get("axion-server-script-invoke");
    expect(invokeHandler).toBeDefined();
    invokeHandler?.({
      payload: {
        requestId: "test-request",
        function: "search",
        customGameId: "BLOX_FRUITS",
        args: { query: "potion" },
      },
    });
    await vi.waitFor(() => expect(responses).toHaveLength(1));

    expect(responses[0]).toMatchObject({
      requestId: "test-request",
      result: { count: 1, firstPlayer: "player-online", online: true, gameId: "BLOX_FRUITS" },
      error: null,
    });

    invokeHandler?.({
      payload: {
        requestId: "online-inventory-request",
        function: "online_inventory",
        customGameId: "BLOX_FRUITS",
        args: {},
      },
    });
    await vi.waitFor(() => expect(responses).toHaveLength(2));
    expect(responses[1]).toMatchObject({
      requestId: "online-inventory-request",
      result: {
        customGameId: "BLOX_FRUITS",
        count: 1,
        items: [{
          playerId: "player-online",
          itemName: "Potion",
          quantity: 3,
          online: true,
        }],
      },
      error: null,
    });

    invokeHandler?.({
      payload: {
        requestId: "hello-request",
        function: "hello",
        customGameId: "BLOX_FRUITS",
        args: { name: "AXION" },
      },
    });
    await vi.waitFor(() => expect(responses).toHaveLength(3));
    expect(responses[2]).toMatchObject({
      requestId: "hello-request",
      result: { ok: true, message: "Hello, AXION!" },
      error: null,
    });

    await loadServerScript({
      id: "other-game-script",
      name: "Other game lookup",
      customGameId: "OTHER_GAME",
      source: `return {
        search = function(args)
          local items = Server.Items.search(args.query)
          return { gameId = Server.Game.customGameId, count = #items, firstPlayer = items[1].playerId }
        end
      }`,
    });
    invokeHandler?.({
      payload: {
        requestId: "other-game-request",
        function: "search",
        customGameId: "OTHER_GAME",
        args: { query: "potion" },
      },
    });
    await vi.waitFor(() => expect(responses).toHaveLength(4));
    expect(responses[3]).toMatchObject({
      requestId: "other-game-request",
      result: { gameId: "OTHER_GAME", count: 1, firstPlayer: "other-online" },
      error: null,
    });
    invokeHandler?.({
      payload: {
        requestId: "missing-export-request",
        function: "missing_export",
        customGameId: "BLOX_FRUITS",
        args: {},
      },
    });
    await vi.waitFor(() => expect(responses).toHaveLength(5));
    expect(responses[4]?.error).toContain(
      'Server Script function "missing_export" was not found in scope "BLOX_FRUITS"',
    );
    expect(responses[4]?.error).toContain("loaded exports in that scope: hello, online_inventory, search");

    const suiteExports = await loadServerScript({
      id: "suite-server-script",
      name: "AXION API test suite",
      customGameId: "AXION_TEST",
      source: suiteSource,
    });
    expect(suiteExports).toContain("get_scope");
    expect(suiteExports).toContain("find_item");
    expect(suiteExports).toContain("get_online_inventory");

    invokeHandler?.({
      payload: {
        requestId: "suite-get-scope-request",
        function: "get_scope",
        customGameId: "AXION_TEST",
        args: {},
      },
    });
    await vi.waitFor(() => expect(responses).toHaveLength(6));
    expect(responses[5]).toMatchObject({
      requestId: "suite-get-scope-request",
      result: { customGameId: "AXION_TEST" },
      error: null,
    });

    invokeHandler?.({
      payload: {
        requestId: "suite-find-item-request",
        function: "find_item",
        customGameId: "AXION_TEST",
        args: { query: "AXION_TEST_ITEM", includeOffline: true },
      },
    });
    await vi.waitFor(() => expect(responses).toHaveLength(7));
    expect(responses[6]).toMatchObject({
      requestId: "suite-find-item-request",
      result: {
        customGameId: "AXION_TEST",
        count: 1,
        items: [{
          customGameId: "AXION_TEST",
          accountId: "account-axion-test",
          playerName: "AXION test player",
          itemName: "AXION_TEST_ITEM1",
          itemId: "axion_test_item1",
          category: "materials",
          quantity: 7,
          online: false,
        }],
      },
      error: null,
    });

    await refreshInventoryCache();
    expect(latestInventories).toHaveLength(5);
    unsubscribe();
  });

});
