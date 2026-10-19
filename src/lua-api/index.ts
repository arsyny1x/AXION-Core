/**
 * Custom Lua API module — public entry point.
 *
 * Usage:
 *
 *   import {
 *     createLuaApiModule,
 *     MockCoreTransport,
 *     MockLuaRuntime,
 *   } from "./modules/lua-api";
 *
 *   const module = createLuaApiModule({
 *     transport: new MockCoreTransport(),
 *     luaRuntime: new MockLuaRuntime(),
 *   });
 *
 *   await module.transport.connect({});
 *   await module.client.register({ name: "Worker-01" });
 *
 * See README.md for the full integration contract.
 */

import { createClientApi } from "./api/client";
import { createConfigApi, defaultProtectedKeys } from "./api/config";
import { createCustomApi } from "./api/custom";
import { EventBus } from "./api/events";
import { createLogApi } from "./api/log";
import { createStatusApi } from "./api/status";
import { createTasksApi } from "./api/tasks";
import { createUtilsApi, defaultUuid } from "./api/utils";
import { err, LuaApiError } from "./errors";
import { createScriptManager } from "./scripts/ScriptManager";
import type { IScriptManager } from "./scripts/ScriptTypes";
import type { ILuaRuntime } from "./runtime/ILuaRuntime";
import type { ICoreTransport } from "./transport/ICoreTransport";
import type {
  ConfigSchema,
  CoreGlobal,
  IClientApi,
  IConfigApi,
  ICustomApi,
  IEventsApi,
  ILogApi,
  ILogger,
  IPermissionChecker,
  IStatusApi,
  ITaskService,
  ITasksApi,
  IUtilsApi,
  StatusSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// Public types re-exported for integrators.
// ---------------------------------------------------------------------------

export * from "./types";
export * from "./errors";
export type { ILuaRuntime, LuaRuntimeState, LuaScriptMetadata, LuaRuntimeInitializeOptions } from "./runtime/ILuaRuntime";
export { LUA_RUNTIME_STATES } from "./runtime/ILuaRuntime";
export { MockLuaRuntime } from "./runtime/MockLuaRuntime";
export type {
  ICoreTransport,
  CoreMessageEnvelope,
  CoreMessageType,
  TransportConnectOptions,
  TransportMessageHandler,
  TransportStateHandler,
} from "./transport/ICoreTransport";
export { PROTOCOL_VERSION, createEnvelope } from "./transport/ICoreTransport";
export { MockCoreTransport } from "./transport/MockCoreTransport";
export type { IScriptManager, ScriptDescriptor, ScriptRecord } from "./scripts/ScriptTypes";
export { createScriptManager } from "./scripts/ScriptManager";
export { EventBus, createEventsApi } from "./api/events";
export { createClientApi } from "./api/client";
export { createStatusApi } from "./api/status";
export { createTasksApi } from "./api/tasks";
export { createLogApi } from "./api/log";
export { createConfigApi, defaultProtectedKeys } from "./api/config";
export { createUtilsApi, defaultUuid } from "./api/utils";
export { createCustomApi } from "./api/custom";
export * from "./validation/validators";

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

export interface LuaApiModuleOptions {
  /** Required. Supplies the outbound/inbound message channel. */
  transport: ICoreTransport;
  /** Required. Supplies the Lua interpreter (or a mock for tests). */
  luaRuntime: ILuaRuntime;
  /** Optional. Forwards `Core.log` records to the host application. */
  logger?: ILogger;
  /** Optional. Default config exposed through `Core.config`. */
  defaultConfig?: ConfigSchema;
  /** Optional. Keys scripts are forbidden to write. Defaults to a safe set. */
  protectedConfigKeys?: readonly string[];
  /** Optional. Task lifecycle service from the Central Core. */
  taskService?: ITaskService;
  /** Optional. Permission checker for `Core.custom` functions. */
  permissions?: IPermissionChecker;
  /** Optional. Injectable clock (for deterministic tests). */
  now?: () => number;
  /** Optional. Injectable UUID generator (for deterministic tests). */
  uuid?: () => string;
  /** Optional. Timeout for registration/transport operations (ms). */
  registerTimeoutMs?: number;
}

export interface LuaApiModule extends CoreGlobal {
  /** Script lifecycle manager. */
  readonly scripts: IScriptManager;
  /** Underlying runtime (for advanced integrations/tests). */
  readonly runtime: ILuaRuntime;
  /** Underlying transport (for advanced integrations/tests). */
  readonly transport: ICoreTransport;
  /** Build the Lua-facing `Core` global (aggregate of the API objects). */
  buildCoreGlobal(): CoreGlobal;
  /** Register a per-script `Core` global with the runtime, when supported. */
  registerCoreGlobalForScript(scriptId: string): void;
  /** Release timers, listeners, and runtime resources. */
  dispose(): Promise<void>;
}

export function createLuaApiModule(options: LuaApiModuleOptions): LuaApiModule {
  const now = options.now ?? (() => Date.now());
  const uuid = options.uuid ?? defaultUuid;
  const logger = options.logger;

  // Shared event bus — dispatches core events to the module's own listeners.
  const sharedEvents = new EventBus();

  const sharedLog = createLogApi({ logger, scriptId: null, now });

  const client = createClientApi({
    transport: options.transport,
    events: sharedEvents,
    log: {
      info: (m) => sharedLog.info(m),
      warn: (m) => sharedLog.warn(m),
      error: (m) => sharedLog.error(m),
    },
    now,
    uuid,
    registerTimeoutMs: options.registerTimeoutMs,
  });

  const status = createStatusApi({
    transport: options.transport,
    now,
    uuid,
    clientId: () => client.getId(),
    onChanged: (snapshot: StatusSnapshot) => {
      sharedEvents.dispatch("core.status", snapshot);
    },
  });

  const tasks = createTasksApi(options.taskService);

  const config = createConfigApi({
    defaults: options.defaultConfig ?? {},
    protectedKeys: options.protectedConfigKeys ?? defaultProtectedKeys(),
    scriptId: null,
  });

  const utils = createUtilsApi({ now, uuid });

  const custom = createCustomApi({ permissions: options.permissions, now });

  const core: CoreGlobal = {
    client,
    status,
    tasks,
    events: sharedEvents,
    log: sharedLog,
    config,
    utils,
    custom,
  };

  // Script manager: builds an isolated Core scope per script.
  const scripts = createScriptManager({
    runtime: options.luaRuntime,
    events: sharedEvents,
    log: {
      info: (m, meta) => sharedLog.info(m, meta),
      warn: (m) => sharedLog.warn(m),
      error: (m) => sharedLog.error(m),
    },
    createCoreScope: (scriptId) => buildScriptScope(scriptId, core, options, now, uuid),
  });

  // Wire transport → core events.
  const offMessage = options.transport.onMessage((message) => {
    handleInbound(message, sharedEvents);
  });
  const offState = options.transport.onStateChange?.((state) => {
    if (state === "connected") sharedEvents.dispatch("client.connected", { state });
    else if (state === "disconnected") sharedEvents.dispatch("client.disconnected", { state });
  });

  return {
    ...core,
    scripts,
    runtime: options.luaRuntime,
    transport: options.transport,
    buildCoreGlobal: () => buildScriptScope(null, core, options, now, uuid),
    registerCoreGlobalForScript(scriptId: string): void {
      const scope = buildScriptScope(scriptId, core, options, now, uuid);
      if (options.luaRuntime.registerScriptGlobal) {
        options.luaRuntime.registerScriptGlobal(scriptId, "Core", scope);
      } else {
        options.luaRuntime.registerGlobal("Core", scope);
      }
    },
    async dispose(): Promise<void> {
      offMessage();
      offState?.();
      await scripts.dispose();
      try {
        await options.transport.disconnect();
      } catch {
        /* ignore */
      }
      try {
        await options.luaRuntime.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildScriptScope(
  scriptId: string | null,
  shared: CoreGlobal,
  options: LuaApiModuleOptions,
  now: () => number,
  uuid: () => string,
): CoreGlobal {
  // Per-script isolation for events, config, log, custom.
  const events = new EventBus();
  const log = createLogApi({ logger: options.logger, scriptId, now });
  const config = createConfigApi({
    defaults: options.defaultConfig ?? {},
    protectedKeys: options.protectedConfigKeys ?? defaultProtectedKeys(),
    scriptId,
  });
  const custom = createCustomApi({ permissions: options.permissions, now });

  // Shared services remain shared (one client/status/tasks per app instance).
  return {
    client: shared.client,
    status: shared.status,
    tasks: shared.tasks,
    utils: createUtilsApi({ now, uuid }),
    events,
    log,
    config,
    custom,
  };
}

function handleInbound(
  message: import("./transport/ICoreTransport").CoreMessageEnvelope,
  events: EventBus,
): void {
  switch (message.type) {
    case "task.assigned":
      events.dispatch("task.assigned", message.payload);
      break;
    case "task.updated":
      events.dispatch("task.updated", message.payload);
      break;
    case "task.cancelled":
      events.dispatch("task.cancelled", message.payload);
      break;
    case "core.status":
      events.dispatch("core.status", message.payload);
      break;
    case "core.error":
      events.dispatch("core.error", message.payload);
      break;
    case "client.registered":
      events.dispatch("client.registered", message.payload);
      break;
    // ─── Player registry (new) ───
    case "player.connected":
      events.dispatch("player.connected", message.payload);
      break;
    case "player.disconnected":
      events.dispatch("player.disconnected", message.payload);
      break;
    case "player.updated":
      events.dispatch("player.updated", message.payload);
      break;
    case "player.list":
      events.dispatch("player.list", message.payload);
      break;
    default:
      // Unknown message types are ignored — do not throw.
      break;
  }
}

// Silence "unused" for LuaApiError in case integrators rely on the named export
// via `import { LuaApiError } from ...` in their own code.
void LuaApiError;
void err;