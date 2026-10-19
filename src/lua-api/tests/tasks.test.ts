import { describe, it, expect } from "vitest";
import { createTasksApi } from "../api/tasks";
import type { ITaskService, TaskInfo } from "../types";
import { LuaApiError } from "../errors";

class FakeTaskService implements ITaskService {
  current: TaskInfo | null = { id: "t1", status: "running" };
  queue: TaskInfo[] = [];
  cancelled = new Set<string>();
  progress: Array<{ id: string; p: number }> = [];
  successes: Array<{ id: string; result: unknown }> = [];
  failures: Array<{ id: string; error: unknown }> = [];

  async getCurrent() { return this.current; }
  async getQueue() { return this.queue; }
  async getById(id: string) { return id === "t1" ? this.current : null; }
  async reportProgress(id: string, p: number) { this.progress.push({ id, p }); }
  async reportSuccess(id: string, result: Record<string, unknown>) { this.successes.push({ id, result }); }
  async reportFailure(id: string, error: unknown) { this.failures.push({ id, error }); }
  async cancel(id: string) { this.cancelled.add(id); }
  isCancelled(id: string) { return this.cancelled.has(id); }
}

describe("Core.tasks", () => {
  it("delegates to the injected service", async () => {
    const svc = new FakeTaskService();
    const api = createTasksApi(svc);
    expect(await api.getCurrent()).toEqual({ id: "t1", status: "running" });
    await api.reportProgress("t1", 50);
    expect(svc.progress).toEqual([{ id: "t1", p: 50 }]);
  });

  it("validates progress range", async () => {
    const api = createTasksApi(new FakeTaskService());
    await expect(api.reportProgress("t1", -1)).rejects.toBeInstanceOf(LuaApiError);
    await expect(api.reportProgress("t1", 101)).rejects.toBeInstanceOf(LuaApiError);
  });

  it("validates task id", async () => {
    const api = createTasksApi(new FakeTaskService());
    await expect(api.reportProgress("", 10)).rejects.toBeInstanceOf(LuaApiError);
  });

  it("validates error shape", async () => {
    const api = createTasksApi(new FakeTaskService());
    await expect(api.reportFailure("t1", { message: "x" } as never)).rejects.toBeInstanceOf(LuaApiError);
  });

  it("reports cancellation correctly", async () => {
    const svc = new FakeTaskService();
    const api = createTasksApi(svc);
    expect(api.isCancelled("t1")).toBe(false);
    await api.cancel("t1");
    expect(api.isCancelled("t1")).toBe(true);
  });

  it("throws when no task service is configured for mutations", async () => {
    const api = createTasksApi();
    await expect(api.reportProgress("t1", 10)).rejects.toBeInstanceOf(LuaApiError);
  });
});