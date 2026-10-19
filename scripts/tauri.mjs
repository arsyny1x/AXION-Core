import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const cargoBin = path.join(
  process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"),
  "bin",
);
process.env.PATH = [cargoBin, process.env.PATH].filter(Boolean).join(path.delimiter);

const require = createRequire(import.meta.url);
const tauriCliPath = require.resolve("@tauri-apps/cli/tauri.js");
process.argv[1] = tauriCliPath;
require(tauriCliPath);
