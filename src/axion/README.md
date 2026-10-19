# AXION modular automation foundation

This package adds a modular runtime and an in-process Central matching engine without coupling game features to the dashboard UI. It reuses the transport boundary and mock transport from `src/lua-api`; no production backend or live game integration is introduced here.

## Structure

- `core/contracts.ts`: game, feature, lifecycle, and event contracts.
- `core/registries.ts`: script-ID-to-game and per-game feature registries.
- `core/ModuleLoader.ts`: dependency ordering, feature configuration, and lifecycle orchestration.
- `core/EventBus.ts`: scoped publish/subscribe communication between modules.
- `core/StateStore.ts` and `core/TaskManager.ts`: scope-keyed runtime state and explicit task lifecycle management. The task manager retains at most 100 terminal tasks by default; configure `maxTerminalTasks` to change the history limit. Active tasks are not evicted.
- `games/`: game-specific registrations and feature implementations. `games/example.ts` demonstrates AutoFarm, Race V4 Coordinator, Item Tracker, and Quest Manager as separate modules.
- `sdk/AXIONClient.ts`: typed host-side TypeScript facade; `lua-api/transport` supplies the mock adapter used for local integration.
- `central/MatchingEngine.ts`: transport-independent state freshness, condition matching, reservations, expiry, and cancellation.
- `tests/`: registry, lifecycle, SDK error handling, and matching tests.

Game IDs and script IDs identify a game; the matching engine operates on game IDs and never depends on script implementation details. Feature configuration is injected by feature ID at load time. Keep development config in app configuration, secrets in a secret provider, and runtime state in the agent/server runtime rather than module globals.

## Add a game

1. Create a game definition with a unique `id` and all supported script IDs.
2. Create a registration module that calls `GameRegistry.register`.
3. Register each feature separately through `FeatureRegistry.register(gameId, definition)`.
4. Construct a `ModuleLoader` for the application scope, then call `loadGame(gameId, featureConfig)` and `start()`.

The loader resolves declared dependencies, rejects missing dependencies and cycles, initializes in dependency order, and stops dependent features before their dependencies. Use `startFeature` and `stopFeature` to operate one feature and its dependency chain without starting unrelated modules.

## Add a feature

Implement `IGameFeature` (`initialize`, `start`, `stop`, `dispose`), then register a `FeatureDefinition` with a unique ID, optional dependencies, default config, and factory. Use the injected `FeatureContext.events` for cross-feature communication instead of importing another module directly. Test each lifecycle stage with a mock feature and event bus.

## Host SDK and wire safety

`AXIONClient` exposes `connect`, `report`, `request`, `on`, `getState`, `cancel`, and `disconnect` to the TypeScript host. It is not currently registered as a Lua global; the existing Wasmoon runtime exposes the separate `Core.*` surface from `src/lua-api` and does not bridge Promise results to Lua. Envelopes use the existing protocol version, request correlation IDs, and caller-selected timeouts. `sdk/protocol.ts` defines task request/response/failure payloads; inbound task responses are validated before resolving a request. The SDK owns payload shaping and transport use; matching policy belongs to Central. Central-to-agent messages must remain schema-validated task/event data: do not add a command that evaluates Lua received from the server.

## Matching flow

1. Agents report their game, state, and inventory with `updateAgent`.
2. `requestMatch` immediately returns `no_match` unless enough fresh, online, unreserved agents satisfy the same game/state/inventory criteria.
3. On a match, the engine creates a match ID and expiry and reserves the selected agents atomically within the engine call.
4. Agents may be released by `cancelTask`; scheduled callers should invoke `sweepExpired` periodically. Reads and matching requests also sweep stale agents and expired reservations lazily.

This deterministic engine can be tested without a game or network connection. A production server should invoke the same domain engine from its selected transport handler rather than putting matching rules in a WebSocket adapter.

## Verification

Run `npm test` and `npm run typecheck` from the project root.
