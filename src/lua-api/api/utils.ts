/**
 * Core.utils — reusable, non-blocking utilities.
 *
 * All utilities validate their inputs and avoid blocking the event loop.
 * `sleep` is cancellation-aware via the standard `AbortSignal` when provided
 * by future adapters; for now it is a plain timer-based sleep.
 */

import { err } from "../errors";
import type { IUtilsApi, ValidationSchema } from "../types";
import { assertFiniteNumber, assertRange, matchesSchema } from "../validation/validators";

export interface UtilsApiOptions {
  now: () => number;
  uuid: () => string;
}

export function createUtilsApi(options: UtilsApiOptions): IUtilsApi {
  return {
    async sleep(milliseconds: number): Promise<void> {
	  const ms = assertFiniteNumber(milliseconds, "milliseconds");
	  assertRange(ms, 0, 2_147_483_647, "milliseconds");
	  if (ms === 0) return;
	  await new Promise<void>((resolve) => setTimeout(resolve, ms));
	},
    now: () => options.now(),
    uuid: () => options.uuid(),
    clamp(value: number, min: number, max: number): number {
      const v = assertFiniteNumber(value, "value");
      const lo = assertFiniteNumber(min, "min");
      const hi = assertFiniteNumber(max, "max");
      if (lo > hi) throw err.invalidArgument("min must be <= max");
      return Math.min(hi, Math.max(lo, v));
    },
    isValid(value: unknown, schema: ValidationSchema): boolean {
      if (schema === null || typeof schema !== "object") {
        throw err.invalidArgument("schema must be an object");
      }
      return matchesSchema(value, schema);
    },
  };
}

/** Default UUID generator. Uses crypto.randomUUID when available. */
export function defaultUuid(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // Fallback — not cryptographically strong, but stable and unique enough.
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}