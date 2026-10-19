/**
 * Core.config — read-only-by-default configuration with script-local overrides.
 *
 * Precedence (highest to lowest):
 *   1. Script-local values set via `set(key, value)`.
 *   2. Module defaults supplied by the integrator.
 *
 * Protected keys (system configuration) can be read but never written by a
 * script. The integrator declares them via `protectedKeys`.
 */

import { err } from "../errors";
import type { ConfigSchema, ConfigValue, IConfigApi } from "../types";
import { assertObject, assertString } from "../validation/validators";

export interface ConfigApiOptions {
  defaults: ConfigSchema;
  protectedKeys: readonly string[];
  /** When set, records which script owns the overrides (for diagnostics). */
  scriptId?: string | null;
}

const DEFAULT_PROTECTED_KEYS: readonly string[] = [
  "system",
  "transport",
  "auth",
  "security",
  "permissions",
  "centralCore",
  "protocolVersion",
];

export function defaultProtectedKeys(): readonly string[] {
  return DEFAULT_PROTECTED_KEYS;
}

export function createConfigApi(options: ConfigApiOptions): IConfigApi {
  const overrides: ConfigSchema = Object.create(null) as ConfigSchema;
  const protectedSet = new Set(options.protectedKeys);

  function isProtected(key: string): boolean {
    if (protectedSet.has(key)) return true;
    // Any dotted path whose root is protected is also protected.
    const root = key.split(".")[0];
    return protectedSet.has(root);
  }

  return {
    get(key: string): ConfigValue {
      const k = assertString(key, "key");
      if (Object.prototype.hasOwnProperty.call(overrides, k)) return overrides[k];
      return readPath(options.defaults, k);
    },
    getAll(): ConfigSchema {
      return { ...options.defaults, ...overrides };
    },
    has(key: string): boolean {
      const k = assertString(key, "key");
      if (Object.prototype.hasOwnProperty.call(overrides, k)) return true;
      return readPath(options.defaults, k) !== undefined;
    },
    set(key: string, value: ConfigValue): void {
      const k = assertString(key, "key");
      if (isProtected(k)) throw err.protectedConfig(k);
      // Reject functions, symbols, and other non-serializable values.
      if (typeof value === "function" || typeof value === "symbol") {
        throw err.invalidArgument(`Config value for "${k}" must be serializable`);
      }
      // Reject NaN/Infinity in numbers.
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw err.invalidArgument(`Config value for "${k}" must be a finite number`);
      }
      if (value !== null && typeof value === "object") {
        assertObject(value, `config["${k}"]`);
      }
      overrides[k] = value;
    },
  };
}

function readPath(obj: ConfigSchema, path: string): ConfigValue {
  if (!path.includes(".")) return obj[path];
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}