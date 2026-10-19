import { describe, expect, it } from "vitest";
import { WasmoonLuaRuntime } from "../runtime/WasmoonLuaRuntime";

describe("WasmoonLuaRuntime", () => {
  it("keeps each script's Core bindings isolated across multiple loaded scripts", async () => {
    const runtime = new WasmoonLuaRuntime();
    const messages: string[] = [];
    await runtime.initialize();

    runtime.registerScriptGlobal("script-a", "Core", {
      log: { info: (message: string) => messages.push(`A:${message}`) },
    });
    runtime.registerScriptGlobal("script-b", "Core", {
      log: { info: (message: string) => messages.push(`B:${message}`) },
    });
    await runtime.loadScript('Core.log.info("first")', { scriptId: "script-a", name: "Script A" });
    await runtime.loadScript('Core.log.info("second")', { scriptId: "script-b", name: "Script B" });

    await Promise.all([
      runtime.executeScript("script-a"),
      runtime.executeScript("script-b"),
    ]);

    expect(messages).toEqual(["A:first", "B:second"]);
    await runtime.dispose();
  });

  it("interrupts timed out scripts and releases their engine", async () => {
    const runtime = new WasmoonLuaRuntime();
    await runtime.initialize({ defaultTimeoutMs: 50 });
    await runtime.loadScript("while true do end", { scriptId: "timed-script", name: "Timed Script" });

    await expect(runtime.executeScript("timed-script")).rejects.toThrow('Script "timed-script" timed out');
    await expect(runtime.executeScript("timed-script")).rejects.toThrow('Script "timed-script" not loaded');
    await runtime.dispose();
  });

  it("does not retain an engine when loading a script fails", async () => {
    const runtime = new WasmoonLuaRuntime();
    await runtime.initialize();
    const metadata = {
      scriptId: '"); error("intentional load failure"); --',
      name: "Invalid Script",
    };

    await expect(runtime.loadScript("", metadata)).rejects.toThrow("intentional load failure");
    await expect(runtime.loadScript("", metadata)).rejects.not.toThrow("already loaded");
    await runtime.dispose();
  });
});
