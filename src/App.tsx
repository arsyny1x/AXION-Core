import ApiDocsPage from "./components/ApiDocsPage";
import PlayersPage from "./components/PlayersPage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { CheckCircle2, Clock3, ListTodo, Monitor, MonitorX, Play, Users, Crosshair, FileCode2 } from "lucide-react";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import WelcomeBanner from "./components/WelcomeBanner";
import TaskBoard from "./components/TaskBoard";
import AgentsPanel from "./components/AgentsPanel";
import LiveLog from "./components/LiveLog";
import TaskControls from "./components/TaskControls";
import ServerScriptsPage from "./components/ServerScriptsPage";
import SettingsPage from "./components/SettingsPage";
import Toaster from "./components/Toaster";
import { LanguageProvider, useLanguage } from "./i18n/LanguageContext";
import type { LanguageMessageKey } from "./i18n/languages";
import { type Task, type TaskStatus } from "./data/mock";
import { getLuaApi } from "./services/luaApiService";
import { playerService } from "./services/playerService";
import { loadSavedServerScripts } from "./services/serverScriptsService";
import { loadSavedTasks, saveTasks } from "./services/taskStorage";
import { addTaskStatusNotification } from "./services/notificationService";
import { writeLog } from "./services/logService";

const PAGE_INFO: Record<string, { title: LanguageMessageKey; description: LanguageMessageKey }> = {
  home: { title: "page.home.title", description: "page.home.description" },
  tasks: { title: "page.tasks.title", description: "page.tasks.description" },
  players: { title: "page.players.title", description: "page.players.description" },
  database: { title: "page.database.title", description: "page.database.description" },
  scripts: { title: "page.scripts.title", description: "page.scripts.description" },
  "api-docs": { title: "page.docs.title", description: "page.docs.description" },
  console: { title: "page.console.title", description: "page.console.description" },
  settings: { title: "nav.settings", description: "settings.languageDescription" },
};

type TaskFilter = "all" | TaskStatus;
type Theme = "dark" | "light";
interface StartupStatus {
  progress: number;
  message: string;
}
const THEME_STORAGE_KEY = "axion.theme";
const LEGACY_THEME_STORAGE_KEY = "autohub.theme";

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}

