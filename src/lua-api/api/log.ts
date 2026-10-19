/**
 * Core.log — script-scoped logging.
 *
 * Records include timestamp, script id, level, and message. Logs are forwarded
 * to an injected `ILogger`; when no logger is provided, records are queued in
 * memory (bounded) so integrators can drain them later.
 */

import { err } from "../errors";
import type { ILogger, ILogApi, LogLevel, LogRecord } from "../types";

export interface LogApiOptions {
  logger?: ILogger;
  scriptId: string | null;
  now: () => number;
  /** Bounded buffer size when no logger is provided. */
  bufferSize?: number;
}

const DEFAULT_BUFFER = 1000;

export interface LogApi extends ILogApi {
  /** Drain buffered records (only used when no `logger` was supplied). */
  drainBuffer(): LogRecord[];
  /** Read-only snapshot of the current buffer. */
  peekBuffer(): readonly LogRecord[];
}

export function createLogApi(options: LogApiOptions): LogApi {
  const buffer: LogRecord[] = [];
  const bufferSize = options.bufferSize ?? DEFAULT_BUFFER;

  function emit(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    const record: LogRecord = {
      timestamp: options.now(),
      level,
      scriptId: options.scriptId,
      message: assertMessage(message),
    };
    if (metadata !== undefined) {
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw err.invalidArgument("metadata must be a plain object when provided");
      }
      record.metadata = metadata;
    }
    if (options.logger) {
      options.logger.log(record);
    } else {
      if (buffer.length >= bufferSize) buffer.shift();
      buffer.push(record);
    }
  }

  return {
    debug: (message, metadata) => emit("debug", message, metadata),
    info: (message, metadata) => emit("info", message, metadata),
    warn: (message, metadata) => emit("warn", message, metadata),
    error: (message, metadata) => emit("error", message, metadata),
    drainBuffer: () => {
      const out = buffer.slice();
      buffer.length = 0;
      return out;
    },
    peekBuffer: () => buffer.slice(),
  };
}

function assertMessage(message: unknown): string {
  if (typeof message !== "string") {
    throw err.invalidArgument("log message must be a string");
  }
  return message;
}