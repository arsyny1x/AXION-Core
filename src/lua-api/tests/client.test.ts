import { describe, it, expect } from "vitest";
import { createLuaApiModule } from "..";
import { MockCoreTransport } from "../transport/MockCoreTransport";
import { MockLuaRuntime } from "../runtime/MockLuaRuntime";
import { LuaApiError } from "../errors";

function makeModule() {
  return createLuaApiModule({
    transport: new MockCoreTransport(),
    luaRuntime: new MockLuaRuntime(),
    now: () => 1_000,
    uuid: (() => {
      let n = 0;
      return () => `uuid-${++n}`;
    })(),
  });
}

describe("Core.client", () => {
  it("registers a client and reports info", async () => {
    const mod = makeModule();
    await mod.transport.connect({});
    const info = await mod.client.register({ name: "Worker-01", capabilities: ["combat"] });
    expect(info.name).toBe("Worker-01");
    expect(info.capabilities).toEqual(["combat"]);
    expect(info.id).not.toBeNull();
    expect(mod.client.getId()).toBe(info.id);
  });

  it("rejects double registration", async () => {
    const mod = makeModule();
    await mod.transport.connect({});
    await mod.client.register({ name: "Worker-01" });
    await expect(mod.client.register({ name: "Worker-02" })).rejects.toBeInstanceOf(LuaApiError);
  });

  it("fails to register when transport is disconnected", async () => {
    const mod = makeModule();
    await expect(mod.client.register({ name: "Worker-01" })).rejects.toBeInstanceOf(LuaApiError);
  });

  it("validates registration options", async () => {
    const mod = makeModule();
    await mod.transport.connect({});
    await expect(mod.client.register({ name: "" } as never)).rejects.toBeInstanceOf(LuaApiError);
  });

  it("updates metadata without re-registering", async () => {
    const mod = makeModule();
    await mod.transport.connect({});
    await mod.client.register({ name: "W", metadata: { region: "th" } });
    mod.client.updateMetadata({ region: "sg", tier: 2 });
    expect(mod.client.getInfo().metadata).toEqual({ region: "sg", tier: 2 });
  });

  it("returns capabilities copy", async () => {
    const mod = makeModule();
    await mod.transport.connect({});
    await mod.client.register({ name: "W", capabilities: ["a"] });
    const caps = mod.client.getCapabilities();
    caps.push("b");
    expect(mod.client.getCapabilities()).toEqual(["a"]);
  });

  it("unregisters", async () => {
    const mod = makeModule();
    await mod.transport.connect({});
    await mod.client.register({ name: "W" });
    await mod.client.unregister();
    expect(mod.client.getId()).toBeNull();
  });
});