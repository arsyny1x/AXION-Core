import { describe, expect, it, vi } from "vitest";
import { EventBus, StateStore, TaskManager } from "..";

describe("AXION scoped state and task manager", () => {
  it("isolates state by scope and returns a snapshot of scope entries", () => {
    const store = new StateStore();
    store.set("game-a", "agent", { status: "ready" });
    store.set("game-b", "agent", { status: "busy" });
    expect(store.get("game-a", "agent")).toEqual({ status: "ready" });
    expect(store.listScope("game-a").get("agent")).toEqual({ status: "ready" });
    store.clearScope("game-a");
    expect(store.get("game-a", "agent")).toBeUndefined();
    expect(store.get("game-b", "agent")).toEqual({ status: "busy" });
  });

  it("enforces task lifecycle transitions, cancellation, and expiry", () => {
    let now = 1_000;
    const events = new EventBus();
    const update = vi.fn();
    events.on("task.updated", update);
    const tasks = new TaskManager(events, {
      now: () => now,
      createId: () => "task-1",
      defaultTtlMs: 50,
    });
    const task = tasks.submit("game", "team-match", { region: "apac" });
    expect(tasks.assign(task.id, "match-1").status).toBe("assigned");
    expect(tasks.start(task.id).status).toBe("running");
    expect(tasks.complete(task.id, { players: 2 }).status).toBe("completed");
    expect(() => tasks.start(task.id)).toThrow(/cannot transition/);
    expect(update).toHaveBeenCalledTimes(3);

    const expiring = new TaskManager(events, { now: () => now, createId: () => "task-expiring" });
    expiring.submit("game", "short-lived", {}, 10);
    now += 11;
    expect(expiring.get("task-expiring")?.status).toBe("expired");
  });

  it("bounds terminal task history without evicting active tasks", () => {
    let now = 1_000;
    let nextId = 0;
    const tasks = new TaskManager(new EventBus(), {
      now: () => now++,
      createId: () => `task-${++nextId}`,
      maxTerminalTasks: 2,
    });

    const active = tasks.submit("game", "active");
    const first = tasks.submit("game", "first");
    tasks.cancel(first.id);
    const second = tasks.submit("game", "second");
    tasks.cancel(second.id);
    const third = tasks.submit("game", "third");
    tasks.cancel(third.id);

    expect(tasks.get(active.id)?.status).toBe("pending");
    expect(tasks.get(first.id)).toBeUndefined();
    expect(tasks.get(second.id)?.status).toBe("cancelled");
    expect(tasks.get(third.id)?.status).toBe("cancelled");
    expect(tasks.list()).toHaveLength(3);
  });

  it("notifies remaining event listeners and surfaces handler errors", () => {
    const events = new EventBus();
    const laterListener = vi.fn();
    events.on("feature.event", () => { throw new Error("listener failed"); });
    events.on("feature.event", laterListener);
    expect(() => events.emit("feature.event", { ok: true })).toThrow(/listeners failed/);
    expect(laterListener).toHaveBeenCalledWith({ ok: true });
  });
});
