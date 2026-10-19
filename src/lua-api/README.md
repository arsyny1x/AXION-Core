# `Core.*` Lua API and host integration contract

This module builds the per-script `Core` global and provides the mock transport,
Lua runtime adapters, validation, and script lifecycle manager. It does not
provide a deployed Central Server, persistence, matching policy, or a task
scheduler.

## Runtime status and async boundary

`createLuaApiModule` creates the `Core.*` host API. `WasmoonLuaRuntime` registers
the JavaScript API objects directly with each Lua engine; it does not currently
adapt JavaScript `Promise` values to an awaitable Lua API. Consequently,
Promise-returning methods below are host-side integration methods: call and
await them from TypeScript rather than treating their return values as Lua
results.

The separate `src/axion/sdk/AXIONClient.ts` implements the host-side AXION
transport facade. It is not registered as a Lua global named `AXION`. See
[`../axion/README.md`](../axion/README.md) for the modular game system,
matching engine, and SDK contract.

## Create and wire the module

```ts
import {
  createLuaApiModule,
  MockCoreTransport,
  MockLuaRuntime,
} from "./src/lua-api";

const transport = new MockCoreTransport();
const module = createLuaApiModule({
  transport,
  luaRuntime: new MockLuaRuntime(),
  defaultConfig: { worker: { region: "apac" } },
});

await module.transport.connect({});
await module.client.register({ name: "Worker-01" });
```

The app currently uses `MockCoreTransport`, which only records messages and
simulates connection events; it is not a server. `taskService` is optional at
construction and must be provided by the host to enable task lifecycle
operations.

## Public `CoreGlobal`

The Lua-facing object has eight namespaces: `client`, `status`, `tasks`,
`events`, `log`, `config`, `utils`, and `custom`.

### `Core.client`

`register(options)` returns `Promise<ClientInfo>`, requires an already connected
transport, and defaults to a 15-second send timeout. Registration tracks the
client locally after the register message is sent; this module does not wait
for a Central Server registration acknowledgement. `unregister()` is also
asynchronous and sends an unregister message, but does not disconnect the
transport.

Synchronous reads are `getId()`, `getInfo()`, `getConnectionState()`, and
`getCapabilities()`. `updateMetadata(metadata)` updates local client metadata.
The returned `ClientInfo` contains `id`, `name`, `capabilities`, `metadata`,
`connectionState`, and nullable `registeredAt`.

### `Core.status`

`update`, `get`, `setState`, `setProgress`, and `setMessage` are synchronous.
Progress must be finite and between 0 and 100; state must be one of
`initializing`, `ready`, `busy`, `paused`, `error`, or `disconnected`.
The latest status is cached locally. When connected it is sent as
`client.status`; transport-send failure is not reported to the caller.

### `Core.tasks`

This is a thin facade over the optional `ITaskService` injected by the host.
`getCurrent`, `getQueue`, `getById`, `reportProgress`, `reportSuccess`,
`reportFailure`, and `cancel` return Promises. `isCancelled` is synchronous.
Progress must be between 0 and 100, and task errors have `code`, `message`,
and optional `details`.

Without `taskService`, reads return `null`/`[]`, `isCancelled` returns `false`,
and mutations reject with `INVALID_STATE`. This module does not assign, match,
or schedule tasks.

### `Core.events`

`on` and `once` return unsubscribe functions; `off` removes a listener.
Registering the same callback twice for the same event is rejected. `emit`
allows local custom events but rejects reserved Core event names. `getAvailableEvents`
lists reserved event names and custom names known to that event bus.

The host-level `module.events` bus receives transport events. Each Lua script
gets a separate `Core.events` bus, but those per-script buses are not currently
bridged to `module.events`; Lua scripts can use their bus for local custom
events only. The host may subscribe directly to `module.events` in TypeScript.

Reserved names are declared in `CORE_EVENTS` in `types.ts`. The host-level
module bus currently dispatches `client.connected`, `client.disconnected`, `client.registered`,
`task.assigned`, `task.updated`, `task.cancelled`, `core.status`, `core.error`,
`player.connected`, `player.disconnected`, `player.updated`, and `player.list`.
Connection events require a transport adapter that implements the optional
`onStateChange` subscription.
`task.completed` and `task.failed` are reserved names but are not currently
dispatched by the transport-to-Core adapter.

### `Core.log`

`debug`, `info`, `warn`, and `error` are synchronous. Records contain timestamp,
level, script ID, message, and optional metadata. The host-provided logger
receives records; without one, records are held in a bounded in-memory buffer
(default capacity 1000). Buffer drain/inspection are host implementation
helpers, not part of `ILogApi`.

### `Core.config`

`get`, `getAll`, `has`, and `set` are synchronous. Reads combine host defaults
with per-script overrides. `set` writes an override only, rejects non-finite
numbers and top-level function/symbol values, validates objects, and throws
`PROTECTED_CONFIG` for protected keys. The default protected roots are `system`, `transport`, `auth`,
`security`, `permissions`, `centralCore`, and `protocolVersion`.

### `Core.utils`

`now`, `uuid`, `clamp`, and `isValid` are synchronous. `sleep(milliseconds)`
returns a Promise and is not awaitable from raw Lua in the current binding.
`isValid` accepts the `ValidationSchema` shape from `types.ts`.

### `Core.custom`

`registerFunction`, `unregisterFunction`, `listFunctions`, and
`getFunctionInfo` are exposed on the public API. Function names must be unique
within the scope and cannot start with reserved prefixes `__` or `Core.`.
Permissions are checked by the host-side `invoke` extension, which is not a
method on the public `ICustomApi`/`CoreGlobal` interface. Registration alone
does not expose an unrestricted server command or evaluate received Lua.

## Transport contract

`ICoreTransport` abstracts `connect`, `disconnect`, `send`, message
subscriptions, and connection state. Envelopes have `id`, `type`, `timestamp`,
`protocolVersion` (`1.0.0`), `payload`, and optional `clientId` /
`correlationId`. The Lua API module routes supported inbound message types to
Core events. Matching rules belong in the Central domain layer, not in the
transport adapter.

## Error handling

Core API and AXION SDK validation/protocol errors use `LuaApiError` with a
stable `code`, human-readable `message`, and optional `details`. A transport
adapter may reject with its own error type. Promise rejections must be caught
by TypeScript callers. The Wasmoon binding currently does not convert Promise
rejections into Lua `pcall` errors.

The complete error-code union is `LuaApiErrorCode` in `errors.ts`. Input
validation errors use `INVALID_ARGUMENT`; missing task-service mutations use
`INVALID_STATE`; transport, timeout, permission, config, runtime, and script
failures use their corresponding specific codes.

## Tests

Run `npm test` for the Lua API and AXION unit tests, or
`npm run typecheck` to validate the TypeScript contracts.
