export interface RobloxAvatarPlayer {
  id: string;
  name: string;
}

interface RobloxUsernameResult {
  data?: Array<{ id?: number; name?: string }>;
}

interface RobloxThumbnailResult {
  data?: Array<{ targetId?: number; imageUrl?: string }>;
}

interface AvatarCacheEntry {
  url?: string;
  retryAfter?: number;
}

const MAX_AVATAR_CACHE_ENTRIES = 5_000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60_000;
const FAILED_REQUEST_TTL_MS = 30_000;

let avatarSnapshot: Record<string, string> = {};
const listeners = new Set<() => void>();
const avatarCache = new Map<string, AvatarCacheEntry>();
const inFlightPlayerIds = new Set<string>();

export function getRobloxAvatarSnapshot(): Record<string, string> {
  return avatarSnapshot;
}

export function subscribeRobloxAvatars(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setCachedAvatar(playerId: string, entry: AvatarCacheEntry): boolean {
  avatarCache.delete(playerId);
  avatarCache.set(playerId, entry);
  let changed = false;
  while (avatarCache.size > MAX_AVATAR_CACHE_ENTRIES) {
    const oldestPlayerId = avatarCache.keys().next().value;
    if (oldestPlayerId === undefined) break;
    const oldest = avatarCache.get(oldestPlayerId);
    if (oldest?.url && avatarSnapshot[oldestPlayerId]) changed = true;
    avatarCache.delete(oldestPlayerId);
  }
  return changed;
}

function publishAvatars() {
  const next = Object.fromEntries(
    [...avatarCache]
      .filter((entry): entry is [string, AvatarCacheEntry & { url: string }] => typeof entry[1].url === "string")
      .map(([playerId, entry]) => [playerId, entry.url]),
  );
  const keys = Object.keys(next);
  if (keys.length === Object.keys(avatarSnapshot).length &&
      keys.every(playerId => avatarSnapshot[playerId] === next[playerId])) return;
  avatarSnapshot = next;
  listeners.forEach(listener => listener());
}

export function invalidateRobloxAvatar(playerId: string) {
  const hadAvatar = Boolean(avatarSnapshot[playerId]);
  avatarCache.delete(playerId);
  if (hadAvatar) publishAvatars();
}

export function requestRobloxAvatars(players: RobloxAvatarPlayer[]) {
  const now = Date.now();
  const pendingPlayers = players.filter(({ id }) => {
    const cached = avatarCache.get(id);
    if (cached?.url || (cached?.retryAfter !== undefined && cached.retryAfter > now)) return false;
    if (cached) avatarCache.delete(id);
    return !inFlightPlayerIds.has(id);
  });
  if (pendingPlayers.length === 0) return;

  pendingPlayers.forEach(({ id }) => inFlightPlayerIds.add(id));
  void loadRobloxAvatars(pendingPlayers);
}

async function loadRobloxAvatars(players: RobloxAvatarPlayer[]) {
  try {
    const robloxIdsByPlayerId = new Map<string, number>();
    const usernamePlayers = players.filter(({ id }) => !/^\d+$/.test(id));

    for (const player of players) {
      if (/^\d+$/.test(player.id)) {
        robloxIdsByPlayerId.set(player.id, Number(player.id));
      }
    }

    if (usernamePlayers.length > 0) {
      const response = await fetch("https://users.roproxy.com/v1/usernames/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usernames: [...new Set(usernamePlayers.map(({ name }) => name))],
          excludeBannedUsers: false,
        }),
      });
      if (!response.ok) throw new Error(`Roblox username lookup failed: HTTP ${response.status}`);
      const result = await response.json() as RobloxUsernameResult;
      const idsByUsername = new Map(
        (result.data ?? [])
          .filter((user): user is { id: number; name: string } =>
            typeof user.id === "number" && typeof user.name === "string",
          )
          .map(user => [user.name.toLowerCase(), user.id]),
      );

      for (const player of usernamePlayers) {
        const robloxId = idsByUsername.get(player.name.toLowerCase());
        if (robloxId !== undefined) robloxIdsByPlayerId.set(player.id, robloxId);
      }
    }

    const playerIdsByRobloxId = new Map<number, string[]>();
    for (const [playerId, robloxId] of robloxIdsByPlayerId) {
      const matchingPlayers = playerIdsByRobloxId.get(robloxId) ?? [];
      matchingPlayers.push(playerId);
      playerIdsByRobloxId.set(robloxId, matchingPlayers);
    }

    const robloxIds = [...playerIdsByRobloxId.keys()];
    const avatars: Record<string, string> = {};
    for (let index = 0; index < robloxIds.length; index += 100) {
      const batch = robloxIds.slice(index, index + 100);
      const response = await fetch(
        `https://thumbnails.roproxy.com/v1/users/avatar-headshot?userIds=${batch.join(",")}&size=150x150&format=Png&isCircular=false`,
      );
      if (!response.ok) throw new Error(`Roblox avatar request failed: HTTP ${response.status}`);
      const result = await response.json() as RobloxThumbnailResult;
      for (const thumbnail of result.data ?? []) {
        if (typeof thumbnail.targetId !== "number" || typeof thumbnail.imageUrl !== "string") continue;
        for (const playerId of playerIdsByRobloxId.get(thumbnail.targetId) ?? []) {
          avatars[playerId] = thumbnail.imageUrl;
        }
      }
    }

    const missingCacheEntriesWereEvicted = players.reduce((evicted, { id }) =>
      setCachedAvatar(id, avatars[id]
        ? { url: avatars[id] }
        : { retryAfter: Date.now() + NEGATIVE_CACHE_TTL_MS }) || evicted,
    false);
    if (missingCacheEntriesWereEvicted || Object.keys(avatars).length > 0) publishAvatars();
  } catch (error) {
    const evictedAvatar = players.reduce((evicted, { id }) =>
      setCachedAvatar(id, { retryAfter: Date.now() + FAILED_REQUEST_TTL_MS }) || evicted,
    false);
    if (evictedAvatar) publishAvatars();
    console.warn("Could not load Roblox avatar thumbnails", error);
  } finally {
    players.forEach(({ id }) => inFlightPlayerIds.delete(id));
  }
}
