import { describe, it, expect } from "vitest";
import {
  assertString,
  assertFiniteNumber,
  assertRange,
  assertOneOf,
  assertPayloadSize,
  matchesSchema,
} from "../validation/validators";
import { LuaApiError } from "../errors";

describe("validators", () => {
  it("accepts valid strings", () => {
    expect(assertString("hello", "x")).toBe("hello");
  });

  it("rejects non-strings", () => {
    expect(() => assertString(42, "x")).toThrow(LuaApiError);
  });

  it("rejects empty strings unless allowed", () => {
    expect(() => assertString("", "x")).toThrow();
    expect(assertString("", "x", { allowEmpty: true })).toBe("");
  });

  it("validates finite numbers", () => {
    expect(assertFiniteNumber(1.5, "n")).toBe(1.5);
    expect(() => assertFiniteNumber(Infinity, "n")).toThrow();
    expect(() => assertFiniteNumber("1", "n")).toThrow();
  });

  it("enforces numeric range", () => {
    expect(assertRange(5, 0, 10, "v")).toBe(5);
    expect(() => assertRange(11, 0, 10, "v")).toThrow();
  });

  it("enforces enum membership", () => {
    expect(assertOneOf("a", ["a", "b"] as const, "k")).toBe("a");
    expect(() => assertOneOf("c", ["a", "b"] as const, "k")).toThrow();
  });

  it("checks payload size", () => {
    expect(() => assertPayloadSize({ a: 1 }, 100, "payload")).not.toThrow();
    expect(() => assertPayloadSize("x".repeat(200), 50, "payload")).toThrow();
  });

  it("matches recursive schemas", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, required: true },
        age: { type: "number" as const, min: 0, max: 150 },
      },
    };
    expect(matchesSchema({ name: "Tom", age: 30 }, schema)).toBe(true);
    expect(matchesSchema({ age: 30 }, schema)).toBe(false);
    expect(matchesSchema({ name: "Tom", age: 200 }, schema)).toBe(false);
  });
});