import { describe, it, expect, vi } from "vitest";
import { createLuaApiModule } from "..";
import { MockCoreTransport } from "../transport/MockCoreTransport";
import { MockLuaRuntime } from "../runtime/MockLuaRuntime";
import { LuaApiError } from "../errors";

function makeModule() {
  const transport = new MockCoreTransport();
  const runtime = new MockLuaRuntime();
  const mod = createLuaApiModule({ transport, luaRuntime: runtime });
  return { mod, transport, runtime };
}

describe("ScriptManager", () => {
  it("loads, starts, stops, and unloads scripts", async () => {
    const { mod, runtime } = makeModule();
    await runtime.initialize();
    const record = await mod.scripts.load({
      id: "s1",
      name: "Worker",
      source: "print('hello')",
    });
    expect(record.id).toBe("s1");
    await mod.scripts.start("s1");
    expect(mod.scripts.get("s1")!.runtimeState).toBe("running");
    await mod.scripts.stop("s1");
    expect(mod.scripts.get("s1")!.runtimeState).toBe("stopped");
    await mod.scripts.unload("s1");
    expect(mod.scripts.get("s1")).toBeNull();
  });

  it("rejects duplicate script ids", async () => {
    const { mod, runtime } = makeModule();
    await runtime.initialize();
    await mod.scripts.load({ id: "s1", name: "A", source: "" });
    await expect(mod.scripts.load({ id: "s1", name: "B", source: "" })).rejects.toBeInstanceOf(LuaApiError);
  });

  it("isolates per-script Core globals", async () => {
    const { mod, runtime } = makeModule();
    await runtime.initialize();
    await mod.scripts.load({ id: "s1", name: "A", source: "" });
    await mod.scripts.load({ id: "s2", name: "B", source: "" });
    const core1 = runtime.getScriptGlobal("s1", "Core") as { events: unknown };
    const core2 = runtime.getScriptGlobal("s2", "Core") as { events: unknown };
    expect(core1).toBeDefined();
    expect(core2).toBeDefined();
    expect(core1.events).not.toBe(core2.events);
  });

  it("dispatches lifecycle events", async () => {
    const { mod, runtime } = makeModule();
    await runtime.initialize();
    const loaded = vi.fn();
    mod.events.on("script.loaded", loaded);
    await mod.scripts.load({ id: "s1", name: "A", source: "" });
    expect(loaded).toHaveBeenCalledWith({ scriptId: "s1", name: "A" });
  });

  it("disposes all scripts", async () => {
    const { mod, runtime } = makeModule();
    await runtime.initialize();
    await mod.scripts.load({ id: "s1", name: "A", source: "" });
    await mod.scripts.load({ id: "s2", name: "B", source: "" });
    await mod.scripts.dispose();
    expect(mod.scripts.list()).toHaveLength(0);
  });

  it("handles multiple-script isolation of events", async () => {
    const { mod, runtime } = makeModule();
    await runtime.initialize();
    await mod.scripts.load({ id: "s1", name: "A", source: "" });
    await mod.scripts.load({ id: "s2", name: "B", source: "" });
    const c1 = runtime.getScriptGlobal("s1", "Core") as { events: { on: Function; dispatch: Function } };
    const c2 = runtime.getScriptGlobal("s2", "Core") as { events: { on: Function; dispatch: Function } };
    const hit1: unknown[] = [];
    const hit2: unknown[] = [];
    c1.events.on("task.assigned", (p: unknown) => hit1.push(p));
    c2.events.on("task.assigned", (p: unknown) => hit2.push(p));
    c1.events.dispatch("task.assigned", { id: "t1" });
    expect(hit1).toHaveLength(1);
    expect(hit2).toHaveLength(0);
  });
});