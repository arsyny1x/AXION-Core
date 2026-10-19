import type { LucideIcon } from "lucide-react";
export type TaskStatus = "running" | "pending" | "done";
export type TaskColor = "blue" | "violet" | "green" | "amber" | "pink";
export type MockupTaskType = "patrol" | "raid" | "test";

export interface Task {
  id: number;
  title: string;
  desc: string;
  tag: string;
  people?: number;
  agentIds?: string[];
  icon: LucideIcon;
  color: TaskColor;
  status: TaskStatus;
  progress: number;
  total: number;
  created: string;
  updated: string;
  isMockup?: boolean;
  mockupType?: MockupTaskType;
}

export interface Agent {
  id: string;
  location: string;
  online: boolean;
  uptime: string;
  load: number;
}

export interface LogEntry {
  id?: number;
  timestamp?: number;
  time: string;
  source: string;
  text: string;
  level: "info" | "ok" | "warn" | "error";
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "ทำงาน",
  pending: "รอ",
  done: "เสร็จสิ้น",
};
