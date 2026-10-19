/**
 * Singleton wrapper around the Lua API module for the AXION app.
 *
 * Uses a mock Core transport with a real Wasmoon Lua runtime.
 */

import {
  createLuaApiModule,
  MockCoreTransport,
  type LuaApiModule,
} from "../lua-api";
import { WasmoonLuaRuntime } from "../lua-api/runtime/WasmoonLuaRuntime";
import { writeLog } from "./logService";

let instance: LuaApiModule | null = null;

export function getLuaApi(): LuaApiModule {
  if (!instance) {
    instance = createLuaApiModule({
      transport: new MockCoreTransport({ latencyMs: 10 }),
      luaRuntime: new WasmoonLuaRuntime(),
      defaultConfig: {
        "worker.region": "sg",
        "worker.maxTasks": 3,
      },
      logger: {
        log: (record) => {
          let metadata = "";
          if (record.metadata) {
            try {
              metadata = ` ${JSON.stringify(record.metadata)}`;
            } catch {
              metadata = " [metadata could not be serialized]";
            }
          }
          const level = record.level === "debug" ? "info" : record.level;
          writeLog(level, `lua:${record.scriptId ?? "shared"}`, `${record.message}${metadata}`, record.timestamp);
        },
      },
    });
  }
  return instance;
}
