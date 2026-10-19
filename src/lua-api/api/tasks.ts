/**
 * Core.tasks — thin facade over an injected `ITaskService`.
 *
 * This module deliberately does NOT schedule, assign, or coordinate tasks.
 * All task lifecycle operations are delegated to the injected service, which
 * the Central Core will implement later.
 *
 * When `taskService` is not provided, a `NullTaskService` is used so the API
 * surface is stable but no-ops (with a clear error for mutations).
 */

import { err } from "../errors";
import type {
  ITaskService,
  ITasksApi,
  TaskErrorInfo,
  TaskInfo,
  TaskResult,
} from "../types";
import { assertFiniteNumber, assertObject, assertRange, assertString } from "../validation/validators";

const PROGRESS_MIN = 0;
const PROGRESS_MAX = 100;

export function createTasksApi(taskService?: ITaskService): ITasksApi {
  const service = taskService ?? new NullTaskService();

  return {
    getCurrent: () => service.getCurrent(),
    getQueue: () => service.getQueue(),
    getById: (taskId) => {
      const id = assertString(taskId, "taskId");
      return service.getById(id);
    },
    reportProgress: async (taskId, progress) => {
      const id = assertString(taskId, "taskId");
      const p = assertFiniteNumber(progress, "progress");
      assertRange(p, PROGRESS_MIN, PROGRESS_MAX, "progress");
      await service.reportProgress(id, p);
    },
    reportSuccess: async (taskId, result) => {
      const id = assertString(taskId, "taskId");
      const r = assertObject(result, "result") as TaskResult;
      await service.reportSuccess(id, r);
    },
    reportFailure: async (taskId, error) => {
      const id = assertString(taskId, "taskId");
      const e = validateTaskError(error);
      await service.reportFailure(id, e);
    },
    cancel: async (taskId) => {
      const id = assertString(taskId, "taskId");
      await service.cancel(id);
    },
    isCancelled: (taskId) => {
      const id = assertString(taskId, "taskId");
      return service.isCancelled(id);
    },
  };
}

function validateTaskError(value: unknown): TaskErrorInfo {
  const obj = assertObject(value, "error");
  const code = assertString(obj["code"], "error.code");
  const message = assertString(obj["message"], "error.message");
  const details = obj["details"] === undefined
    ? undefined
    : (assertObject(obj["details"], "error.details") as Record<string, unknown>);
  const out: TaskErrorInfo = { code, message };
  if (details) out.details = details;
  return out;
}

/** Default service used when the integrator hasn't wired one up yet. */
class NullTaskService implements ITaskService {
  async getCurrent(): Promise<TaskInfo | null> {
    return null;
  }
  async getQueue(): Promise<TaskInfo[]> {
    return [];
  }
  async getById(): Promise<TaskInfo | null> {
    return null;
  }
  async reportProgress(): Promise<void> {
    throw err.invalidState(
      "No task service is configured. Provide `taskService` to the Lua API module factory.",
    );
  }
  async reportSuccess(): Promise<void> {
    throw err.invalidState(
      "No task service is configured. Provide `taskService` to the Lua API module factory.",
    );
  }
  async reportFailure(): Promise<void> {
    throw err.invalidState(
      "No task service is configured. Provide `taskService` to the Lua API module factory.",
    );
  }
  async cancel(): Promise<void> {
    throw err.invalidState(
      "No task service is configured. Provide `taskService` to the Lua API module factory.",
    );
  }
  isCancelled(): boolean {
    return false;
  }
}