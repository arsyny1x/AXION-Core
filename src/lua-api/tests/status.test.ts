import { describe, it, expect } from "vitest";
import { createLuaApiModule } from "..";
import { MockCoreTransport } from "../transport/MockCoreTransport";
import { MockLuaRuntime } from "../runtime/MockLuaRuntime";
import { LuaApiError } from "../errors";

function makeModule() {
  return createLuaApiModule({
    transport: new MockCoreTransport(),
    luaRuntime: new MockLuaRuntime(),
    now: () => 123,
    uuid: () => "u",
  });
}

describe("Core.status", () => {
  it("updates state", () => {
    const mod = makeModule();
    mod.status.setState("ready");
    expect(mod.status.get().state).toBe("ready");
  });

  it("rejects invalid progress", () => {
    const mod = makeModule();
    expect(() => mod.status.setProgress(-1)).toThrow(LuaApiError);
    expect(() => mod.status.setProgress(101)).toThrow(LuaApiError);
  });

  it("rejects invalid state", () => {
    const mod = makeModule();
    expect(() => mod.status.setState("nope" as never)).toThrow(LuaApiError);
  });

  it("updates multiple fields at once", () => {
    const mod = makeModule();
    mod.status.update({ state: "busy", message: "working", progress: 50 });
    const snapshot = mod.status.get();
    expect(snapshot.state).toBe("busy");
    expect(snapshot.message).toBe("working");
    expect(snapshot.progress).toBe(50);
  });

  it("validates message type", () => {
    const mod = makeModule();
    expect(() => mod.status.setMessage(42 as never)).toThrow(LuaApiError);
  });
});