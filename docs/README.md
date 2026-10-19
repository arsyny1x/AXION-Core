# AXION API Documentation

Use the guide that matches the work you are doing:

1. [Getting started and Core AXION API](./client-api.md) — load the client library and call its implemented methods.
2. [Server Scripts API](./server-scripts-api.md) — create Wasmoon functions and invoke them with `AXION:Fetch` / `AXION:FetchAsync`.
3. [Workspace & data](./workspace-data.md) — report data and understand the persisted workspace schema.
4. [WebSocket protocol](./websocket-protocol.md) — integrate directly with the local transport.

The guides describe the current source implementation. They do not promise unimplemented features such as JSON-RPC, workspace read-by-account, automatic reconnect, server hopping, or game-specific functions.

## Requirements

- Run the AXION Core Tauri desktop app on the same computer as the AXION client runtime.
- The client environment must support the WebSocket API expected by `lua/AXION api.lua`; `AXION:Fetch` additionally requires the executor's `request` function to reach localhost.
- To use `AXION:Fetch`, save a Server Script in AXION, use a matching `gamescope`, and copy the API token from **Server Scripts**.
- `gamescope` and `world` identify an integration's data; no particular scope is required by the API.

The in-app **API Docs** page provides the same topics as separate selectable sections, including copyable examples.
