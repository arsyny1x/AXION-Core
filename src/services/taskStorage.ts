import { Crosshair, FileCode2, FlaskConical, Layers, RefreshCw, Users } from "lucide-react";
import type { Task, TaskColor, TaskStatus } from "../data/mock";

const STORAGE_KEY = "axion.tasks.v1";
const LEGACY_STORAGE_KEY = "autohub.tasks.v1";

const TASK_PRESENTATION: Record<string, { icon: Task["icon"]; color: TaskColor }> = {
  "Blox Fruits": { icon: Users, color: "blue" },
  Raid: { icon: Crosshair, color: "violet" },
  Test: { icon: FlaskConical, color: "green" },
  Script: { icon: FileCode2, color: "amber" },
  Team: { icon: RefreshCw, color: "pink" },
};

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "running" || value === "pending" || value === "done";
}

export function loadSavedTasks(): Task[] {
  const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return [];
  if (!localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, raw);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Saved tasks must be an array");

  return parsed.flatMap((entry): Task[] => {
    if (
      typeof entry !== "object" || entry === null ||
      typeof entry.id !== "number" ||
      typeof entry.title !== "string" ||
      entry.isMockup === true ||
      entry.mockupType === "patrol" ||
      entry.mockupType === "raid" ||
      entry.mockupType === "test" ||
      typeof entry.desc !== "string" ||
      typeof entry.tag !== "string" ||
      !isTaskStatus(entry.status) ||
      typeof entry.progress !== "number" ||
      typeof entry.total !== "number" ||
      typeof entry.created !== "string" ||
      typeof entry.updated !== "string"
    ) return [];

    const presentation = TASK_PRESENTATION[entry.tag] ?? { icon: Layers, color: "violet" as const };
    return [{
      ...entry,
      icon: presentation.icon,
      color: presentation.color,
    }];
  });
}

export function saveTasks(tasks: Task[]): void {
  const serializable = tasks.map(({ icon: _icon, ...task }) => task);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}
