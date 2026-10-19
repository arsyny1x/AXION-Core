import type { PlayerStatus } from "../lua-api/types";

export interface DemoPlayer {
  id: string;
  name: string;
  status: PlayerStatus;
  uptime: string;
  task: string;
  description: string;
  progress: number | null;
}

const STORAGE_KEY = "axion.players.demo.v1";
const TASK_STORAGE_KEY = "axion.tasks.demo.v1";

const DEFAULT_DEMO_PLAYERS: DemoPlayer[] = [
  { id: "DEMO-001", name: "NovaRunner", status: "online", uptime: "2h 15m", task: "Patrolling server", description: "Online and checking the server area.", progress: 68 },
  { id: "DEMO-002", name: "PixelScout", status: "busy", uptime: "48m", task: "Collecting resources", description: "Working through an assigned collection task.", progress: 34 },
  { id: "DEMO-003", name: "CloudBuilder", status: "idle", uptime: "12m", task: "", description: "Connected and available for a new task.", progress: null },
  { id: "DEMO-004", name: "EchoPilot", status: "offline", uptime: "—", task: "", description: "Last session ended; waiting to reconnect.", progress: null },
];

const PLAYER_STATUSES: PlayerStatus[] = ["online", "busy", "idle", "offline", "error"];

function isDemoPlayer(value: unknown): value is DemoPlayer {
  if (typeof value !== "object" || value === null) return false;
  const player = value as Record<string, unknown>;
  return typeof player.id === "string" &&
    typeof player.name === "string" &&
    PLAYER_STATUSES.some((status) => status === player.status) &&
    typeof player.uptime === "string" &&
    typeof player.task === "string" &&
    typeof player.description === "string" &&
    (player.progress === null || (typeof player.progress === "number" && player.progress >= 0 && player.progress <= 100));
}

export function loadDemoPlayers(): DemoPlayer[] {
  localStorage.removeItem(TASK_STORAGE_KEY);
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return DEFAULT_DEMO_PLAYERS.map((player) => ({ ...player }));

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isDemoPlayer)) {
    throw new Error("Saved demo players have an invalid format");
  }
  return parsed;
}

export function saveDemoPlayers(players: DemoPlayer[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
}

export function createDemoPlayerId(): string {
  return `DEMO-${Date.now().toString(36).toUpperCase()}`;
}
