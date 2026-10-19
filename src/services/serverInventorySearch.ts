import type { InventoryItem, InventorySnapshot } from "./serverScriptsService";

export interface SearchableInventoryItem {
  inventory: InventorySnapshot;
  item: InventoryItem;
  normalizedName: string;
}

export function indexInventory(snapshot: InventorySnapshot): SearchableInventoryItem[] {
  return snapshot.items.map(item => ({
    inventory: snapshot,
    item,
    normalizedName: item.name.toLocaleLowerCase(),
  }));
}

export function searchInventoryItems(
  indexedInventories: Iterable<SearchableInventoryItem[]>,
  customGameId: string,
  connectedAgentIds: ReadonlySet<string>,
  options: {
    query?: string;
    includeOffline: boolean;
    agentId?: string;
    onlineOnly?: boolean;
  },
) {
  const normalizedQuery = options.query?.toLocaleLowerCase();
  const matches = [];
  for (const indexedItems of indexedInventories) {
    for (const indexed of indexedItems) {
      const { inventory, item, normalizedName } = indexed;
      if (inventory.customGameId !== customGameId) continue;
      if (options.agentId !== undefined && inventory.agentId !== options.agentId) continue;
      const online = connectedAgentIds.has(inventory.agentId);
      if (options.onlineOnly && !online) continue;
      if (!options.includeOffline && !online) continue;
      if (normalizedQuery && !normalizedName.includes(normalizedQuery)) continue;

      matches.push({
        playerId: inventory.playerId,
        accountId: inventory.accountId,
        customGameId: inventory.customGameId,
        playerName: inventory.agentName,
        itemName: item.name,
        itemId: item.itemId ?? null,
        category: item.category,
        quantity: item.quantity,
        ...(item.value !== undefined ? { value: item.value } : {}),
        online,
        updatedAt: inventory.updatedAt,
      });
    }
  }
  return matches;
}
