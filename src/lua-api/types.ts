/**
 * Shared types for the Custom Lua API module.
 *
 * The types here describe:
 *  - The shape of the public API consumed by Lua scripts.
 *  - The payloads of standard events.
 *  - The contracts that the Central Core and adapters must implement.
 */

// ---------------------------------------------------------------------------
// Connection & client state
// ---------------------------------------------------------------------------

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export const CONNECTION_STATES: readonly ConnectionState[] = [
  "disconnected",
  "connecting",
  "connected",
  "reconnecting",
  "error",
] as const;

export type ClientState =
  | "initializing"
  | "ready"
  | "busy"
  | "paused"
  | "error"
  | "disconnected";

export const CLIENT_STATES: readonly ClientState[] = [
  "initializing",
  "ready",
  "busy",
  "paused",
  "error",
  "disconnected",
] as const;

// ---------------------------------------------------------------------------
// Core.client
// ---------------------------------------------------------------------------

export interface ClientRegisterOptions {
  name: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface ClientInfo {
  id: string | null;
  name: string | null;
  capabilities: string[];
  metadata: Record<string, unknown>;
  connectionState: ConnectionState;
  registeredAt: number | null;
}

export interface IClientApi {
  register(options: ClientRegisterOptions): Promise<ClientInfo>;
  unregister(): Promise<void>;
  getId(): string | null;
  getInfo(): ClientInfo;
  getConnectionState(): ConnectionState;
  getCapabilities(): string[];
  updateMetadata(metadata: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Core.status
// ---------------------------------------------------------------------------

export interface StatusUpdate {
  state?: ClientState;
  message?: string;
  progress?: number;
}

export interface StatusSnapshot {
  state: ClientState;
  message: string;
  progress: number;
  updatedAt: number;
}

export interface IStatusApi {
  update(status: StatusUpdate): void;
  get(): StatusSnapshot;
  setState(state: ClientState): void;
  setProgress(progress: number): void;
  setMessage(message: string): void;
}

// ---------------------------------------------------------------------------
// Core.tasks
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskInfo {
  id: string;
  name?: string;
  status: TaskStatus;
  payload?: Record<string, unknown>;
  progress?: number;
  assignedAt?: number;
  updatedAt?: number;
}

export type TaskResult = Record<string, unknown>;

export interface TaskErrorInfo {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ITasksApi {
  getCurrent(): Promise<TaskInfo | null>;
  getQueue(): Promise<TaskInfo[]>;
  getById(taskId: string): Promise<TaskInfo | null>;
  reportProgress(taskId: string, progress: number): Promise<void>;
  reportSuccess(taskId: string, result: TaskResult): Promise<void>;
  reportFailure(taskId: string, error: TaskErrorInfo): Promise<void>;
  cancel(taskId: string): Promise<void>;
  isCancelled(taskId: string): boolean;
}

/**
 * The task subsystem is injected — the Lua API module must not implement
 * scheduling, assignment, or coordination. The Central Core will provide a
 * concrete implementation of this interface.
 */
export interface ITaskService {
  getCurrent(): Promise<TaskInfo | null>;
  getQueue(): Promise<TaskInfo[]>;
  getById(taskId: string): Promise<TaskInfo | null>;
  reportProgress(taskId: string, progress: number): Promise<void>;
  reportSuccess(taskId: string, result: TaskResult): Promise<void>;
  reportFailure(taskId: string, error: TaskErrorInfo): Promise<void>;
  cancel(taskId: string): Promise<void>;
  isCancelled(taskId: string): boolean;
}

// ---------------------------------------------------------------------------
// Core.events
// ---------------------------------------------------------------------------

export const CORE_EVENTS = [
  "client.connected",
  "client.disconnected",
  "client.registered",
  "task.assigned",
  "task.updated",
  "task.cancelled",
  "task.completed",
  "task.failed",
  "core.status",
  "core.error",
  // Player lifecycle (delivered by the Central Core)
  "player.connected",
  "player.disconnected",
  "player.updated",
  "player.list",
] as const;

export type CoreEventName = (typeof CORE_EVENTS)[number];

export const SCRIPT_EVENTS = [
  "script.loaded",
  "script.started",
  "script.stopped",
  "script.error",
  "script.reloaded",
] as const;

export type ScriptEventName = (typeof SCRIPT_EVENTS)[number];

export type EventCallback = (payload: unknown) => void;

export interface IEventsApi {
  on(eventName: string, callback: EventCallback): () => void;
  once(eventName: string, callback: EventCallback): () => void;
  off(eventName: string, callback: EventCallback): void;
  emit(eventName: string, payload?: unknown): void;
  getAvailableEvents(): string[];
}

// ---------------------------------------------------------------------------
// Core.log
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  timestamp: number;
  level: LogLevel;
  scriptId: string | null;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ILogger {
  log(record: LogRecord): void;
}

export interface ILogApi {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Core.config
// ---------------------------------------------------------------------------

export type ConfigValue = unknown;
export type ConfigSchema = Record<string, ConfigValue>;

export interface IConfigApi {
  get(key: string): ConfigValue;
  getAll(): ConfigSchema;
  has(key: string): boolean;
  set(key: string, value: ConfigValue): void;
}

// ---------------------------------------------------------------------------
// Core.utils
// ---------------------------------------------------------------------------

export interface ValidationSchema {
  type: "string" | "number" | "boolean" | "object" | "array" | "any" | "null";
  required?: boolean;
  properties?: Record<string, ValidationSchema>;
  items?: ValidationSchema;
  min?: number;
  max?: number;
  enum?: readonly unknown[];
}

export interface IUtilsApi {
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  uuid(): string;
  clamp(value: number, min: number, max: number): number;
  isValid(value: unknown, schema: ValidationSchema): boolean;
}

// ---------------------------------------------------------------------------
// Core.custom
// ---------------------------------------------------------------------------

export type PermissionName = string;

export interface IPermissionChecker {
  has(permission: PermissionName): boolean;
}

export interface ParamSchema {
  type: "string" | "number" | "boolean" | "object" | "array" | "any" | "null";
  required?: boolean;
  description?: string;
  min?: number;
  max?: number;
  enum?: readonly unknown[];
}

export interface FunctionSchema {
  params?: Record<string, ParamSchema>;
  returns?: string;
  description?: string;
}

export interface CustomFunctionRegistration {
  name: string;
  handler: (...args: unknown[]) => unknown | Promise<unknown>;
  description?: string;
  schema?: FunctionSchema;
  permissions?: PermissionName[];
}

export interface CustomFunctionInfo {
  name: string;
  description: string;
  schema: FunctionSchema;
  permissions: PermissionName[];
  registeredAt: number;
}

export interface ICustomApi {
  registerFunction(registration: CustomFunctionRegistration): void;
  unregisterFunction(name: string): void;
  listFunctions(): CustomFunctionInfo[];
  getFunctionInfo(name: string): CustomFunctionInfo | null;
}

// ---------------------------------------------------------------------------
// Aggregated `Core` global exposed to Lua
// ---------------------------------------------------------------------------

export interface CoreGlobal {
  client: IClientApi;
  status: IStatusApi;
  tasks: ITasksApi;
  events: IEventsApi;
  log: ILogApi;
  config: IConfigApi;
  utils: IUtilsApi;
  custom: ICustomApi;
}

// ---------------------------------------------------------------------------
// Player (connected client identity)
// ---------------------------------------------------------------------------

export type PlayerStatus = "online" | "busy" | "idle" | "offline" | "error";

export interface PlayerInfo {
  id: string;
  name: string;
  status: PlayerStatus;
  level?: number;
  job?: string;
  guild?: string;
  server?: string;
  placeId?: string;
  region?: string;
  capabilities: string[];
  metadata: Record<string, unknown>;
  connectedAt?: number;
  lastSeenAt?: number;
}