export interface AppNotification {
  id: string;
  message: string;
  createdAt: number;
  read: boolean;
}

const STORAGE_KEY = "axion.task-notifications.v1";
const MAX_NOTIFICATIONS = 200;
const listeners = new Set<() => void>();
let notifications: AppNotification[] | null = null;

function getStoredNotifications(): AppNotification[] {
  if (notifications) return notifications;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      notifications = [];
      return notifications;
    }
    if (!localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, raw);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Saved notifications must be an array");
    notifications = parsed.filter((entry): entry is AppNotification =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as AppNotification).id === "string" &&
      typeof (entry as AppNotification).message === "string" &&
      typeof (entry as AppNotification).createdAt === "number" &&
      typeof (entry as AppNotification).read === "boolean"
    ).slice(0, MAX_NOTIFICATIONS);
    return notifications;
  } catch (error) {
    console.error("Could not load saved notifications", error);
    notifications = [];
    return notifications;
  }
}

function commit(next: AppNotification[]): void {
  notifications = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.error("Could not save notifications", error);
  }
  listeners.forEach(listener => listener());
}

export function getNotificationsSnapshot(): AppNotification[] {
  return getStoredNotifications();
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addTaskStatusNotification(message: string): void {
  const next: AppNotification[] = [{
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    message,
    createdAt: Date.now(),
    read: false,
  }, ...getStoredNotifications()].slice(0, MAX_NOTIFICATIONS);
  commit(next);
}

export function markNotificationsRead(): void {
  const current = getStoredNotifications();
  if (current.every(notification => notification.read)) return;
  commit(current.map(notification => ({ ...notification, read: true })));
}

export function clearNotifications(): void {
  if (getStoredNotifications().length === 0) return;
  commit([]);
}
