import { describe, expect, it, vi } from "vitest";
import { AXIONClient } from "../sdk/AXIONClient";
import { MockCoreTransport } from "../../lua-api/transport/MockCoreTransport";
import { createEnvelope } from "../../lua-api/transport/ICoreTransport";
import { LuaApiError } from "../../lua-api/errors";

describe("AXION Lua SDK facade", () => {
  it("reports state, emits typed transport events, and resolves matching responses", async () => {
    const transport = new MockCoreTransport();
    const sdk = new AXIONClient(transport, () => "request-1");
    await sdk.connect({ clientId: "agent-1" });
    const callback = vi.fn();
    sdk.on("task.assigned", callback);

    const response = sdk.request("team.match", { role: "support" });
    await Promise.resolve();
    const sent = transport.getSentMessages();
    const request = sent[sent.length - 1];
    transport.emitMessage(createEnvelope(
      "task.assigned",
      { taskId: request.correlationId, status: "matched", data: { matchId: "match-1" } },
      { id: "server-1", correlationId: request.correlationId },
    ));
    await expect(response).resolves.toEqual({
      taskId: request.correlationId,
      status: "matched",
      data: { matchId: "match-1" },
    });
    expect(callback).toHaveBeenCalledWith({
      taskId: request.correlationId,
      status: "matched",
      data: { matchId: "match-1" },
    });

    await sdk.report({ status: "ready", inventory: { pass: 2 } });
    expect(sdk.getState()).toEqual({ status: "ready", inventory: { pass: 2 } });
    await sdk.disconnect();
    sdk.dispose();
  });

  it("rejects unsupported protocol versions and reports request timeout", async () => {
    const transport = new MockCoreTransport();
    const sdk = new AXIONClient(transport);
    await expect(sdk.connect({ protocolVersion: "99.0" })).rejects.toBeInstanceOf(LuaApiError);
    await sdk.connect({ autoReconnect: false });
    await expect(sdk.request("slow.task", {}, 5)).rejects.toMatchObject({ code: "TIMEOUT" });
    await sdk.disconnect();
    sdk.dispose();
  });

  it("sends cancellation and rejects its pending request", async () => {
    const transport = new MockCoreTransport();
    const sdk = new AXIONClient(transport, () => "task-1");
    await sdk.connect({});
    const response = sdk.request("long.task");
    await sdk.cancel("task-1");
    await expect(response).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport.getSentMessages().map((message) => message.type)).toContain("task.cancel");
  });

  it("rejects malformed central responses and reconnects after a dropped connection", async () => {
    const transport = new MockCoreTransport();
    const sdk = new AXIONClient(transport, () => "task-1");
    await sdk.connect({ reconnectDelayMs: 0 });
    const response = sdk.request("team.match");
    await Promise.resolve();
    const sentRequest = transport.getSentMessages().find((message) => message.type === "task.request");
    expect(sentRequest).toBeDefined();
    transport.emitMessage(createEnvelope(
      "task.result",
      { taskId: "task-1" },
      { id: "server-response", correlationId: "task-1" },
    ));
    await expect(response).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });

    vi.useFakeTimers();
    try {
      transport.setState("disconnected");
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.getState()).toBe("connected");
    } finally {
      await sdk.disconnect();
      sdk.dispose();
      vi.useRealTimers();
    }
  });
});
