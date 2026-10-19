import { afterEach, describe, expect, it, vi } from "vitest";
import { Crosshair } from "lucide-react";
import { loadSavedTasks, saveTasks } from "../taskStorage";
import type { Task } from "../../data/mock";

function installStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return values;
}

describe("taskStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts empty and restores saved tasks with a runtime icon", () => {
    const storage = installStorage();
    expect(loadSavedTasks()).toEqual([]);
    const task: Task = {
      id: 42,
      title: "Persistent task",
      desc: "Keep this after restart",
      tag: "Raid",
      icon: Crosshair,
      color: "violet",
      status: "pending",
      progress: 0,
      total: 2,
      created: "today",
      updated: "today",
    };

    saveTasks([task]);
    expect(storage.get("axion.tasks.v1")).not.toContain("icon");
    expect(loadSavedTasks()).toMatchObject([
      { id: 42, title: "Persistent task", status: "pending", color: "violet" },
    ]);
    expect(loadSavedTasks()[0].icon).toBe(Crosshair);
  });

  it("migrates tasks from the legacy storage key", () => {
    const storage = installStorage();
    const legacyTasks = JSON.stringify([
      {
        id: 7,
        title: "Legacy task",
        desc: "Preserve existing tasks",
        tag: "Raid",
        color: "violet",
        status: "pending",
        progress: 0,
        total: 1,
        created: "today",
        updated: "today",
      },
    ]);
    storage.set("autohub.tasks.v1", legacyTasks);

    expect(loadSavedTasks()).toMatchObject([{ id: 7, title: "Legacy task" }]);
    expect(storage.get("axion.tasks.v1")).toBe(legacyTasks);
  });

  it("preserves the mockup marker for saved task-list examples", () => {
    installStorage();
    const mockup: Task = {
      id: 99,
      title: "Sample task",
      desc: "A task list example",
      tag: "Test",
      icon: Crosshair,
      color: "green",
      status: "running",
      progress: 1,
      total: 2,
      created: "today",
      updated: "today",
      isMockup: true,
    };

    saveTasks([mockup]);

    expect(loadSavedTasks()).toMatchObject([{ id: 99, isMockup: true }]);
  });

  it("recognizes older mockup entries with translation keys stored as their text", () => {
    const storage = installStorage();
    storage.set("axion.tasks.v1", JSON.stringify([{
      id: 100,
      title: "task.mockupPatrolTitle",
      desc: "task.mockupPatrolDescription",
      tag: "Blox Fruits",
      status: "running",
      progress: 2,
      total: 3,
      created: "today",
      updated: "today",
      isMockup: true,
    }]));

    expect(loadSavedTasks()).toMatchObject([{ mockupType: "patrol" }]);
  });
});
