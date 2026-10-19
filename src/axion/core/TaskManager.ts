import type { EventPublisher } from "./contracts";

export type ManagedTaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface ManagedTask {
  readonly id: string;
  readonly gameId: string;
  readonly name: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: ManagedTaskStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly matchId?: string;
  readonly result?: unknown;
  readonly error?: string;
}

export interface TaskManagerOptions {
  now?: () => number;
  createId?: () => string;
  defaultTtlMs?: number;
  maxTerminalTasks?: number;
}

export class TaskManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly terminalSince = new Map<string, number>();
  private sequence = 0;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly defaultTtlMs: number;
  private readonly maxTerminalTasks: number;

  constructor(
    private readonly events: EventPublisher,
    options: TaskManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `task-${++this.sequence}`);
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
    this.maxTerminalTasks = options.maxTerminalTasks ?? 200;
    if (this.defaultTtlMs <= 0) throw new Error("defaultTtlMs must be greater than zero");
    if (!Number.isInteger(this.maxTerminalTasks) || this.maxTerminalTasks <= 0) {
      throw new Error("maxTerminalTasks must be a positive integer");
    }
  }

  submit(
    gameId: string,
    name: string,
    payload: Record<string, unknown> = {},
    ttlMs = this.defaultTtlMs,
  ): ManagedTask {
    this.sweepExpired();
    assertText(gameId, "gameId");
    assertText(name, "name");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be a positive finite number");
    const now = this.now();
    const task: ManagedTask = {
      id: this.createId(),
      gameId,
      name,
      payload: { ...payload },
      status: "pending",
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    if (this.tasks.has(task.id)) throw new Error(`Task ID "${task.id}" is already in use`);
    this.tasks.set(task.id, task);
    this.events.emit("task.created", copyTask(task));
    return copyTask(task);
  }

  assign(taskId: string, matchId: string): ManagedTask {
    assertText(matchId, "matchId");
    return this.transition(taskId, "assigned", { matchId }, ["pending"]);
  }

  start(taskId: string): ManagedTask {
    return this.transition(taskId, "running", {}, ["assigned"]);
  }

  complete(taskId: string, result?: unknown): ManagedTask {
    return this.transition(taskId, "completed", { result }, ["running"]);
  }

  fail(taskId: string, error: string): ManagedTask {
    assertText(error, "error");
    return this.transition(taskId, "failed", { error }, ["pending", "assigned", "running"]);
  }

  cancel(taskId: string): boolean {
    this.sweepExpired();
    const current = this.requireTask(taskId);
    if (isTerminal(current.status)) return false;
    this.save({ ...current, status: "cancelled" });
    return true;
  }

  get(taskId: string): ManagedTask | undefined {
    this.sweepExpired();
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : copyTask(task);
  }

  list(): readonly ManagedTask[] {
    this.sweepExpired();
    return [...this.tasks.values()].map(copyTask);
  }

  sweepExpired(): void {
    const now = this.now();
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.status) && task.expiresAt <= now) {
        this.save({ ...task, status: "expired" });
      }
    }
  }

  private transition(
    taskId: string,
    status: ManagedTaskStatus,
    values: Partial<ManagedTask>,
    from: readonly ManagedTaskStatus[],
  ): ManagedTask {
    this.sweepExpired();
    const task = this.requireTask(taskId);
    if (!from.includes(task.status)) {
      throw new Error(`Task "${taskId}" cannot transition from "${task.status}" to "${status}"`);
    }
    const updated = { ...task, ...values, status };
    this.save(updated);
    return copyTask(updated);
  }

  private requireTask(taskId: string): ManagedTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" was not found`);
    return task;
  }

  private save(task: ManagedTask): void {
    this.tasks.set(task.id, task);
    if (isTerminal(task.status)) {
      this.terminalSince.set(task.id, this.now());
      this.pruneTerminalTasks();
    } else {
      this.terminalSince.delete(task.id);
    }
    this.events.emit("task.updated", copyTask(task));
  }

  private pruneTerminalTasks(): void {
    while (this.terminalSince.size > this.maxTerminalTasks) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [taskId, completedAt] of this.terminalSince) {
        if (completedAt < oldestAt) {
          oldestId = taskId;
          oldestAt = completedAt;
        }
      }
      if (oldestId === undefined) return;
      this.terminalSince.delete(oldestId);
      this.tasks.delete(oldestId);
    }
  }
}

function isTerminal(status: ManagedTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "expired";
}

function assertText(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function copyTask(task: ManagedTask): ManagedTask {
  return { ...task, payload: { ...task.payload } };
}
