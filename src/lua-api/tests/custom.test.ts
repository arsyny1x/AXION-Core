import { describe, it, expect } from "vitest";
import { createCustomApi } from "../api/custom";
import type { IPermissionChecker } from "../types";
import { LuaApiError } from "../errors";

function makePermissions(granted: string[]): IPermissionChecker {
  const set = new Set(granted);
  return { has: (p) => set.has(p) };
}

describe("Core.custom", () => {
  it("registers a function with metadata", () => {
    const api = createCustomApi({ now: () => 1 });
    api.registerFunction({
      name: "greet",
      description: "Greets the caller",
      schema: { params: { who: { type: "string", required: true } }, returns: "string" },
      handler: (who) => `Hello, ${who}`,
    });
    const info = api.getFunctionInfo("greet");
    expect(info).not.toBeNull();
    expect(info!.description).toBe("Greets the caller");
    expect(info!.schema.params!.who.required).toBe(true);
  });

  it("rejects duplicate names", () => {
    const api = createCustomApi({ now: () => 1 });
    api.registerFunction({ name: "x", handler: () => 1 });
    expect(() => api.registerFunction({ name: "x", handler: () => 2 })).toThrow(LuaApiError);
  });

  it("rejects reserved prefixes", () => {
    const api = createCustomApi({ now: () => 1 });
    expect(() => api.registerFunction({ name: "__secret", handler: () => 1 })).toThrow(LuaApiError);
  });

  it("rejects invalid schema types", () => {
    const api = createCustomApi({ now: () => 1 });
    expect(() =>
      api.registerFunction({
        name: "bad",
        handler: () => 1,
        schema: { params: { x: { type: "bogus" as never } } },
      }),
    ).toThrow(LuaApiError);
  });

  it("unregisters functions", () => {
    const api = createCustomApi({ now: () => 1 });
    api.registerFunction({ name: "x", handler: () => 1 });
    api.unregisterFunction("x");
    expect(api.getFunctionInfo("x")).toBeNull();
    expect(() => api.unregisterFunction("x")).toThrow(LuaApiError);
  });

  it("enforces permission checks on invoke", async () => {
    const api = createCustomApi({ now: () => 1, permissions: makePermissions(["admin"]) });
    api.registerFunction({ name: "secure", handler: () => "ok", permissions: ["admin"] });
    await expect(api.invoke("secure", [])).resolves.toBe("ok");
    api.registerFunction({ name: "locked", handler: () => "no", permissions: ["root"] });
    await expect(api.invoke("locked", [])).rejects.toBeInstanceOf(LuaApiError);
  });

  it("lists functions", () => {
    const api = createCustomApi({ now: () => 1 });
    api.registerFunction({ name: "a", handler: () => 1 });
    api.registerFunction({ name: "b", handler: () => 2 });
    expect(api.listFunctions().map((f) => f.name).sort()).toEqual(["a", "b"]);
  });
});