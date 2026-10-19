import { describe, it, expect } from "vitest";
import { createConfigApi, defaultProtectedKeys } from "../api/config";
import { LuaApiError } from "../errors";

describe("Core.config", () => {
  it("reads defaults", () => {
    const api = createConfigApi({ defaults: { a: 1 }, protectedKeys: [] });
    expect(api.get("a")).toBe(1);
    expect(api.has("a")).toBe(true);
    expect(api.has("b")).toBe(false);
  });

  it("applies script-local overrides with precedence over defaults", () => {
    const api = createConfigApi({ defaults: { a: 1 }, protectedKeys: [] });
    api.set("a", 2);
    expect(api.get("a")).toBe(2);
    expect(api.getAll()).toEqual({ a: 2 });
  });

  it("blocks protected keys", () => {
    const api = createConfigApi({ defaults: { system: {} }, protectedKeys: defaultProtectedKeys() });
    expect(() => api.set("system", 1)).toThrow(LuaApiError);
    expect(() => api.set("system.foo", 1)).toThrow(LuaApiError);
  });

  it("rejects non-serializable values", () => {
    const api = createConfigApi({ defaults: {}, protectedKeys: [] });
    expect(() => api.set("fn", () => 1)).toThrow(LuaApiError);
    expect(() => api.set("nan", Number.NaN)).toThrow(LuaApiError);
  });

  it("supports dotted paths on read", () => {
    const api = createConfigApi({ defaults: { a: { b: { c: 5 } } }, protectedKeys: [] });
    expect(api.get("a.b.c")).toBe(5);
    expect(api.get("a.b.missing")).toBeUndefined();
  });
});