# Getting Started and Core AXION API

This is the client-side API from [`lua/AXION api.lua`](../lua/AXION%20api.lua). Run it in the Lua executor environment used by the integration, not in Roblox `ServerScriptService`. AXION must be running on the same computer. The bundled API attempts to connect to `localhost:5242` at startup by default, unless `AXION_Version` is truthy in the executor environment. If the WebSocket port is changed on the **Server Scripts** page, copy the updated client API there and reconnect the client. Loading a new copy first calls `Stop()` on an existing global `AXION` instance.

`CONFIG.gamescope` is a configurable data scope, not a game requirement. `AXION:Fetch` uses this configured scope to select saved Server Script functions. `CONFIG.WebSocketHost` is the local WebSocket port number; the client connects to `localhost:<port>`.

## Quick start: report workspace data

This example writes to a separate account ID ending in `_DOCS_TEST`, avoiding an overwrite of the current account's workspace. The sample profile and item are test data. Replace them with values your integration actually reads.

```lua
local player = game:GetService("Players").LocalPlayer

local ok, err = pcall(function()
    AXION:ReportWorkspace({
        customGameId = AXION.gamescope,
        accountId = tostring(player.UserId) .. "_DOCS_TEST",
        world = "Example World",
        profile = { note = "test data" },
        worldProgress = {
            ["Example World"] = { visited = true }
        },
        inventory = {
            fruits = {},
            swords = {},
            guns = {},
            accessories = {},
            materials = {
                ["Example Item"] = { quantity = 2, itemId = "example-item" }
            }
        }
    })
end)

if ok then
    print("Report sent; confirm it in AXION > Server Scripts")
else
    warn("Report failed:", err)
end
```

`ReportWorkspace` sends a one-way message. A successful return means the client sent it; verify backend persistence in AXION's Server Scripts cache/status.

### Create and use custom inventory categories

Inventory category names are not restricted to the built-in examples. Use 1–64 Unicode characters; emojis and non-ASCII scripts are supported, but spaces and control characters are not. ASCII names may use letters, digits, underscores, and hyphens. AXION automatically creates valid new categories when it receives the report. For example, this report creates `pets` and `raid_rewards`:

```lua
local player = game:GetService("Players").LocalPlayer

AXION:ReportWorkspace({
    customGameId = AXION.gamescope,
    accountId = tostring(player.UserId) .. "_DOCS_TEST",
    world = "Example World",
    profile = { note = "Documentation example" },
    inventory = {
        pets = {
            ["Example Pet"] = { quantity = 1, itemId = "pet-001" }
        },
        raid_rewards = {
            ["Reward Chest"] = { quantity = 2 }
        }
    }
})
```

Category values must be objects keyed by item name. When a report includes an existing category, its contents are replaced; categories omitted from the report are preserved. Because `ReportWorkspace` defaults an omitted `profile` to `{}`, include the profile you want to keep or use a separate `accountId` for test reports. Confirm that the report arrived in AXION's Server Scripts inventory cache; a successful client return is not a save acknowledgement.

### Send inventory automatically with heartbeats

To keep a player's inventory in the local Database without repeatedly calling `ReportInventory` or `ReportWorkspace`, set `getgenv().AXIONInventory` once. While connected, the AXION API reads it on each regular WebSocket heartbeat at `CONFIG.HeartbeatInterval` (10 seconds by default). The first heartbeat after each connection sends a full inventory snapshot; subsequent heartbeats send only changed field values, added items, and removals. Heartbeats with no inventory changes omit inventory data. The bundled API sends heartbeats as JSON text; the backend also accepts AXIB v1 binary frames from custom clients. The report is saved under the configured `gamescope` and the local player's account ID. The value can be either a list of item records or the category-keyed format used by `ReportWorkspace`.

```lua
getgenv().AXIONInventory = {
    { name = "Potion", quantity = 2, category = "materials" },
    { name = "Iron Ore", quantity = 15, category = "materials" }
}
```

For custom categories, each list item can specify a valid `category`; an omitted category defaults to `materials`. List records accept `name`/`Name`, `category`/`Category`, `quantity`/`Quantity`/`count`/`Count`, `itemId`/`ItemId`, and `value`/`Value`. Names must contain 1–80 bytes; quantities must be integers from 0 to 1,000,000,000; IDs are optional strings up to 128 bytes; and values must be strings, numbers, or booleans. Category-keyed inventory uses item names as keys and table values as item details. In-place changes to the table are detected on the next heartbeat.

The client keeps a bounded per-connection comparison snapshot: at most 500 items and 500 categories, 4,096 counted nodes, and a 64 KiB state budget. Nested data is limited to 32 levels, must be acyclic and JSON-compatible, and numbers must be finite. The snapshot is discarded when the connection ends. Heartbeat messages, including any inventory, are limited to 16 KiB; if inventory is too large or invalid, AXION logs the issue and continues sending a normal heartbeat without the inventory. If a delta does not fit but the full snapshot does, the client retries that heartbeat using the full snapshot.

## API reference

