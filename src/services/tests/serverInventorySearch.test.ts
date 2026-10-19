import { describe, expect, it } from "vitest";
import type { InventorySnapshot } from "../serverScriptsService";
import { indexInventory, searchInventoryItems } from "../serverInventorySearch";

function makeInventory(overrides: Partial<InventorySnapshot> = {}): InventorySnapshot {
  return {
    playerId: "player-1",
    accountId: "account-1",
    customGameId: "BLOX_FRUITS",
    agentId: "agent-1",
    agentName: "Agent One",
    items: [
      { name: "Dragon Fruit", quantity: 2, itemId: "fruit-1", category: "fruits" },
      { name: "Iron Sword", quantity: 1, category: "swords", value: "Legendary" },
    ],
    updatedAt: 1_700_000_000_000,
    online: true,
    ...overrides,
  };
}

describe("server inventory search index", () => {
  it("returns case-insensitive substring matches with online state and inventory fields", () => {
    const inventory = makeInventory();
    const matches = searchInventoryItems(
      [indexInventory(inventory)],
      "BLOX_FRUITS",
      new Set(["agent-1"]),
      { query: "DRAGON", includeOffline: false },
    );

    expect(matches).toEqual([{
      playerId: "player-1",
      accountId: "account-1",
      customGameId: "BLOX_FRUITS",
      playerName: "Agent One",
      itemName: "Dragon Fruit",
      itemId: "fruit-1",
      category: "fruits",
      quantity: 2,
      online: true,
      updatedAt: 1_700_000_000_000,
    }]);
  });

  it("filters offline, agent, and game scopes without mutating the cached index", () => {
    const first = indexInventory(makeInventory());
    const second = indexInventory(makeInventory({
      accountId: "account-2",
      agentId: "agent-2",
      customGameId: "OTHER_GAME",
      items: [{ name: "Dragon Fruit", quantity: 3, category: "fruits" }],
    }));

    expect(searchInventoryItems(
      [first, second],
      "BLOX_FRUITS",
      new Set(),
      { query: "dragon", includeOffline: false },
    )).toEqual([]);
    expect(searchInventoryItems(
      [first, second],
      "BLOX_FRUITS",
      new Set(),
      { query: "dragon", includeOffline: true, agentId: "agent-1" },
    )).toHaveLength(1);
    expect(first[0].normalizedName).toBe("dragon fruit");
  });

  it("preserves optional item values in search results", () => {
    const inventory = makeInventory();
    const matches = searchInventoryItems(
      [indexInventory(inventory)],
      "BLOX_FRUITS",
      new Set(["agent-1"]),
      { query: "Iron Sword", includeOffline: false },
    );

    expect(matches[0].value).toBe("Legendary");
  });
});
