import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LogEntry } from "../data/mock";

export const MAX_LOG_ENTRIES = 2_000;
const MAX_LOG_MESSAGE_LENGTH = 8_192;

type LogLevel = LogEntry["level"];
type LogListener = (entries: readonly LogEntry[]) => void;

const entries: LogEntry[] = [];
const listeners = new Set<LogListener>();
let sequence = 0;
let initialized = false;
let notificationScheduled = false;

function formatValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function notifyListeners(): void {
  if (listeners.size === 0 || notificationScheduled) return;
  notificationScheduled = true;
  const publish = () => {
    notificationScheduled = false;
    for (const listener of [...listeners]) listener(entries);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(publish);
  else setTimeout(publish, 0);
}

export function writeLog(
  level: LogLevel,
  source: string,
  message: string,
  timestamp = Date.now(),
): void {
  const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
  const safeMessage = typeof message === "string" ? message : formatValue(message);
  const safeSource = typeof source === "string" ? source : formatValue(source);
  const date = new Date(safeTimestamp);
  const text = safeMessage.length > MAX_LOG_MESSAGE_LENGTH
    ? `${safeMessage.slice(0, MAX_LOG_MESSAGE_LENGTH)}… [truncated]`
    : safeMessage;
  entries.unshift({
    id: ++sequence,
    timestamp: safeTimestamp,
    time: date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
    source: safeSource.slice(0, 256),
    text,
    level,
  });
  if (entries.length > MAX_LOG_ENTRIES) entries.length = MAX_LOG_ENTRIES;
  notifyListeners();
}

export function getLogs(): readonly LogEntry[] {
  return entries;
}

export function subscribeLogs(listener: LogListener): () => void {
  listeners.add(listener);
  listener(entries);
  return () => listeners.delete(listener);
}

export function clearLogs(): void {
  if (entries.length === 0) return;
  entries.length = 0;
  notifyListeners();
}

export function initializeLogService(): void {
  if (initialized) return;
  initialized = true;

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const logLevel: LogLevel = level === "error" ? "error" : level === "warn" ? "warn" : "info";
      writeLog(logLevel, `console.${level}`, args.map(formatValue).join(" "));
      original(...args);
    };
  }

  window.addEventListener("error", (event) => {
    writeLog("error", "window", event.error instanceof Error
      ? event.error.stack ?? event.error.message
      : event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    writeLog("error", "promise", formatValue(event.reason));
  });

  writeLog("info", "app", "Application log capture started");
  if (!isTauri()) return;

  const registrations: Array<Promise<() => void>> = [
    listen<{ agentId: string; message: string; timestamp: number }>("axion-agent-log", ({ payload }) => {
      writeLog("info", `agent:${payload.agentId}`, payload.message, payload.timestamp);
    }),
    listen<{ agentId: string; message: string }>("axion-agent-protocol-error", ({ payload }) => {
      writeLog("error", `agent:${payload.agentId}`, payload.message);
    }),
    listen<{ id: string; name?: string }>("axion-agent-connected", ({ payload }) => {
      writeLog("ok", "agents", `Agent connected: ${payload.name ?? payload.id} (${payload.id})`);
    }),
    listen<{ id: string }>("axion-agent-disconnected", ({ payload }) => {
      writeLog("warn", "agents", `Agent disconnected: ${payload.id}`);
    }),
    listen<{ id: string }>("axion-agent-deleted", ({ payload }) => {
      writeLog("info", "agents", `Agent removed: ${payload.id}`);
    }),
    listen<{ agentId: string; name: string; payload?: unknown }>("axion-agent-message", ({ payload }) => {
      writeLog("info", `agent:${payload.agentId}`, `Message ${payload.name}: ${formatValue(payload.payload)}`);
    }),
    listen<{
      agentId: string;
      customGameId: string;
      accountId: string;
      items: unknown[];
      inventoryDelta: boolean;
      reportedItemCount: number;
      removedItemCount: number;
      messageSizeBytes?: number;
      maxMessageBytes?: number;
    }>(
      "axion-item-cache-updated",
      ({ payload }) => {
        if (payload.messageSizeBytes === undefined || !payload.maxMessageBytes) return;
        const messageSize = `, message ${payload.messageSizeBytes} / ${payload.maxMessageBytes} bytes (${(payload.messageSizeBytes / payload.maxMessageBytes * 100).toFixed(1)}%)`;
        const reportSummary = payload.inventoryDelta
          ? `${payload.reportedItemCount} changed values, ${payload.removedItemCount} removed`
          : `${payload.reportedItemCount} items reported`;
        writeLog(
          "info",
          `agent:${payload.agentId}`,
          `Inventory cache updated (${payload.items.length} items cached; ${reportSummary}, ${payload.customGameId}/${payload.accountId}${messageSize})`,
        );
      },
    ),
    listen<{ playerId: string }>("axion-item-cache-offline", ({ payload }) => {
      writeLog("warn", `agent:${payload.playerId}`, "Inventory cache marked offline");
    }),
  ];
  const unlisteners: Array<() => void> = [];
  let acceptingListeners = true;

  void Promise.all(registrations.map((registration) =>
    registration.then((unlisten) => {
      if (acceptingListeners) unlisteners.push(unlisten);
      else unlisten();
    }),
  )).catch((error: unknown) => {
    acceptingListeners = false;
    unlisteners.forEach((unlisten) => unlisten());
    writeLog("error", "logging", `Could not subscribe to native events: ${formatValue(error)}`);
  });
}