| API | Parameters | Return |
|---|---|---|
| `AXION:Connect(host?, bypass?)` | `host`: optional complete WebSocket host (for example `localhost:5242`); `bypass`: optional boolean to skip the duplicate-connection guard. | Returns a status string when already connecting/connected and `bypass` is false; otherwise nil when the attempt/connection loop ends. Without `host`, connects to `localhost:CONFIG.WebSocketHost`. A successful connection waits in its heartbeat loop and reports `game.PlaceId` automatically. |
| `AXION:Stop()` | None. | nil. Stops heartbeat, closes the socket, fires `Disconnected` even if already disconnected, and marks this API instance terminated. Reload the API to start a fresh connection. |
| `AXION:Send(command, payload?)` | `command`: one of `ping`, `Log`, `SetPlaceId`, `SetJobId`, `Echo`, `InventoryUpdate`; `payload`: optional table. | nil. One-way JSON WebSocket message. |
| `AXION:Log(...)` | Any values, converted with `tostring`. | nil. Sends a `Log` packet and prints locally when debug is enabled. |
| `AXION:Echo(message)` | `message`: serialized into `Payload.Content`. | nil. Emits an app event; it has no client reply. |
| `AXION:SetPlaceId(placeId)` | String or number. | nil. Updates the connected Agent's live place metadata. |
| `AXION:SetJobId(jobId)` | String or number. | nil. Updates the connected Agent's live job metadata. |
| `AXION:ReportWorkspace(data)` | Required `data` table; `customGameId` defaults to `CONFIG.gamescope`, `accountId` to LocalPlayer.UserId, and `world` to `"Unknown"`. See [Workspace & data](./workspace-data.md) for field behavior. | nil; no save acknowledgement is returned to the client. |
| `AXION:ReportInventory(items)` | Table of item records with `name`/`Name`, optional quantity/count aliases (default 1), and optional item ID aliases. Non-table entries and entries without a non-empty string name are ignored. | nil. Compatibility wrapper for reporting a materials list; resets the saved profile to `{}` through `ReportWorkspace`. |
| `AXION:Fetch(functionName, arguments?, token)` | Required function name and token; optional JSON-compatible argument table. | The exported Server Script result, JSON-compatible. See [Server Scripts API](./server-scripts-api.md). |
| `AXION:FetchAsync(functionName, arguments?, token, callback)` | Same as `Fetch`, plus required callback. | `task.spawn` thread. Callback receives `(result, nil)` or `(nil, error)`. |
| `AXION:FetchOnlineInventory(token, agentId?)` | Required API token; optional Agent ID filter. Requires a `get_online_inventory` Server Script export. | Calls the export and returns its result. This is a separate HTTP fetch; it does not send `AXIONInventory`, which is sent automatically with WebSocket heartbeats. Subject to the 16 KiB request and response limits. |
| `AXION:AddCommand(name, callback)` | Command name and handler function receiving one string payload. | nil. Registers/replaces a plain-text command handler; replacing a built-in name replaces that handler. |
| `AXION:RemoveCommand(name)` | Registered command key. | nil. Removes that handler; removing a built-in command disables it for this instance. |
| `performance(fps?)` | Optional string or number FPS target while the window is unfocused. | nil. Global alias for the built-in performance handler. Only its first call has an effect in each API instance. |

`Send`, `Log`, `Echo`, `SetPlaceId`, `SetJobId`, `ReportWorkspace`, and `ReportInventory` require an active WebSocket connection. `Fetch` and `FetchOnlineInventory` use HTTP instead. Methods raise Lua errors for validation, encoding, connection, or send failures; use `pcall` when the caller must handle failures. Encoded WebSocket messages are limited to 16 KiB. Workspace reports are one-way: a successful client return confirms the send, not backend validation or persistence.

### Configuration

These are the defaults in the bundled Lua file. Edit the `CONFIG` table near the top of that file before loading it.

| Setting | Default | Behavior |
|---|---:|---|
| `WebSocketHost` | `5242` | Local WebSocket port. Must be an integer from 1 to 65535. |
| `AutoConnect` | `true` | Attempts a connection after initialization only if `AXION_Version` is nil or false. |
| `HeartbeatInterval` | `10` | Seconds between heartbeat messages. |
| `gamescope` | `"AXION_TEST"` | Default workspace and Server Scripts scope; copied to `AXION.gamescope`. |
| `ScriptApiPort` | `5243` | Local HTTP port used by `Fetch`. |
| `ShutdownTime` | `45` | Delay before `game:Shutdown()` for qualifying connection errors. Also exposed as `AXION.ShutdownTime`. |
| `ShutdownOnTeleportError` | `true` | When false, suppresses shutdown for error codes greater than `PlaceLaunchOtherError`; also exposed as `AXION.ShutdownOnTeleportError`. |
| `AutoShutdownOnLoadFail` | `true` | Schedules a startup check that shuts down if loading has not completed or a disconnect error is present. |
| `LoadTimeout` | `60` | Seconds before the startup load check runs. |
| `DefaultFPS` | `8` | FPS target used by the performance command while unfocused when no valid target is supplied. |
| `NormalFPS` | `60` | FPS target used when the game window regains focus in performance mode. |
| `Debug` | `true` | Prints connection errors and `AXION:Log` messages to the executor console. |

