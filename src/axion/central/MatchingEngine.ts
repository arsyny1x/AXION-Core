import type { JsonPrimitive } from "../core/contracts";

export interface AgentUpdate {
  id: string;
  gameId: string;
  state: Readonly<Record<string, JsonPrimitive>>;
  inventory: Readonly<Record<string, number>>;
}

export interface MatchRequest {
  taskId: string;
  gameId: string;
  requesterAgentId?: string;
  requiredAgents: number;
  includeRequester?: boolean;
  state?: Readonly<Record<string, JsonPrimitive>>;
  inventory?: Readonly<Record<string, number>>;
}

export interface AgentSnapshot extends AgentUpdate {
  lastSeenAt: number;
  online: boolean;
  reservedBy: string | null;
}

export interface MatchRecord {
  id: string;
  taskId: string;
  gameId: string;
  agentIds: readonly string[];
  createdAt: number;
  expiresAt: number;
}

export type MatchResult =
  | { status: "no_match"; taskId: string }
  | { status: "matched"; match: MatchRecord };

export interface MatchingEngineOptions {
  offlineAfterMs?: number;
  matchTtlMs?: number;
  now?: () => number;
  createId?: () => string;
}

export class MatchingEngine {
  private readonly agents = new Map<string, AgentSnapshot>();
  private readonly matches = new Map<string, MatchRecord>();
  private readonly taskMatches = new Map<string, string>();
  private sequence = 0;
  private readonly offlineAfterMs: number;
  private readonly matchTtlMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: MatchingEngineOptions = {}) {
    this.offlineAfterMs = options.offlineAfterMs ?? 30_000;
    this.matchTtlMs = options.matchTtlMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `match-${++this.sequence}`);
    if (this.offlineAfterMs <= 0 || this.matchTtlMs <= 0) {
      throw new Error("offlineAfterMs and matchTtlMs must be greater than zero");
    }
  }

  updateAgent(update: AgentUpdate): void {
    this.sweepExpired();
    assertNonEmpty(update.id, "agent.id");
    assertNonEmpty(update.gameId, "agent.gameId");
    validateInventory(update.inventory);
    const existing = this.agents.get(update.id);
    this.agents.set(update.id, {
      ...update,
      state: { ...update.state },
      inventory: { ...update.inventory },
      lastSeenAt: this.now(),
      online: true,
      reservedBy: existing?.reservedBy ?? null,
    });
  }

  requestMatch(request: MatchRequest): MatchResult {
    this.sweepExpired();
    validateRequest(request);
    if (this.taskMatches.has(request.taskId)) {
      throw new Error(`Task "${request.taskId}" already has an active match`);
    }

    const candidates = [...this.agents.values()]
      .filter((agent) => this.isEligible(agent, request))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, request.requiredAgents);
    if (candidates.length < request.requiredAgents) {
      return { status: "no_match", taskId: request.taskId };
    }

    const now = this.now();
    const match: MatchRecord = {
      id: this.createId(),
      taskId: request.taskId,
      gameId: request.gameId,
      agentIds: candidates.map((agent) => agent.id),
      createdAt: now,
      expiresAt: now + this.matchTtlMs,
    };
    for (const agent of candidates) agent.reservedBy = match.id;
    this.matches.set(match.id, match);
    this.taskMatches.set(match.taskId, match.id);
    return { status: "matched", match: copyMatch(match) };
  }

  cancelTask(taskId: string): boolean {
    this.sweepExpired();
    const matchId = this.taskMatches.get(taskId);
    if (!matchId) return false;
    this.releaseMatch(matchId);
    return true;
  }

  getAgent(agentId: string): AgentSnapshot | undefined {
    this.sweepExpired();
    const agent = this.agents.get(agentId);
    return agent === undefined ? undefined : { ...agent, state: { ...agent.state }, inventory: { ...agent.inventory } };
  }

  getMatch(matchId: string): MatchRecord | undefined {
    this.sweepExpired();
    const match = this.matches.get(matchId);
    return match === undefined ? undefined : copyMatch(match);
  }

  sweepExpired(): void {
    const now = this.now();
    for (const agent of this.agents.values()) {
      if (agent.online && now - agent.lastSeenAt >= this.offlineAfterMs) {
        agent.online = false;
        if (agent.reservedBy) this.releaseMatch(agent.reservedBy);
      }
    }
    for (const [matchId, match] of this.matches) {
      if (match.expiresAt <= now) this.releaseMatch(matchId);
    }
  }

  private isEligible(agent: AgentSnapshot, request: MatchRequest): boolean {
    if (!agent.online || agent.reservedBy !== null || agent.gameId !== request.gameId) return false;
    if (!request.includeRequester && agent.id === request.requesterAgentId) return false;
    for (const [key, expected] of Object.entries(request.state ?? {})) {
      if (agent.state[key] !== expected) return false;
    }
    for (const [item, minimum] of Object.entries(request.inventory ?? {})) {
      if ((agent.inventory[item] ?? 0) < minimum) return false;
    }
    return true;
  }

  private releaseMatch(matchId: string): void {
    const match = this.matches.get(matchId);
    if (!match) return;
    for (const agentId of match.agentIds) {
      const agent = this.agents.get(agentId);
      if (agent?.reservedBy === matchId) agent.reservedBy = null;
    }
    this.matches.delete(matchId);
    this.taskMatches.delete(match.taskId);
  }
}

function validateRequest(request: MatchRequest): void {
  assertNonEmpty(request.taskId, "taskId");
  assertNonEmpty(request.gameId, "gameId");
  if (!Number.isInteger(request.requiredAgents) || request.requiredAgents < 1) {
    throw new Error("requiredAgents must be a positive integer");
  }
  validateInventory(request.inventory ?? {});
}

function validateInventory(inventory: Readonly<Record<string, number>>): void {
  for (const [item, amount] of Object.entries(inventory)) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Inventory amount for "${item}" must be a non-negative number`);
    }
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function copyMatch(match: MatchRecord): MatchRecord {
  return { ...match, agentIds: [...match.agentIds] };
}