function AppContent() {
  const { t } = useLanguage();
  const translateRef = useRef(t);
  translateRef.current = t;
  const [page, setPage] = useState("home");
  const [taskQuery, setTaskQuery] = useState("");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [tasks, setTasks] = useState<Task[]>(() => {
    try {
      return loadSavedTasks();
    } catch (error) {
      console.error("Could not load saved tasks", error);
      return [];
    }
  });
  const [uptimeStartedAt] = useState(() => Date.now());
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY) ?? localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
      if (stored) localStorage.setItem(THEME_STORAGE_KEY, stored);
      return stored === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const [playerCount, setPlayerCount] = useState(0);
  const [onlinePlayerCount, setOnlinePlayerCount] = useState(0);
  const [offlinePlayerCount, setOfflinePlayerCount] = useState(0);
  const [serverConnected, setServerConnected] = useState(() => playerService.isConnected());
  const [scriptCount, setScriptCount] = useState(0);
  const [luaReady, setLuaReady] = useState(false);
  const [luaError, setLuaError] = useState<string | null>(null);
  const [appReady, setAppReady] = useState(false);
  const [startupStatus, setStartupStatus] = useState<StartupStatus>({
    progress: 0,
    message: "Preparing application...",
  });
  const [playerToOpen, setPlayerToOpen] = useState<string | null>(null);

  const notify = useCallback((message: string) => {
    writeLog("info", "notification", message);
    setToast({ id: Date.now(), message });
  }, []);

  useEffect(() => {
    try {
      saveTasks(tasks);
    } catch (error) {
      notify(translateRef.current("agents.operationFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }, [notify, tasks]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void loadSavedServerScripts()
      .then(({ errors }) => {
        if (active) errors.forEach(notify);
      })
      .catch(error => {
        if (active) {
          notify(translateRef.current("serverScript.initializationFailed", { detail: error instanceof Error ? error.message : String(error) }));
        }
      });
    return () => { active = false; };
  }, [notify]);

  useEffect(() => {
    document.body.classList.toggle("light", theme === "light");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      notify(translateRef.current("settings.themeSaveFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }, [notify, theme]);

  useEffect(() => {
    let active = true;
    let initializationTimeoutId: number | undefined;
    let finishSplashTimeoutId: number | undefined;
    const minimumSplashTime = new Promise((resolve) => window.setTimeout(resolve, 800));

    void (async () => {
      writeLog("info", "startup", "Initializing Lua runtime");
      setStartupStatus({ progress: 12, message: "Preparing workspace..." });
      try {
        const api = getLuaApi();
        setStartupStatus({ progress: 35, message: "Initializing Lua runtime..." });
        const initializationTimeout = new Promise<never>((_, reject) => {
          initializationTimeoutId = window.setTimeout(
            () => reject(new Error("Lua runtime initialization timed out after 10 seconds")),
            10_000,
          );
        });
        await Promise.race([api.runtime.initialize(), initializationTimeout]);
        if (active) {
          setLuaReady(true);
          writeLog("ok", "startup", "Lua runtime initialized");
          setStartupStatus({ progress: 72, message: "Starting local services..." });
        }
      } catch (err) {
        if (active) {
          setLuaError(err instanceof Error ? err.message : String(err));
          writeLog("error", "startup", `Lua runtime initialization failed: ${err instanceof Error ? err.message : String(err)}`);
          setStartupStatus({ progress: 90, message: "Starting with limited functionality..." });
        }
        // eslint-disable-next-line no-console
        console.error("[lua-api] init failed:", err);
      } finally {
        if (initializationTimeoutId !== undefined) {
          window.clearTimeout(initializationTimeoutId);
        }
        await minimumSplashTime;
        if (active) {
          setStartupStatus({ progress: 100, message: "Ready" });
          writeLog("ok", "startup", "Application startup complete");
          finishSplashTimeoutId = window.setTimeout(() => {
            if (active) setAppReady(true);
          }, 180);
        }
      }
    })();

    return () => {
      active = false;
      if (initializationTimeoutId !== undefined) {
        window.clearTimeout(initializationTimeoutId);
      }
      if (finishSplashTimeoutId !== undefined) {
        window.clearTimeout(finishSplashTimeoutId);
      }
    };
  }, []);

  useEffect(() => {
    playerService.start();
    const unsubscribe = playerService.subscribe((snap) => {
      setPlayerCount(snap.players.length);
      setOnlinePlayerCount(snap.players.filter((p) => p.status === "online").length);
      setOfflinePlayerCount(snap.players.filter((p) => p.status === "offline").length);
      setServerConnected(snap.connected);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const updateTask = (id: number, patch: Partial<Task>) => {
    const currentTask = tasks.find((task) => task.id === id);
    if (currentTask && patch.status !== currentTask.status) {
      const taskTitle = currentTask.mockupType
        ? t(`task.mockup${currentTask.mockupType[0].toUpperCase()}${currentTask.mockupType.slice(1)}Title`)
        : currentTask.title;
      if (patch.status === "running") {
        addTaskStatusNotification(t("task.startedTask", { title: taskTitle }));
      } else if (patch.status === "done") {
        addTaskStatusNotification(t("task.completedTask", { title: taskTitle }));
      }
    }
    setTasks((previous) => previous.map((task) => (task.id === id ? { ...task, ...patch } : task)));
    writeLog("info", `task:${id}`, `Task updated (${Object.keys(patch).join(", ")})`);
  };
  const deleteTask = (id: number) => {
    setTasks((previous) => previous.filter((task) => task.id !== id));
    writeLog("warn", `task:${id}`, "Task deleted");
  };
  const addMockupTasks = () => {
    if (tasks.some((task) => task.isMockup)) {
      notify(t("task.mockupAlreadyExists"));
      return;
    }
    setTasks((previous) => {
      if (previous.some((task) => task.isMockup)) return previous;
      const firstId = previous.reduce((maxId, task) => Math.max(maxId, task.id), 0) + 1;
      const now = new Date().toLocaleString();
      return [
        {
          id: firstId,
          title: t("task.mockupPatrolTitle"),
          desc: t("task.mockupPatrolDescription"),
          tag: "Blox Fruits",
          icon: Users,
          color: "blue",
          status: "running",
          progress: 2,
          total: 3,
          created: now,
          updated: now,
          isMockup: true,
          mockupType: "patrol",
        },
        {
          id: firstId + 1,
          title: t("task.mockupRaidTitle"),
          desc: t("task.mockupRaidDescription"),
          tag: "Raid",
          icon: Crosshair,
          color: "violet",
          status: "pending",
          progress: 0,
          total: 2,
          created: now,
          updated: now,
          isMockup: true,
          mockupType: "raid",
        },
        {
          id: firstId + 2,
          title: t("task.mockupTestTitle"),
          desc: t("task.mockupTestDescription"),
          tag: "Test",
          icon: FileCode2,
          color: "green",
          status: "done",
          progress: 4,
          total: 4,
          created: now,
          updated: now,
          isMockup: true,
          mockupType: "test",
        },
        ...previous,
      ];
    });
    notify(t("task.mockupAdded"));
  };

  const counts = {
    tasks: tasks.length,
    scripts: scriptCount,
    players: playerCount,
  };

  const runningCount = tasks.filter((t) => t.status === "running").length;
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const filteredTasks = useMemo(() => {
    const search = taskQuery.trim().toLocaleLowerCase();
    return tasks.filter((task) =>
      (taskFilter === "all" || task.status === taskFilter) &&
      (!search || [
        task.title,
        task.desc,
        task.tag,
        ...(task.mockupType ? [
          t(`task.mockup${task.mockupType[0].toUpperCase()}${task.mockupType.slice(1)}Title`),
          t(`task.mockup${task.mockupType[0].toUpperCase()}${task.mockupType.slice(1)}Description`),
        ] : []),
      ].some((value) => value.toLocaleLowerCase().includes(search)))
    );
  }, [tasks, taskQuery, taskFilter, t]);

  const taskFilterCounts = {
    all: tasks.length,
    running: runningCount,
    pending: pendingCount,
    done: doneCount,
  };

  if (!appReady) {
    return (
      <main className={`startup-screen ${theme}`} aria-live="polite">
        <div className="startup-content">
          <img src="/axion-app-icon.png" alt="" />
          <h1>AXION Core</h1>
          <p>{startupStatus.message}</p>
          <div
            className="startup-progress"
            role="progressbar"
            aria-label="Application startup"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={startupStatus.progress}
          >
            <i style={{ width: `${startupStatus.progress}%` }} />
          </div>
          <span className="startup-percent">{startupStatus.progress}%</span>
        </div>
      </main>
    );
  }

  return (
    <div className="app" onContextMenu={event => event.preventDefault()}>
      <Sidebar
        page={page}
        onNavigate={(target) => {
          if (target !== page) writeLog("info", "navigation", `Opened ${target}`);
          setPage(target);
        }}
        counts={counts}
        status={{
          online: onlinePlayerCount,
          offline: offlinePlayerCount,
          running: runningCount,
          pending: pendingCount,
          done: doneCount,
        }}
        uptimeStartedAt={uptimeStartedAt}
      />

      <div className="main">
        <TopBar
          title={PAGE_INFO[page] ? t(PAGE_INFO[page].title) : page}
          description={PAGE_INFO[page] ? t(PAGE_INFO[page].description) : ""}
          notify={notify}
          onOpenSettings={() => {
            if (page !== "settings") writeLog("info", "navigation", "Opened settings");
            setPage("settings");
          }}
          serverConnected={serverConnected}
        />

        {page === "home" ? (
          <div className="page home-page">
            <div className="content-grid">
              <div className="col-main">
                <WelcomeBanner />
                <TaskControls
                  query={taskQuery}
                  onQueryChange={setTaskQuery}
                  filter={taskFilter}
                  onFilterChange={setTaskFilter}
                  counts={taskFilterCounts}
                  layout="stacked"
                />
                <TaskBoard
                  tasks={filteredTasks}
                  onUpdate={updateTask}
                  onDelete={deleteTask}
                  notify={notify}
                />
              </div>
              <aside className="col-side">
                <section className="card home-stats-panel" aria-label={t("system.status")}>
                  <header className="card-head">
                    <div className="card-title">
                      <Monitor size={16} />
                      <h2>{t("system.status")}</h2>
                    </div>
                  </header>
                  <div className="home-activity-stats">
                    <div className="home-activity-stat online">
                      <Monitor size={19} />
                      <span>{t("system.agentOnline")}</span>
                      <b>{onlinePlayerCount}</b>
                    </div>
                    <div className="home-activity-stat offline">
                      <MonitorX size={19} />
                      <span>{t("system.agentOffline")}</span>
                      <b>{offlinePlayerCount}</b>
                    </div>
                    <div className="home-activity-stat running">
                      <Play size={19} />
                      <span>{t("system.running")}</span>
                      <b>{runningCount}</b>
                    </div>
                  </div>
                </section>
                <AgentsPanel
                  notify={notify}
                  onOpenPlayer={(playerId) => {
                    setPlayerToOpen(playerId);
                    setPage("players");
                  }}
                />
              </aside>
            </div>
          </div>
        ) : page === "tasks" ? (
          <div className="page task-dashboard">
            <div className="task-dashboard-stats">
              <div className="player-stat tone-blue">
                <div className="player-stat-ic"><ListTodo size={18} /></div>
                <div className="player-stat-meta">
                  <b>{tasks.length}</b>
                  <span>{t("nav.tasks")}</span>
                </div>
              </div>
              <div className="player-stat tone-violet">
                <div className="player-stat-ic"><Play size={18} /></div>
                <div className="player-stat-meta">
                  <b>{runningCount}</b>
                  <span>{t("common.running")}</span>
                </div>
              </div>
              <div className="player-stat tone-amber">
                <div className="player-stat-ic"><Clock3 size={18} /></div>
                <div className="player-stat-meta">
                  <b>{pendingCount}</b>
                  <span>{t("common.pending")}</span>
                </div>
              </div>
              <div className="player-stat tone-green">
                <div className="player-stat-ic"><CheckCircle2 size={18} /></div>
                <div className="player-stat-meta">
                  <b>{doneCount}</b>
                  <span>{t("common.done")}</span>
                </div>
              </div>
            </div>

            <TaskControls
              query={taskQuery}
              onQueryChange={setTaskQuery}
              filter={taskFilter}
              onFilterChange={setTaskFilter}
              counts={taskFilterCounts}
            />
            <TaskBoard
              tasks={filteredTasks}
              onUpdate={updateTask}
              onDelete={deleteTask}
              notify={notify}
              onAddMockup={addMockupTasks}
              hasMockupTasks={tasks.some((task) => task.isMockup)}
            />
          </div>
        ) : page === "api-docs" ? (
          <div className="page page-docs">
            <ApiDocsPage notify={notify} />
          </div>
        ) : page === "players" ? (
          <PlayersPage
            notify={notify}
            tasks={tasks}
            initialProfilePlayerId={playerToOpen}
            onInitialProfileOpened={() => setPlayerToOpen(null)}
          />
        ) : page === "scripts" ? (
          <ServerScriptsPage notify={notify} onCountChange={setScriptCount} />
        ) : page === "database" ? (
          <ServerScriptsPage view="database" notify={notify} onCountChange={setScriptCount} />
        ) : page === "console" ? (
          <div className="page console-page">
            <LiveLog fullPage />
          </div>
        ) : page === "settings" ? (
          <SettingsPage notify={notify} theme={theme} onThemeChange={setTheme} />
        ) : (
          <div className="page">
            <section className="card placeholder-card">
              <h2>{t("app.name")}</h2>
              <p>{t("app.name")}</p>
              <button className="btn-primary" onClick={() => setPage("home")}>
                {t("common.backHome")}
              </button>
            </section>
          </div>
        )}

      </div>

      <Toaster toast={toast} />
    </div>
  );
}