The startup load wait happens before AXION services and methods are initialized. The global `NoShutdown` flag suppresses the load-timeout and delayed connection-error shutdown handlers when set.

### Connection example

`AutoConnect` defaults to true. This code avoids starting a second connection when the API has already connected. `Connect` is yielding while the connection is active, so call it from a task.

```lua
if AXION.IsConnected or AXION.Connecting then
    print("AXION is already connected or connecting")
else
    task.spawn(function()
        local message = AXION:Connect("localhost:5242")
        print(message or "AXION connection attempt ended")
    end)
end
```

The current implementation does not automatically retry after a real disconnect.

### Send/log helpers

```lua
local ok, err = pcall(function()
    AXION:Log("Integration ready", "place =", game.PlaceId)
    AXION:SetPlaceId(game.PlaceId)
    AXION:SetJobId(game.JobId)
    AXION:Echo("ready")
end)

if not ok then
    warn("AXION send failed:", err)
end
```

### Signals and custom commands

The API exposes `AXION.Connected`, `AXION.Disconnected`, and `AXION.MessageReceived`. Each signal supports `:Connect(callback)`, `:Wait()`, and `:Disconnect()`; the last method destroys the signal object itself. `:Connect` returns a normal connection that can be disconnected independently.

```lua
task.spawn(function()
    local message = AXION.MessageReceived:Wait()
    print("First non-pong message:", message)
end)
```

Avoid calling `:Disconnect()` on the shared AXION signals: it destroys the event object and the message signal also owns the internal command dispatcher. Disconnect only the connection handle returned by `:Connect`.

The client also exposes these state fields:

| Property | Type | Meaning |
|---|---|---|
| `AXION.gamescope` | string | Game scope copied from `CONFIG.gamescope`. |
| `AXION.IsConnected` | boolean or nil | True while the socket is active; false after disconnect; nil before first attempt. |
| `AXION.Connecting` | boolean or nil | True during connection attempt/heartbeat loop. |
| `AXION.Terminated` | boolean or nil | Set true by `Stop`; a stopped instance does not reconnect. |
| `AXION.Commands` | table | Map of registered command handlers. |
| `AXION.Connections` | table | WebSocket listener connection handles managed by the API. |
| `AXION.Socket` | WebSocket or nil | Current socket while connected. |
| `AXION.ShutdownTime` | number | Delayed shutdown duration, copied from CONFIG. |
| `AXION.ShutdownOnTeleportError` | boolean | Teleport-error shutdown behavior, copied from CONFIG. |
| `performance` | function | Global alias for `AXION.Commands.performance`; changes local rendering/FPS settings. |

### Built-in commands

The message dispatcher handles incoming plain-text commands after firing `MessageReceived`. For a message containing a space, it lowercases the first word as the command name and passes the rest as one string. Without a space, it looks up the full message verbatim. Handler failures are logged with `AXION:Log`.

| Command | Behavior |
|---|---|
| `execute <lua>` | Compiles and runs the supplied Lua code. Its `print` output and errors are sent to the AXION log. |
| `teleport <placeId> [jobId]` | Teleports to a place, optionally to a specified job instance. |
| `rejoin` | Teleports back to the current place and job instance. |
| `mute` / `unmute` | Mutes master volume and restores the last remembered volume. |
| `performance [fps]` | Disables 3D rendering and lowers quality while unfocused; restores rendering and `NormalFPS` when focused. It activates only once per API instance. |

`AXION:AddCommand` registers a handler for the same incoming plain-text dispatcher, not a JSON-RPC method. The app does not currently expose an arbitrary custom-command sender.

### Performance mode

This built-in command is executor-specific and changes local graphics settings. The first call disables 3D rendering and lowers quality; focusing the window restores rendering and uses `CONFIG.NormalFPS`. Further calls are ignored for that API instance.

```lua
if type(performance) == "function" then
    performance("8")
else
    warn("AXION performance alias is unavailable")
end
```

```lua
local connection = AXION.Connected:Connect(function()
    print("AXION connected")
end)

-- Later, when this listener is no longer needed:
-- connection:Disconnect()
```

`AXION:AddCommand` registers a handler for incoming plain text, not a JSON-RPC method. The app does not currently expose an arbitrary custom-command sender.

```lua
local name = "docs_status"
AXION:AddCommand(name, function(message)
    print("Command payload:", message)
end)

-- Local self-test of the registered callback:
AXION.Commands[name]("test")
AXION:RemoveCommand(name)
```

## Errors

- `websocket not connected`: start AXION, load the API, and wait for connection before sending.
- `Unsupported AXION command`: only `ping`, `Log`, `SetPlaceId`, `SetJobId`, `Echo`, and `InventoryUpdate` are accepted by `Send`.
- Workspace reports have no time-based rate limit, but must satisfy the backend schema; details are in [Workspace & data](./workspace-data.md).
- `Fetch` raises on HTTP errors. Use `pcall`; use `FetchAsync` for callback-based execution. See [Server Scripts API](./server-scripts-api.md#errors).
- `Stop` terminates the connection; there is no automatic reconnection.
