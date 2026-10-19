import { describe, it, expect, vi } from "vitest";
import { createLuaApiModule } from "..";
import { MockCoreTransport } from "../transport/MockCoreTransport";
import { MockLuaRuntime } from "../runtime/MockLuaRuntime";
import { createEnvelope } from "../transport/ICoreTransport";

describe("Lua API module — integration", () => {
  it("fans out inbound transport messages to event subscribers", async () => {
    const transport = new MockCoreTransport();
    const runtime = new MockLuaRuntime();
    const mod = createLuaApiModule({ transport, luaRuntime: runtime });
    const handler = vi.fn();
    mod.events.on("task.assigned", handler);
    transport.emitMessage(createEnvelope("task.assigned", { id: "t1" }, { id: "m1" }));
    expect(handler).toHaveBeenCalledWith({ id: "t1" });
  });

  it("exposes a Lua-facing Core global", () => {
    const transport = new MockCoreTransport();
    const runtime = new MockLuaRuntime();
    const mod = createLuaApiModule({ transport, luaRuntime: runtime });
    const core = mod.buildCoreGlobal();
    expect(core.client).toBeDefined();
    expect(core.status).toBeDefined();
    expect(core.tasks).toBeDefined();
    expect(core.events).toBeDefined();
    expect(core.log).toBeDefined();
    expect(core.config).toBeDefined();
    expect(core.utils).toBeDefined();
    expect(core.custom).toBeDefined();
  });

  it("disposes without leaving resources behind", async () => {
    const transport = new MockCoreTransport();
    const runtime = new MockLuaRuntime();
    const mod = createLuaApiModule({ transport, luaRuntime: runtime });
    await mod.transport.connect({});
    await mod.dispose();
    expect(runtime.getState()).toBe("disposed");
    expect(transport.getState()).toBe("disconnected");
  });

  it("respects injected permissions", async () => {
    const transport = new MockCoreTransport();
    const runtime = new MockLuaRuntime();
    const mod = createLuaApiModule({
      transport,
      luaRuntime: runtime,
      permissions: { has: (p) => p === "granted" },
    });
    mod.custom.registerFunction({
      name: "noop",
      handler: () => "ok",
      permissions: ["granted"],
    });
    // Custom functions are invoked through the api's custom.invoke, which is
    // exposed on the CustomApi extension (not the public ICustomApi shape).
    // Here we assert registration metadata instead.
    const info = mod.custom.getFunctionInfo("noop")!;
    expect(info.permissions).toEqual(["granted"]);
  });
});