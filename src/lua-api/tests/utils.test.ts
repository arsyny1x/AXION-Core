import { describe, it, expect } from "vitest";
import { createUtilsApi } from "../api/utils";
import { LuaApiError } from "../errors";

const api = createUtilsApi({ now: () => 42, uuid: () => "fixed-uuid" });

describe("Core.utils", () => {
  it("sleeps asynchronously", async () => {
    const start = Date.now();
    await api.sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("rejects negative sleeps", async () => {
    await expect(api.sleep(-1)).rejects.toBeInstanceOf(LuaApiError);
  });

  it("returns stable now()", () => {
    expect(api.now()).toBe(42);
  });

  it("returns stable uuid()", () => {
    expect(api.uuid()).toBe("fixed-uuid");
  });

  it("clamps values", () => {
    expect(api.clamp(5, 0, 10)).toBe(5);
    expect(api.clamp(-1, 0, 10)).toBe(0);
    expect(api.clamp(999, 0, 10)).toBe(10);
  });

  it("rejects inverted clamp ranges", () => {
    expect(() => api.clamp(5, 10, 0)).toThrow(LuaApiError);
  });

  it("validates against schemas", () => {
    expect(api.isValid("hello", { type: "string", min: 1 })).toBe(true);
    expect(api.isValid("", { type: "string", min: 1 })).toBe(false);
    expect(api.isValid(5, { type: "number", min: 0, max: 10 })).toBe(true);
    expect(api.isValid(50, { type: "number", min: 0, max: 10 })).toBe(false);
  });
});