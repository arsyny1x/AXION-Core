import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearLogs,
  getLogs,
  MAX_LOG_ENTRIES,
  subscribeLogs,
  writeLog,
} from "../logService";

afterEach(() => clearLogs());

describe("application log service", () => {
  it("retains and publishes recent entries before the console is mounted", async () => {
    writeLog("info", "lua:script-a", "Script started", 1_700_000_000_000);
    const listener = vi.fn();
    const unsubscribe = subscribeLogs(listener);

    expect(listener).toHaveBeenCalledWith(getLogs());
    expect(getLogs()[0]).toMatchObject({
      source: "lua:script-a",
      text: "Script started",
      level: "info",
    });
    expect(getLogs()[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/);

    writeLog("error", "runtime", "Runtime failure");
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(2);
    });
    expect(listener).toHaveBeenLastCalledWith(getLogs());
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("keeps one bounded log buffer rather than copying it for each read", () => {
    writeLog("info", "test", "before");
    const existingBuffer = getLogs();

    writeLog("info", "test", "after");

    expect(getLogs()).toBe(existingBuffer);
    expect(getLogs()[0].text).toBe("after");
  });

  it("bounds stored entries and clears the complete log history", () => {
    for (let index = 0; index <= MAX_LOG_ENTRIES; index += 1) {
      writeLog("info", "test", `entry-${index}`);
    }
    expect(getLogs()).toHaveLength(MAX_LOG_ENTRIES);
    expect(getLogs()[0].text).toBe(`entry-${MAX_LOG_ENTRIES}`);
    expect(getLogs()[MAX_LOG_ENTRIES - 1].text).toBe("entry-1");

    clearLogs();
    expect(getLogs()).toHaveLength(0);
  });

  it("truncates large messages to keep memory usage bounded", () => {
    writeLog("info", "test", "x".repeat(10_000));
    expect(getLogs()[0].text).toHaveLength(8_192 + "… [truncated]".length);
  });
});
