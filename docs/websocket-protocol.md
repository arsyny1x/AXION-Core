# WebSocket Protocol

This guide is for custom integrations that need to speak directly to AXION Core. Most LocalScript users should use the [Core AXION API](./client-api.md), which creates these messages.

## Connection

The WebSocket listener binds to `127.0.0.1` on port `5242` by default. Change the port in **Server Scripts > WebSocket Host port**. The listener stays on loopback; it is not exposed for remote connections.

A client using the default port connects to:

```text
ws://localhost:5242/AXION?name=<agent-name>&id=<agent-id>&jobId=<job-id>
```

The listener validates the route and required identity query values. Keep the client and AXION on the same computer; the listener is loopback-only.

## Envelope

Client text frames are JSON objects with a `Name` string and optional `Payload`. Binary frames using AXIB version 1 are also accepted. Both formats are one-way messages; the current protocol is not JSON-RPC and has no request ID, method/result envelope, or correlated response.

Each object below is an individual WebSocket text frame (shown together as an array only for readability):

```json
[
  { "Name": "ping" },
  { "Name": "Log", "Payload": { "Content": "ready" } },
  { "Name": "SetPlaceId", "Payload": { "Content": 12345 } },
  { "Name": "SetJobId", "Payload": { "Content": "job-abc" } },
  {
    "Name": "InventoryUpdate",
    "Payload": {
      "customGameId": "MY_PROJECT",
      "accountId": "account-123",
      "world": "Example World",
      "profile": { "level": 10 },
      "worldProgress": { "Example World": { "visited": true } },
      "inventory": {
        "materials": {
          "Example Item": { "quantity": 2, "itemId": "example-item" }
        }
      }
    }
  }
]
```

Supported client-to-AXION names are `ping`, `Log`, `SetPlaceId`, `SetJobId`, `Echo`, and `InventoryUpdate`.

## Binary frames

AXIB v1 encodes the same envelope and JSON-compatible values as the text protocol. The frame starts with the four bytes `AXIB` followed by version byte `1`. Values use a one-byte type tag: `0` null, `1` false, `2` true, `3` little-endian f64, `4` UTF-8 string followed by a little-endian u32 byte length, `5` array followed by a little-endian u32 element count, and `6` object followed by a little-endian u32 pair count. Object keys are encoded as strings. Frames are subject to the same 16 KiB and structural limits as text messages.

The bundled Lua API currently sends JSON text heartbeats. Binary support is retained for custom clients, but executor WebSocket `Send(buffer)` compatibility must be verified before enabling binary heartbeats in the bundled client. Other `AXION:Send` messages remain JSON.

## Message behavior

| Name | Payload | Implemented behavior |
|---|---|---|
| `ping` | optional | Updates live Agent last-seen time and receives `{"Name":"pong"}` from AXION. |
| `Log` | `Content: string` | Emits an app log event. |
| `SetPlaceId` | `Content: string \| number` | Updates the live Agent place ID used by subsequent workspace reports. |
| `SetJobId` | `Content: string \| number` | Updates the live Agent job ID used by subsequent workspace reports. |
| `Echo` | any JSON-compatible `Content` | Emits an app event; the client gets no reply. |
| `InventoryUpdate` | workspace report object | Validates and persists the report. See [Workspace & data](./workspace-data.md). |

The current AXION LocalScript sends `ping` every 10 seconds and accepts either the JSON pong packet or plain `pong`. It does not time out or reconnect automatically if a pong is absent. The backend emits heartbeat UI updates at most every 10 seconds.

For automatic inventory sync, the bundled Lua client sends a full `inventorySnapshot` on the first heartbeat after connecting. Later heartbeat reports set `inventoryDelta: true`, put only changed leaf values in `inventoryChanges`, and use `inventoryRemoved` for whole items that were deleted. A change contains `category`, `name`, a string-key `path`, and either `value` or `remove: true`. The backend patches the stored item, preserving all unchanged fields. Heartbeats with no inventory changes omit the workspace payload.

## Workspace packet context

The initial handshake supplies Agent ID, Agent name, and job ID. Place ID is updated separately through `SetPlaceId`. `customGameId`, `accountId`, `world`, `profile`, `worldProgress`, and `inventory` are supplied by `InventoryUpdate`; they are not attached to every message.

The persisted workspace has `meta`, `session`, `profile`, `worldProgress`, and `inventory`; it does not contain persisted `status` or `heartbeat` fields. Required report values, merge behavior, and limits are in [Workspace & data](./workspace-data.md).

## AXION-to-client messages

The current `execute` action sends a plain-text command:

```text
execute <source>
```

The AXION LocalScript runs the source using `loadstring` and reports output/error as `Log`. This is remote code execution: only connect a trusted local app and a trusted operator.

The LocalScript also defines plain-text handlers for `teleport`, `rejoin`, `mute`, `unmute`, and `performance`. These are not JSON RPC methods and the dashboard does not provide an arbitrary custom command sender.

The dashboard's Kill Instance action currently sends a JSON `KillInstance` packet, while the LocalScript command parser expects plain text and has no `KillInstance` handler. Do not treat this action as a working protocol command.

## Limits

- Maximum WebSocket message size: 16 KiB.
- Inventory cache update logs report the encoded inbound message size (including the AXIB header for binary frames) against this limit.
- Inventory reports have no time-based rate limit.
- Invalid packet shapes and unsupported names emit an Agent protocol error.

## Separate HTTP API

`AXION:Fetch` does not use this WebSocket. It uses `POST http://localhost:CONFIG.ScriptApiPort/api/v1/call` with a bearer token and JSON request/response. See [Server Scripts API](./server-scripts-api.md).
