import { describe, it, expect, vi } from "vitest";
import { createEventsApi } from "../api/events";
import { LuaApiError } from "../errors";

describe("Core.events", () => {
  it("subscribes and dispatches core events", () => {
    const bus = createEventsApi();
    const handler = vi.fn();
    bus.on("task.assigned", handler);
    bus.dispatch("task.assigned", { id: "t1" });
    expect(handler).toHaveBeenCalledWith({ id: "t1" });
  });

  it("prevents duplicate listeners", () => {
    const bus = createEventsApi();
    const handler = vi.fn();
    bus.on("core.status", handler);
    expect(() => bus.on("core.status", handler)).toThrow(LuaApiError);
  });

  it("fires once listeners exactly once", () => {
    const bus = createEventsApi();
    const handler = vi.fn();
    bus.once("task.completed", handler);
    bus.dispatch("task.completed", { id: "t1" });
    bus.dispatch("task.completed", { id: "t2" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports unsubscribe", () => {
    const bus = createEventsApi();
    const handler = vi.fn();
    const off = bus.on("task.updated", handler);
    off();
    bus.dispatch("task.updated", { id: "t1" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects emitting reserved core events", () => {
    const bus = createEventsApi();
    expect(() => bus.emit("task.assigned", {})).toThrow(LuaApiError);
  });

  it("allows custom local events", () => {
    const bus = createEventsApi();
    const handler = vi.fn();
    bus.on("my.custom.event", handler);
    bus.emit("my.custom.event", { hello: "world" });
    expect(handler).toHaveBeenCalledWith({ hello: "world" });
  });

  it("lists available events", () => {
    const bus = createEventsApi();
    bus.on("my.event", vi.fn());
    const available = bus.getAvailableEvents();
    expect(available).toContain("task.assigned");
    expect(available).toContain("my.event");
  });

  it("clears listeners", () => {
    const bus = createEventsApi();
    const handler = vi.fn();
    bus.on("task.assigned", handler);
    bus.clear();
    bus.dispatch("task.assigned", {});
    expect(handler).not.toHaveBeenCalled();
  });
});