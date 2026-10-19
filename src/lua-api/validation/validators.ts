/**
 * Reusable input validators used across every public API function.
 *
 * Every helper throws a `LuaApiError("INVALID_ARGUMENT", ...)` on failure so
 * callers can rely on a single error type at API boundaries.
 */

import { err } from "../errors";
import type { ValidationSchema } from "../types";

export function assertString(value: unknown, name: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string") {
    throw err.invalidArgument(`"${name}" must be a string`, { received: typeof value });
  }
  if (!opts.allowEmpty && value.length === 0) {
    throw err.invalidArgument(`"${name}" must not be empty`);
  }
  return value;
}

export function assertFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw err.invalidArgument(`"${name}" must be a finite number`, { received: value });
  }
  return value;
}

export function assertInteger(value: unknown, name: string): number {
  const n = assertFiniteNumber(value, name);
  if (!Number.isInteger(n)) {
    throw err.invalidArgument(`"${name}" must be an integer`, { received: n });
  }
  return n;
}

export function assertRange(value: number, min: number, max: number, name: string): number {
  if (value < min || value > max) {
    throw err.invalidArgument(`"${name}" must be in range [${min}, ${max}]`, { received: value });
  }
  return value;
}

export function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw err.invalidArgument(`"${name}" must be a boolean`, { received: typeof value });
  }
  return value;
}

export function assertObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw err.invalidArgument(`"${name}" must be a plain object`, { received: typeof value });
  }
  return value as Record<string, unknown>;
}

export function assertArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw err.invalidArgument(`"${name}" must be an array`, { received: typeof value });
  }
  return value;
}

export function assertStringArray(value: unknown, name: string): string[] {
  const arr = assertArray(value, name);
  return arr.map((item, i) => assertString(item, `${name}[${i}]`));
}

export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  const s = assertString(value, name);
  if (!(allowed as readonly string[]).includes(s)) {
    throw err.invalidArgument(`"${name}" must be one of: ${allowed.join(", ")}`, { received: s });
  }
  return s as T;
}

export function assertFunction(value: unknown, name: string): (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw err.invalidArgument(`"${name}" must be a function`, { received: typeof value });
  }
  return value as (...args: unknown[]) => unknown;
}

export function assertOptional<T>(
  value: unknown,
  validate: (v: unknown) => T,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return validate(value);
}

/** Recursive schema validation used by `Core.utils.isValid`. */
export function matchesSchema(value: unknown, schema: ValidationSchema): boolean {
  switch (schema.type) {
    case "any":
      return true;
    case "null":
      return value === null;
    case "string":
      if (typeof value !== "string") return false;
      if (schema.enum && !schema.enum.includes(value)) return false;
      if (typeof schema.min === "number" && value.length < schema.min) return false;
      if (typeof schema.max === "number" && value.length > schema.max) return false;
      return true;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (schema.enum && !schema.enum.includes(value)) return false;
      if (typeof schema.min === "number" && value < schema.min) return false;
      if (typeof schema.max === "number" && value > schema.max) return false;
      return true;
    case "boolean":
      return typeof value === "boolean";
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      if (!schema.properties) return true;
      const obj = value as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const prop = obj[key];
        if (prop === undefined) {
          if (propSchema.required) return false;
          continue;
        }
        if (!matchesSchema(prop, propSchema)) return false;
      }
      return true;
    }
    case "array": {
      if (!Array.isArray(value)) return false;
      if (!schema.items) return true;
      return value.every((item) => matchesSchema(item, schema.items!));
    }
    default:
      return false;
  }
}

/**
 * Limit the serialized size of a payload. Prevents scripts from sending
 * arbitrarily large messages through the transport adapter.
 */
export function assertPayloadSize(value: unknown, maxBytes: number, name: string): void {
  const size = approximateJsonSize(value);
  if (size > maxBytes) {
    throw err.payloadTooLarge(size, maxBytes);
  }
}

function approximateJsonSize(value: unknown): number {
  if (value === null || value === undefined) return 4;
  const t = typeof value;
  if (t === "number" || t === "boolean") return 8;
  if (t === "string") return (value as string).length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}