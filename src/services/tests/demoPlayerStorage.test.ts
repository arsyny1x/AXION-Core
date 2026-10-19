import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadDemoPlayers,
  saveDemoPlayers,
  type DemoPlayer,
} from "../demoPlayerStorage";

function installStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return values;
}

describe("demoPlayerStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("provides editable sample cards on first use and persists removals", () => {
    installStorage();
    const initial = loadDemoPlayers();
    expect(initial).toHaveLength(4);

    saveDemoPlayers(initial.slice(0, 2));
    expect(loadDemoPlayers()).toEqual(initial.slice(0, 2));
  });

  it("persists additions and edits in the local cache", () => {
    const storage = installStorage();
    const player: DemoPlayer = {
      id: "DEMO-CUSTOM",
      name: "Edited mockup",
      status: "busy",
      uptime: "3h",
      task: "Testing",
      description: "Edited locally",
      progress: 50,
    };

    saveDemoPlayers([player]);
    expect(storage.get("axion.players.demo.v1")).toContain("Edited mockup");
    expect(loadDemoPlayers()).toEqual([player]);
  });

  it("reports corrupted cache data instead of silently replacing it", () => {
    const storage = installStorage();
    storage.set("axion.players.demo.v1", "{invalid");

    expect(() => loadDemoPlayers()).toThrow();
    expect(storage.get("axion.players.demo.v1")).toBe("{invalid");
  });

  it("removes the old mockup task cache", () => {
    const storage = installStorage();
    storage.set("axion.tasks.demo.v1", '[{"id":"old-task"}]');
    loadDemoPlayers();
    expect(storage.has("axion.tasks.demo.v1")).toBe(false);
  });
});
