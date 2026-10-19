import { describe, expect, it } from "vitest";
import { MatchingEngine } from "../central/MatchingEngine";

describe("Central MatchingEngine", () => {
  it("returns no_match immediately when no online agent meets the criteria", () => {
    const engine = createEngine();
    engine.updateAgent(agent("a", { level: 1 }, { token: 1 }));
    const result = engine.requestMatch({
      taskId: "task-1",
      gameId: "game",
      requesterAgentId: "requester",
      requiredAgents: 2,
      state: { level: 1 },
      inventory: { token: 2 },
    });
    expect(result).toEqual({ status: "no_match", taskId: "task-1" });
  });

  it("matches qualified agents and reserves them until cancellation", () => {
    const engine = createEngine();
    engine.updateAgent(agent("requester"));
    engine.updateAgent(agent("a", { region: "apac" }, { pass: 2 }));
    engine.updateAgent(agent("b", { region: "apac" }, { pass: 3 }));

    const result = engine.requestMatch({
      taskId: "task-1",
      gameId: "game",
      requesterAgentId: "requester",
      requiredAgents: 2,
      state: { region: "apac" },
      inventory: { pass: 1 },
    });
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.match.agentIds).toEqual(["a", "b"]);
    expect(engine.getAgent("a")?.reservedBy).toBe(result.match.id);
    expect(engine.requestMatch({
      taskId: "task-2", gameId: "game", requiredAgents: 2, state: { region: "apac" },
    }).status).toBe("no_match");
    expect(engine.cancelTask("task-1")).toBe(true);
    expect(engine.getAgent("a")?.reservedBy).toBeNull();
  });

  it("marks stale agents offline and releases matches after expiration", () => {
    let now = 1_000;
    const engine = createEngine(() => now);
    engine.updateAgent(agent("a"));
    const result = engine.requestMatch({ taskId: "task", gameId: "game", requiredAgents: 1 });
    expect(result.status).toBe("matched");
    now += 51;
    engine.sweepExpired();
    expect(engine.getAgent("a")?.online).toBe(false);
    expect(engine.cancelTask("task")).toBe(false);
  });

  it("validates request shape instead of silently accepting invalid input", () => {
    const engine = createEngine();
    expect(() => engine.requestMatch({
      taskId: "task", gameId: "game", requiredAgents: 0,
    })).toThrow(/positive integer/);
    expect(() => engine.updateAgent(agent("a", {}, { potion: -1 }))).toThrow(/non-negative/);
  });
});

function createEngine(now: () => number = () => 1_000): MatchingEngine {
  let id = 0;
  return new MatchingEngine({
    now,
    createId: () => `match-${++id}`,
    offlineAfterMs: 50,
    matchTtlMs: 100,
  });
}

function agent(
  id: string,
  state: Record<string, string | number | boolean | null> = {},
  inventory: Record<string, number> = {},
) {
  return { id, gameId: "game", state, inventory };
}
