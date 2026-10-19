# Server Scripts API

Server Scripts are Lua scripts saved in AXION and evaluated by the desktop app's Wasmoon runtime. They are not Roblox `ServerScriptService` scripts. A saved source must return a table of named functions:

```lua
return {
    function_name = function(args)
        args = args or {}
        return { ok = true }
    end
}
```

Each export receives one `args` value. To invoke it from the AXION client, use [`AXION:Fetch`](./client-api.md#api-reference) or `AXION:FetchAsync`.

The prefilled Server Script includes `get_online_inventory`, which returns inventory reported by online clients in the script's Game Scope.

## Complete example: search workspace inventory

### 1. Save this Server Script

In **AXION > Server Scripts**, use the desired Game scope, paste this code, and save it. The name `find_item` is the exported function name used by the client.

```lua
return {
    find_item = function(args)
        args = args or {}
        local query = args.query or ""
        local includeOffline = args.includeOffline == true
        local matches = Server.Items.search(query, includeOffline)

        return {
            customGameId = Server.Game.customGameId,
            count = #matches,
            items = matches
        }
    end
}
```

### 2. Run this in the AXION client environment

Replace the token with the value shown in the same AXION installation's Server Scripts page. The client API's `CONFIG.gamescope` must match the script's editor scope.

```lua
local token = "YOUR_64_CHARACTER_API_TOKEN"
local ok, result = pcall(function()
    return AXION:Fetch("find_item", {
        query = "Example Item",
        includeOffline = true
    }, token)
end)

if not ok then
    warn("Server Script call failed:", result)
    return
end

print("Scope:", result.customGameId)
print("Matching entries:", result.count)
for _, item in ipairs(result.items) do
    print(item.playerName, item.accountId, item.itemName, item.quantity, item.category)
end
```

The function searches previously reported, cached inventory. For a match to exist, an Agent must be connected and have reported inventory; offline inventory is excluded unless `includeOffline` is exactly `true`.

## Fetch online inventory into `getgenv()`

Add this export to a Server Script:

```lua
get_online_inventory = function(args)
    args = args or {}
    local items = Server.Items.getOnline(args.agentId)
    return {
        customGameId = Server.Game.customGameId,
        count = #items,
        items = items
    }
end
```

Call the export with the loaded API's `CONFIG.gamescope` as its Game Scope; no separate scope argument is needed:

```lua
local token = "YOUR_64_CHARACTER_API_TOKEN"
local ok, inventory = pcall(function()
    return AXION:FetchOnlineInventory(token)
end)

if not ok then
    warn("Online inventory fetch failed:", inventory)
    return
end

print("Game scope:", inventory.customGameId)
print("Online inventory items:", inventory.count)
for _, item in ipairs(inventory.items) do
    print(item.playerName, item.itemName, item.quantity)
end
```

`AXION:FetchOnlineInventory(token, agentId?)` is an HTTP fetch only: it calls the saved export, returns the result, and does not require `getgenv()`. The optional Agent ID filters online items to one Agent. Requests and responses are each limited to 16 KiB; oversized data raises an error rather than being truncated.

To report a configured inventory automatically, set `getgenv().AXIONInventory` in the client API environment. AXION includes it with the normal WebSocket heartbeat at `CONFIG.HeartbeatInterval` (10 seconds by default) and saves it to the Database for the local player's account in `CONFIG.gamescope`. No `FetchOnlineInventory` call is needed to report it. See [the client API heartbeat instructions](./client-api.md#send-inventory-automatically-with-heartbeats) for accepted formats and limits.

## APIs available inside Server Scripts

Only the following globals are currently added by the runtime:

### `Server.Items.search(query, includeOffline?)`

- `query`: required string; case-insensitive substring search on item names. Empty/whitespace text returns an empty list.
- `includeOffline`: optional boolean; offline caches are included only when this value is exactly `true`.
- Returns an array of:

```text
{
  playerId: string,       -- AXION Agent ID
  accountId: string,
  customGameId: string,
  playerName: string,
  itemName: string,
  itemId: string | null,
  category: string,
  quantity: number,
  online: boolean,
  updatedAt: number       -- Unix milliseconds
}
```

Throws if `query` is not a string. Results are scoped to `Server.Game.customGameId`.

### `Server.Items.getOnline(agentId?)`

- `agentId`: optional Agent ID string; when supplied, only that Agent's inventory is returned.
- Returns the same item record shape as `Server.Items.search`, but includes only currently connected Agents in the script's Game Scope.
- Returns an empty array when no matching online inventory is available.

Throws if `agentId` is supplied but is not a string.

### `Server.Players.isOnline(playerId)`

- `playerId`: Agent ID string from the WebSocket handshake.
- Returns a boolean. It is true only if that Agent is connected and has a cached workspace/inventory in this script's scope. Non-string IDs and Agents without a scoped cache return false.

```lua
return {
    check_online = function(args)
        args = args or {}
        local playerId = args.playerId
        if type(playerId) ~= "string" then
            error("playerId must be a string")
        end
        return {
            playerId = playerId,
            online = Server.Players.isOnline(playerId)
        }
    end
}
```

To call it, save the script and use:

```lua
local playerId = tostring(game:GetService("Players").LocalPlayer.UserId)
local token = "YOUR_64_CHARACTER_API_TOKEN"
local ok, result = pcall(function()
    return AXION:Fetch("check_online", { playerId = playerId }, token)
end)
if not ok then
    warn("Online check failed:", result)
else
    print(result.playerId, result.online)
end
```

### `Server.Game.customGameId`

Read-only string containing the scope assigned to the script. For example:

```lua
return {
    get_scope = function(_args)
        return { customGameId = Server.Game.customGameId }
    end
}
```

Save it and call `AXION:Fetch("get_scope", {}, token)` from the client as shown above.

## HTTP contract

`AXION:Fetch` sends a POST request to `http://localhost:CONFIG.ScriptApiPort/api/v1/call`. The configured port defaults to `5243`; use **Copy AXION API** after changing the port in AXION.

Request:

```http
POST /api/v1/call
Content-Type: application/json
Authorization: Bearer <64-character-token>
```

```json
{
  "functionName": "find_item",
  "customGameId": "MY_PROJECT",
  "args": { "query": "Example Item" }
}
```

Successful response:

```json
{
  "ok": true,
  "result": {
    "customGameId": "MY_PROJECT",
    "count": 1,
    "items": []
  }
}
```

Error response:

```json
{
  "ok": false,
  "error": "Server Script function \"find_item\" was not found in scope \"MY_PROJECT\"; loaded exports in that scope: none; loaded scopes: none"
}
```

When an export is missing, the error includes the requested scope, exports currently loaded in that scope, loaded scopes, and any errors encountered while reloading saved scripts. The request ID used between the Rust listener and Tauri events is internal; it is not a WebSocket JSON-RPC correlation ID exposed to the client.

## Runtime constraints

- Token: 32 cryptographically random bytes represented as 64 hexadecimal characters. AXION stores it in localStorage and passes it to the local listener; keep it private.
- Server Script source: maximum 64 KiB.
- Exports: maximum 64 named functions per source; function names use ASCII letters, digits, and `_`, beginning with a letter or `_`. Duplicate export names in the same scope are rejected.
- Lua function execution timeout: 4 seconds.
- HTTP call timeout: 5 seconds; minimum interval between requests is 500 ms.
- Request and response body: maximum 16 KiB.
- At most four HTTP connections are active simultaneously.
- Result must be JSON serializable; nil is returned as JSON null.

## Errors

`AXION:Fetch` raises on errors. Wrap it in `pcall` to handle them:

```lua
local ok, result = pcall(function()
    return AXION:Fetch("find_item", { query = "Example Item" }, "YOUR_64_CHARACTER_API_TOKEN")
end)
if not ok then
    warn("Fetch failed:", result)
else
    print(result.count)
end
```

Common HTTP statuses:

| Status | Meaning |
|---|---|
| 400 | Invalid JSON or malformed request |
| 401 | Invalid/missing API token |
| 404 | Unknown route |
| 413 | Request body or script result exceeds 16 KiB |
| 415 | Request is not `application/json` |
| 422 | Function missing, invalid scope/name, runtime/serialization error, or no response within 5 seconds |
| 429 | Request made less than 500 ms after a previous request |
| 503 | The API token is not initialized, or the active connection limit has been reached |

Use `AXION:FetchAsync` to run the blocking HTTP call in a separate task. Its callback receives `(result, nil)` on success or `(nil, error)` on failure.
