import { describe, it, expect } from "vitest";
import { MockCoreTransport } from "../transport/MockCoreTransport";
import { createEnvelope } from "../transport/ICoreTransport";
import { LuaApiError } from "../errors";

describe("MockCoreTransport", () => {
  it("transitions through connection states", async () => {
    const t = new MockCoreTransport();
    expect(t.getState()).toBe("disconnected");
    await t.connect({});
    expect(t.getState()).toBe("connected");
    await t.disconnect();
    expect(t.getState()).toBe("disconnected");
  });

  it("fails when configured", async () => {
    const t = new MockCoreTransport({ failNextConnect: true });
    await expect(t.connect({})).rejects.toBeInstanceOf(LuaApiError);
    expect(t.getState()).toBe("error");
  });

  it("refuses to send while disconnected", async () => {
    const t = new MockCoreTransport();
    await expect(
      t.send(createEnvelope("heartbeat", {}, { id: "1" })),
    ).rejects.toBeInstanceOf(LuaApiError);
  });

  it("delivers inbound messages to subscribers", () => {
    const t = new MockCoreTransport();
    const received: unknown[] = [];
    t.onMessage((m) => received.push(m));
    const envelope = createEnvelope("task.assigned", { id: "t1" }, { id: "m1" });
    t.emitMessage(envelope);
    expect(received).toHaveLength(1);
  });

  it("notifies state subscribers and unsubscribes", async () => {
    const t = new MockCoreTransport();
    const states: string[] = [];
    const off = t.onStateChange!((s) => states.push(s));
    await t.connect({});
    expect(states).toContain("connected");

    // Clear history so we only inspect what arrives after unsubscribing.
    const countAfterConnect = states.length;
    off();
    await t.disconnect();
    expect(states.length).toBe(countAfterConnect); // no new pushes
  });

  it("validates protocol version on send", async () => {
    const t = new MockCoreTransport();
    await t.connect({});
    const bad = createEnvelope("heartbeat", {}, { id: "1" });
    bad.protocolVersion = "0.0.0";
    await expect(t.send(bad)).rejects.toBeInstanceOf(LuaApiError);
  });
});