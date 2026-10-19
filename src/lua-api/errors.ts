/**
 * Standardized error model for the Custom Lua API module.
 *
 * Design rules:
 *  - Every public API surface throws `LuaApiError` for expected/operational errors.
 *  - Internal exceptions (bugs) bubble up untouched; we only wrap at API boundaries.
 *  - `code` is stable and machine-readable; `message` is human-readable.
 */

export type LuaApiErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_STATE"
  | "NOT_REGISTERED"
  | "ALREADY_REGISTERED"
  | "TRANSPORT_DISCONNECTED"
  | "TRANSPORT_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "PERMISSION_DENIED"
  | "DUPLICATE_FUNCTION"
  | "FUNCTION_NOT_FOUND"
  | "PROTECTED_CONFIG"
  | "RUNTIME_NOT_READY"
  | "RUNTIME_ERROR"
  | "SCRIPT_NOT_FOUND"
  | "SCRIPT_ALREADY_LOADED"
  | "RESOURCE_EXHAUSTED"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL";

export interface LuaApiErrorJson {
  code: LuaApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class LuaApiError extends Error {
  readonly code: LuaApiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: LuaApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LuaApiError";
    this.code = code;
    this.details = details;
    // Fix prototype chain when targeting ES5-like down-levels.
    Object.setPrototypeOf(this, LuaApiError.prototype);
  }

  toJSON(): LuaApiErrorJson {
    const out: LuaApiErrorJson = { code: this.code, message: this.message };
    if (this.details) out.details = this.details;
    return out;
  }

  static isLuaApiError(value: unknown): value is LuaApiError {
    return value instanceof LuaApiError;
  }

  static from(
    value: unknown,
    fallbackCode: LuaApiErrorCode = "INTERNAL",
    fallbackMessage = "Unexpected error",
  ): LuaApiError {
    if (value instanceof LuaApiError) return value;
    if (value instanceof Error) {
      return new LuaApiError(fallbackCode, value.message || fallbackMessage, {
        originalName: value.name,
      });
    }
    return new LuaApiError(fallbackCode, fallbackMessage, { value });
  }
}

/** Convenience helpers — keep call sites terse. */
export const err = {
  invalidArgument: (msg: string, details?: Record<string, unknown>) =>
    new LuaApiError("INVALID_ARGUMENT", msg, details),
  invalidState: (msg: string, details?: Record<string, unknown>) =>
    new LuaApiError("INVALID_STATE", msg, details),
  notRegistered: (msg = "Client is not registered") =>
    new LuaApiError("NOT_REGISTERED", msg),
  alreadyRegistered: (msg = "Client is already registered") =>
    new LuaApiError("ALREADY_REGISTERED", msg),
  transportDisconnected: (msg = "Transport is not connected") =>
    new LuaApiError("TRANSPORT_DISCONNECTED", msg),
  transportError: (msg: string, details?: Record<string, unknown>) =>
    new LuaApiError("TRANSPORT_ERROR", msg, details),
  timeout: (msg: string, details?: Record<string, unknown>) =>
    new LuaApiError("TIMEOUT", msg, details),
  cancelled: (msg = "Operation cancelled") => new LuaApiError("CANCELLED", msg),
  permissionDenied: (msg: string, details?: Record<string, unknown>) =>
    new LuaApiError("PERMISSION_DENIED", msg, details),
  duplicateFunction: (name: string) =>
    new LuaApiError("DUPLICATE_FUNCTION", `Custom function "${name}" is already registered`, { name }),
  functionNotFound: (name: string) =>
    new LuaApiError("FUNCTION_NOT_FOUND", `Custom function "${name}" is not registered`, { name }),
  protectedConfig: (key: string) =>
    new LuaApiError("PROTECTED_CONFIG", `Configuration key "${key}" is protected`, { key }),
  runtimeNotReady: (msg = "Lua runtime is not ready") =>
    new LuaApiError("RUNTIME_NOT_READY", msg),
  runtimeError: (msg: string, details?: Record<string, unknown>) =>
    new LuaApiError("RUNTIME_ERROR", msg, details),
  scriptNotFound: (id: string) =>
    new LuaApiError("SCRIPT_NOT_FOUND", `Script "${id}" was not found`, { id }),
  scriptAlreadyLoaded: (id: string) =>
    new LuaApiError("SCRIPT_ALREADY_LOADED", `Script "${id}" is already loaded`, { id }),
  payloadTooLarge: (size: number, limit: number) =>
    new LuaApiError("PAYLOAD_TOO_LARGE", `Payload size ${size} exceeds limit ${limit}`, { size, limit }),
};