import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addTaskStatusNotification,
  clearNotifications,
  getNotificationsSnapshot,
  markNotificationsRead,
} from "../notificationService";

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

describe("notificationService", () => {
  afterEach(() => {
    clearNotifications();
    vi.unstubAllGlobals();
  });

  it("persists notifications and read state, and clears the saved list", () => {
    const storage = installStorage();
    addTaskStatusNotification("Completed task “Example”");
    expect(getNotificationsSnapshot()).toMatchObject([
      { message: "Completed task “Example”", read: false },
    ]);
    expect(storage.get("axion.task-notifications.v1")).toContain("Completed task");

    markNotificationsRead();
    expect(getNotificationsSnapshot()[0].read).toBe(true);
    expect(storage.get("axion.task-notifications.v1")).toContain('"read":true');

    clearNotifications();
    expect(getNotificationsSnapshot()).toEqual([]);
    expect(storage.get("axion.task-notifications.v1")).toBe("[]");
  });

  it("does not bring general notifications forward from the previous feed", () => {
    const storage = installStorage();
    storage.set("axion.notifications.v1", JSON.stringify([{
      id: "old",
      message: "A general app notification",
      createdAt: Date.now(),
      read: false,
    }]));

    expect(getNotificationsSnapshot()).toEqual([]);
    expect(storage.get("axion.notifications.v1")).toContain("A general app notification");
  });
});
