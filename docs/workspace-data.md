# Workspace & Data

Workspace reports are sent from the AXION client using `AXION:ReportWorkspace(data)`. AXION stores them locally under `Database/Workspace/{customGameId}/{accountId}.json` in its app data directory.

## Report data

```lua
local player = game:GetService("Players").LocalPlayer

AXION:ReportWorkspace({
    customGameId = AXION.gamescope,
    accountId = tostring(player.UserId) .. "_DOCS_TEST",
    world = "Example World",
    profile = {
        note = "Replace with profile fields your integration reads"
    },
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
```

The `_DOCS_TEST` suffix keeps this example separate from the real account file. The profile, progress, and inventory are test data. `world` must describe the current integration context; it is not inferred from a particular game.

## Stored schema

```json
{
  "meta": {
    "customGameId": "MY_PROJECT",
    "accountId": "account-123",
    "createdAt": 0,
    "updatedAt": 0
  },
  "session": {
    "agentId": "agent-123",
    "agentName": "Example Agent",
    "world": "Example World",
    "placeId": "12345",
    "jobId": "job-abc",
    "updatedAt": 0
  },
  "profile": {},
  "worldProgress": {
    "Example World": {}
  },
  "inventory": {
    "fruits": {},
    "swords": {},
    "guns": {},
    "accessories": {},
    "materials": {}
  }
}
```

## Update behavior

- `meta.customGameId` and `meta.accountId` identify the file.
- `session` is replaced by each accepted report. Its Agent identity/name and current place/job are taken from the active WebSocket connection; `world` comes from the report.
- `profile` changes only when the backend receives it. However, the current `AXION:ReportWorkspace` LocalScript fills in a missing `profile` as `{}` before sending, so omitting profile clears the saved profile.
- `worldProgress` is merged by world key; an existing entry remains unless that world key is supplied again.
- Inventory categories are merged independently. A category included in the report replaces that category; categories omitted from the report remain unchanged. Inventory item records may include an optional scalar `value` (string, number, or boolean), which is preserved and shown in the Database card.
- The bundled client sends `getgenv().AXIONInventory` as a full snapshot on the first heartbeat after connecting, then sends only changed field values, added items, and removals. Heartbeats with no inventory changes do not write an inventory report. Its comparison snapshot is per connection and bounded to the 500-item and 16 KiB limits. This automatic reporting does not use `AXION:FetchOnlineInventory`.
- Inventory category names are dynamic. Any valid category key in a report is created automatically and stored as an object keyed by item name; entry values are app-defined JSON data. Existing common categories (`fruits`, `swords`, `guns`, `accessories`, and `materials`) remain available by default.
- No `status` or `heartbeat` field is persisted in this schema.

## Limits and validation

- `customGameId` and `accountId`: 1–64 ASCII letters, digits, `_` or `-`.
- `world`: non-empty string, maximum 80 characters.
- Profile, progress, and inventory are object-shaped JSON values.
- At most 500 inventory entries per report and 1,000 cached account workspaces.
- WebSocket message size maximum is 16 KiB. Inventory reports have no time-based rate limit.

Category names must contain 1–64 Unicode code points. Emoji and non-ASCII scripts are supported; spaces and control characters are not. ASCII names may use only letters, digits, underscores, and hyphens. The client and server reject invalid names; valid new names are accepted and created automatically. Other validation or persistence errors are reported by AXION as an Agent protocol error. `ReportWorkspace` returns nil on a successful send and does not provide a client-side save acknowledgement. Confirm receipt in the Server Scripts cache view or app log.

## `AXION:ReportInventory(items)`

This compatibility method accepts a list of item records with `name`/`Name`, quantity/count aliases, and item ID aliases. It stores items under `inventory.materials`, uses the current `LocalPlayer.UserId` account ID, and calls `ReportWorkspace` without profile data.

**Important:** because `ReportWorkspace` defaults missing profile to `{}`, this helper clears the saved profile for that account. Use `ReportWorkspace` directly when you need a separate test account or want to preserve a profile.

## Reading workspace inventory in scripts

There is no API that reads an arbitrary workspace file by account ID. A Server Script can query the cached inventory exposed by [`Server.Items.search`](./server-scripts-api.md):

```lua
return {
    find_item = function(args)
        args = args or {}
        local items = Server.Items.search(args.query or "", args.includeOffline == true)
        return {
            customGameId = Server.Game.customGameId,
            count = #items,
            items = items
        }
    end
}
```

The search is restricted to the configured `gamescope` and excludes offline caches unless requested.
