import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  Users,
  WifiOff,
  Activity,
  Search,
  RefreshCw,
  Clock,
  Copy,
  MapPin,
  Server,
  X,
  UserRound,
  Play,
  Trash2,
} from "lucide-react";
import {
  playerService,
  MAX_SCRIPT_BYTES,
  type PlayerRegistrySnapshot,
} from "../services/playerService";
import type { PlayerStatus } from "../lua-api/types";
import type { PlayerInfo } from "../lua-api/types";
import type { Task } from "../data/mock";
import { useLanguage } from "../i18n/LanguageContext";
import { SyntaxCodeEditor } from "./SyntaxCode";
import {
  getRobloxAvatarSnapshot,
  invalidateRobloxAvatar,
  requestRobloxAvatars,
  subscribeRobloxAvatars,
} from "../services/robloxAvatarService";

type Filter = "all" | PlayerStatus;
const DEFAULT_EXECUTE_SCRIPT = 'print("Hello from AXION")';

let liveClock = Date.now();
let liveClockInterval: number | null = null;
const liveClockListeners = new Set<() => void>();

function subscribeLiveClock(listener: () => void) {
  liveClockListeners.add(listener);
  if (liveClockInterval === null) {
    liveClockInterval = window.setInterval(() => {
      liveClock = Date.now();
      liveClockListeners.forEach(notify => notify());
    }, 1_000);
  }
  return () => {
    liveClockListeners.delete(listener);
    if (liveClockListeners.size === 0 && liveClockInterval !== null) {
      window.clearInterval(liveClockInterval);
      liveClockInterval = null;
    }
  };
}

function getLiveClock() {
  return liveClock;
}

const LiveTime = memo(function LiveTime({
  timestamp,
  mode,
}: {
  timestamp?: number;
  mode: "heartbeat" | "connected" | "fetch";
}) {
  const now = useSyncExternalStore(subscribeLiveClock, getLiveClock, getLiveClock);
  const { t } = useLanguage();

  if (!timestamp) {
    return <>{mode === "fetch" ? t("player.noData") : "—"}</>;
  }

  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (mode === "heartbeat") return <> · {elapsedSeconds}</>;
  if (mode === "connected") {
    const totalSeconds = elapsedSeconds;
    const minutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(minutes / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return <>{t("player.durationHoursMinutesSeconds", { hours, minutes: minutes % 60, seconds })}</>;
    }
    if (minutes > 0) return <>{t("player.durationMinutesSeconds", { minutes, seconds })}</>;
    return <>{t("player.durationSeconds", { seconds })}</>;
  }
  if (elapsedSeconds < 60) return <>{t("player.secondsAgo", { count: elapsedSeconds })}</>;
  if (elapsedSeconds < 3600) return <>{t("player.minutesAgo", { count: Math.floor(elapsedSeconds / 60) })}</>;
  return <>{t("player.hoursAgo", { count: Math.floor(elapsedSeconds / 3600) })}</>;
});

export default function PlayersPage({
  notify,
  tasks,
  initialProfilePlayerId,
  onInitialProfileOpened,
}: {
  notify: (m: string) => void;
  tasks: Task[];
  initialProfilePlayerId?: string | null;
  onInitialProfileOpened?: () => void;
}) {
  const { t, language } = useLanguage();
  const statusLabel = (status: PlayerStatus) => {
    if (status === "online") return t("common.online");
    if (status === "busy") return t("player.busy");
    if (status === "idle") return t("common.pending");
    if (status === "offline") return t("player.offline");
    return t("player.error");
  };
  const [snapshot, setSnapshot] = useState<PlayerRegistrySnapshot>(() => ({
    players: playerService.getPlayers(),
    updatedAt: Date.now(),
    connected: playerService.isConnected(),
    serverError: null,
  }));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [profilePlayerId, setProfilePlayerId] = useState<string | null>(null);
  const [profileLastSeenAt, setProfileLastSeenAt] = useState<number | undefined>();
  const [multiSelectedPlayerIds, setMultiSelectedPlayerIds] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; playerId: string } | null>(null);
  const [executePlayerIds, setExecutePlayerIds] = useState<string[]>([]);
  const [scriptDraft, setScriptDraft] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [robloxProfile, setRobloxProfile] = useState<{
    displayName: string;
    username: string;
  } | null>(null);
  const avatarUrls = useSyncExternalStore(
    subscribeRobloxAvatars,
    getRobloxAvatarSnapshot,
    getRobloxAvatarSnapshot,
  );
  const avatarPlayers = useMemo(
    () => snapshot.players.map(({ id, name }) => ({ id, name })),
    [snapshot.players],
  );
  const selectedPlayer = snapshot.players.find((player) => player.id === profilePlayerId) ?? null;
  const selectedAvatarUrl = selectedPlayer ? avatarUrls[selectedPlayer.id] : undefined;
  const contextPlayer = snapshot.players.find((player) => player.id === contextMenu?.playerId) ?? null;
  const executePlayers = executePlayerIds
    .map((id) => snapshot.players.find((player) => player.id === id))
    .filter((player): player is PlayerInfo => player !== undefined);
  const executePlayer = executePlayers[0] ?? null;
  const scriptBytes = new TextEncoder().encode(`execute ${scriptDraft}`).byteLength;
  const scriptTooLarge = scriptBytes > MAX_SCRIPT_BYTES;

  useEffect(() => {
    playerService.start();
    const off = playerService.subscribe((next) => {
      setSnapshot(current =>
        current.players === next.players &&
        current.connected === next.connected &&
        current.serverError === next.serverError
          ? current
          : next,
      );
    });
    return () => off();
  }, []);

  useEffect(() => {
    try {
      localStorage.removeItem("axion.players.demo.v1");
      localStorage.removeItem("axion.tasks.demo.v1");
    } catch (error) {
      console.error("Could not remove legacy demo data", error);
    }
  }, []);

  useEffect(() => {
    if (!initialProfilePlayerId) return;
    setProfilePlayerId(initialProfilePlayerId);
    onInitialProfileOpened?.();
  }, [initialProfilePlayerId, onInitialProfileOpened]);

  useEffect(() => {
    requestRobloxAvatars(avatarPlayers);
  }, [avatarPlayers]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!profilePlayerId) return;
    setProfileLastSeenAt(playerService.getPlayer(profilePlayerId)?.lastSeenAt);
    const unsubscribeHeartbeat = playerService.subscribeHeartbeats((agentId, lastSeenAt) => {
      if (agentId === profilePlayerId) setProfileLastSeenAt(lastSeenAt);
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfilePlayerId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      unsubscribeHeartbeat();
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [profilePlayerId]);

  useEffect(() => {
    if (executePlayerIds.length === 0) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isExecuting) setExecutePlayerIds([]);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [executePlayerIds.length, isExecuting]);

  const stats = useMemo(() => {
    const players = snapshot.players;
    return {
      total: players.length,
      online: players.filter((p) => p.status === "online").length,
      busy: players.filter((p) => p.status === "busy").length,
      idle: players.filter((p) => p.status === "idle").length,
      offline: players.filter((p) => p.status === "offline").length,
    };
  }, [snapshot.players]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snapshot.players
      .filter((p) => filter === "all" || p.status === filter)
      .filter((p) => {
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          (p.placeId ?? "").toLowerCase().includes(q) ||
          (p.guild ?? "").toLowerCase().includes(q) ||
          (p.job ?? "").toLowerCase().includes(q) ||
          (p.server ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const rank: Record<PlayerStatus, number> = {
          online: 0,
          busy: 1,
          idle: 2,
          error: 3,
          offline: 4,
        };
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return a.name.localeCompare(b.name);
      });
  }, [snapshot.players, query, filter]);

  const togglePlayerSelection = (playerId: string) => {
    setSelectedPlayerId(null);
    setMultiSelectedPlayerIds((previous) => {
      const next = new Set(previous);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  };

  useEffect(() => {
    const handleSelectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      setSelectedPlayerId(null);
      setMultiSelectedPlayerIds(new Set(visible.map((player) => player.id)));
    };
    window.addEventListener("keydown", handleSelectAll);
    return () => window.removeEventListener("keydown", handleSelectAll);
  }, [visible]);

  const runningTaskByAgent = useMemo(() => {
    const assignments = new Map<string, Task>();
    for (const task of tasks) {
      if (task.status !== "running") continue;
      for (const agentId of task.agentIds ?? []) assignments.set(agentId, task);
    }
    return assignments;
  }, [tasks]);

  const onRefresh = async () => {
    if (!snapshot.connected) {
      notify(snapshot.serverError ?? t("player.serverNotReady"));
      return;
    }

    try {
      await playerService.requestSnapshot();
      notify(t("player.refreshed"));
    } catch (error) {
      notify(t("agents.operationFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  };

  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(t("agents.copySuccess", { label }));
    } catch (error) {
      notify(t("agents.copyFailed", { label, detail: error instanceof Error ? error.message : String(error) }));
    }
    setContextMenu(null);
  };

  const changeStatus = async (player: PlayerInfo, status: "online" | "busy" | "idle") => {
    try {
      await playerService.setAgentStatus(player.id, status);
      notify(t("player.statusChanged", { name: player.name, status: statusLabel(status) }));
    } catch (error) {
      notify(t("agents.operationFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
    setContextMenu(null);
  };

  const deletePlayerAccounts = async (player: PlayerInfo) => {
    const targets = multiSelectedPlayerIds.has(player.id)
      ? [...multiSelectedPlayerIds]
      : [player.id];
    if (!window.confirm(t("agents.deleteConfirm", { count: targets.length }))) {
      setContextMenu(null);
      return;
    }

    const results = await Promise.all(targets.map(async (agentId) => {
      try {
        await playerService.deleteAgent(agentId);
        return { agentId, error: null };
      } catch (error) {
        return { agentId, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    const deletedIds = new Set(results.filter((result) => !result.error).map((result) => result.agentId));
    const failed = results.filter((result) => result.error);
    setMultiSelectedPlayerIds((previous) => new Set([...previous].filter((id) => !deletedIds.has(id))));
    if (deletedIds.has(profilePlayerId ?? "")) setProfilePlayerId(null);
    if (deletedIds.has(selectedPlayerId ?? "")) setSelectedPlayerId(null);
    setContextMenu(null);
    notify(failed.length === 0
      ? t("agents.accountsDeleted", { count: deletedIds.size })
      : t("agents.deleteResults", {
        success: deletedIds.size,
        total: targets.length,
        errors: failed.map(({ agentId, error }) => `${agentId}: ${error}`).join("; "),
      }));
  };

  const executeScript = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (executePlayers.length === 0) return;
    if (!scriptDraft.trim()) {
      notify(t("player.scriptRequired"));
      return;
    }
    if (executePlayers.some((player) => player.status === "offline")) {
      notify(t("player.offlineTargets"));
      return;
    }

    setIsExecuting(true);
    try {
      const sendResults = await playerService.executeScripts(
        executePlayers.map((player) => player.id),
        scriptDraft,
      );
      const sendResultByAgent = new Map(sendResults.map((result) => [result.agentId, result]));
      const results = executePlayers.map((player) => {
        const result = sendResultByAgent.get(player.id);
        return {
          player,
          error: result ? result.error : "No send confirmation was received",
        };
      });
      const sent = results.filter((result) => result.error === null);
      const failed = results.filter((result) => result.error !== null);
      if (failed.length === 0) {
        notify(executePlayers.length === 1
          ? t("player.scriptSentTo", { name: executePlayers[0].name })
          : t("agents.scriptSent", { count: sent.length }));
        setExecutePlayerIds([]);
        setScriptDraft("");
      } else {
        const details = failed.map(({ player, error }) => `${player.name}: ${error}`).join("; ");
        notify(t("agents.scriptResults", { success: sent.length, total: results.length, errors: details }));
        setExecutePlayerIds(failed.map(({ player }) => player.id));
      }
    } catch (error) {
      notify(t("agents.operationFailed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setIsExecuting(false);
    }
  };

  const openExecuteModal = (player: PlayerInfo) => {
    setScriptDraft(DEFAULT_EXECUTE_SCRIPT);
    setExecutePlayerIds([player.id]);
    setContextMenu(null);
  };

  const openExecuteSelectedModal = () => {
    const selected = multiSelectedPlayerIds.size > 0
      ? snapshot.players.filter((player) => multiSelectedPlayerIds.has(player.id))
      : snapshot.players.filter((player) => player.id === selectedPlayerId);
    const online = selected.filter((player) => player.status !== "offline");
    if (online.length === 0) {
      notify(t("player.noSelectedOnline"));
      return;
    }
    if (online.length < selected.length) {
      notify(t("player.skipOffline", { count: selected.length - online.length }));
    }
    setScriptDraft(DEFAULT_EXECUTE_SCRIPT);
    setExecutePlayerIds(online.map((player) => player.id));
    setContextMenu(null);
  };

  const closeExecuteModal = () => {
    if (isExecuting) return;
    setExecutePlayerIds([]);
    setScriptDraft("");
  };

  useEffect(() => {
    if (!selectedPlayer) {
      setRobloxProfile(null);
      return;
    }
    let active = true;
    setRobloxProfile(null);

    const getRobloxProfile = async () => {
      if (!/^\d+$/.test(selectedPlayer.id)) {
        return;
      }

      try {
        const profileResponse = await fetch(`https://users.roblox.com/v1/users/${selectedPlayer.id}`);
        if (!profileResponse.ok) throw new Error(`Roblox profile request failed: HTTP ${profileResponse.status}`);
        const profile = await profileResponse.json() as { displayName?: string; name?: string };
        if (!active) return;
        setRobloxProfile({
          displayName: profile.displayName ?? selectedPlayer.name,
          username: profile.name ?? selectedPlayer.name,
        });
      } catch {
        if (active) setRobloxProfile(null);
      }
    };

    void getRobloxProfile();
    return () => {
      active = false;
    };
  }, [selectedPlayer]);

  const handlePlayerRowClick = (event: MouseEvent<HTMLElement>, player: (typeof visible)[number]) => {
    if (event.ctrlKey || event.metaKey) {
      togglePlayerSelection(player.id);
      return;
    }

    setMultiSelectedPlayerIds(new Set());
    setSelectedPlayerId((current) => current === player.id ? null : player.id);
    setProfilePlayerId(null);
  };

  const openProfile = (player: PlayerInfo) => {
    setProfilePlayerId(player.id);
    setSelectedPlayerId(player.id);
    setContextMenu(null);
  };

  const formatTime = (timestamp?: number) =>
    timestamp ? new Date(timestamp).toLocaleString(language) : "—";
  const formatOnlineDuration = (player: PlayerInfo) => {
    if (player.status === "offline" || player.status === "error" || !player.connectedAt) return "—";
    return <LiveTime timestamp={player.connectedAt} mode="connected" />;
  };
  return (
    <div className="page page-players">
      <div className="players-stats">
        <StatCard
          icon={<Users size={18} />}
          label={t("common.all")}
          value={stats.total}
          tone="blue"
        />
        <StatCard
          icon={<Activity size={18} />}
          label={t("common.online")}
          value={stats.online}
          tone="green"
        />
        <StatCard
          icon={<Clock size={18} />}
          label={t("common.pending")}
          value={stats.idle}
          tone="amber"
        />
        <StatCard
          icon={<WifiOff size={18} />}
          label={t("player.offline")}
          value={stats.offline}
          tone="red"
        />
      </div>

      <div className="card task-controls players-controls">
        <div className="task-controls-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("player.search")}
            aria-label={t("player.search")}
          />
        </div>
        <div className="players-filters">
          {(["all", "online", "busy", "idle", "offline"] as Filter[]).map((f) => (
            <button
              key={f}
              className={`tab ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? t("common.all") : statusLabel(f)}
            </button>
          ))}
        </div>
        <button
          className="players-refresh"
          onClick={onRefresh}
        >
          <RefreshCw size={14} /> {t("player.refresh")}
        </button>
        <button
          className="players-refresh"
          onClick={openExecuteSelectedModal}
          disabled={multiSelectedPlayerIds.size === 0 && selectedPlayerId === null}
        >
          <Play size={14} /> {t("player.sendCode")}{multiSelectedPlayerIds.size > 0
            ? ` (${multiSelectedPlayerIds.size} ${t("agents.manyAccounts", { count: multiSelectedPlayerIds.size })})`
            : selectedPlayerId ? ` (${t("agents.oneAccount")})` : ""}
        </button>
        {multiSelectedPlayerIds.size > 0 && (
          <button className="players-refresh" onClick={() => setMultiSelectedPlayerIds(new Set())}>
            {t("player.clearSelected", { count: multiSelectedPlayerIds.size })}
          </button>
        )}
      </div>

      <div className="players-card-grid">
        {visible.map((player) => {
          const task = runningTaskByAgent.get(player.id);
          const isSelected = multiSelectedPlayerIds.has(player.id)
            || (multiSelectedPlayerIds.size === 0 && selectedPlayerId === player.id);
          const taskTitle = task?.title ?? (player.status === "busy" ? t("player.unspecifiedTask") : null);
          const description = task?.desc ?? null;

          return (
            <article
              key={player.id}
              className={`player-card status-${player.status} ${isSelected ? "is-selected" : ""}`}
              onClick={(event) => handlePlayerRowClick(event, player)}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedPlayerId(player.id);
                setContextMenu({
                  x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)),
                  y: Math.max(8, Math.min(event.clientY, window.innerHeight - 300)),
                  playerId: player.id,
                });
              }}
              tabIndex={0}
              aria-label={t("player.playerRowHint", { name: player.name })}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (event.ctrlKey || event.metaKey) togglePlayerSelection(player.id);
                  else {
                    setMultiSelectedPlayerIds(new Set());
                    setSelectedPlayerId(player.id);
                  }
                }
              }}
            >
              <header className="player-card-header">
                <div className="player-card-identity">
                  <div className={`player-avatar ${avatarUrls[player.id] ? "has-image" : ""}`}>
                    {avatarUrls[player.id] ? (
                      <img
                        src={avatarUrls[player.id]}
                        alt={t("player.robloxAvatar", { name: player.name })}
                        loading="lazy"
                        onError={() => {
                          invalidateRobloxAvatar(player.id);
                        }}
                      />
                    ) : player.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="player-card-name">
                    <strong>{player.name}</strong>
                    <code>{player.id}</code>
                  </div>
                </div>
                <span className={`player-card-status ${player.status}`}>
                  <i /> {statusLabel(player.status)}
                </span>
              </header>
              <div className="player-card-body">
                <div className="player-card-detail">
                  <span>{t("player.onlineFor")}</span>
                  <strong>{formatOnlineDuration(player)}</strong>
                </div>
                <div className="player-card-detail player-card-task-detail">
                  <span>{t("player.currentTask")}</span>
                  <strong title={taskTitle ?? undefined}>{taskTitle ?? "—"}</strong>
                  {task && <div className="player-card-progress"><i style={{ width: `${task.progress}%` }} /></div>}
                </div>
                <div className="player-card-description">
                  <span>{t("player.description")}</span>
                  <p title={description ?? undefined}>{description ?? "—"}</p>
                </div>
              </div>
              <footer className="player-card-actions">
                <button type="button" onClick={(event) => { event.stopPropagation(); openProfile(player); }}>
                  <UserRound size={14} /> {t("agents.viewProfile")}
                </button>
                <button
                  type="button"
                  disabled={player.status === "offline" || player.status === "error"}
                  onClick={(event) => { event.stopPropagation(); openExecuteModal(player); }}
                >
                  <Play size={14} /> {t("player.sendCode")}
                </button>
              </footer>
            </article>
          );
        })}
        {visible.length === 0 && (
          <div className="players-card-empty">
            {snapshot.players.length > 0 ? t("player.notFound") : t("player.empty")}
          </div>
        )}
      </div>
      {selectedPlayer && (
        <div className="player-profile-overlay" onClick={() => setProfilePlayerId(null)}>
          <section
            className="player-profile"
            role="dialog"
            aria-modal="true"
            aria-labelledby="player-profile-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="player-profile-header">
              <div className={`player-profile-avatar ${selectedAvatarUrl ? "has-image" : ""}`}>
                {selectedAvatarUrl ? (
                  <img
                    src={selectedAvatarUrl}
                    alt={t("player.robloxAvatar", { name: robloxProfile?.displayName ?? selectedPlayer.name })}
                    onError={() => {
                      invalidateRobloxAvatar(selectedPlayer.id);
                    }}
                  />
                ) : (
                  selectedPlayer.name.charAt(0).toUpperCase()
                )}
              </div>
              <div className="player-profile-heading">
                <span className={`player-table-status ${selectedPlayer.status}`}>
                  <i /> {statusLabel(selectedPlayer.status)}
                </span>
                <h2 id="player-profile-title">{selectedPlayer.name}</h2>
                <code>{selectedPlayer.id}</code>
              </div>
              <button className="player-profile-close" onClick={() => setProfilePlayerId(null)} aria-label={t("player.closeProfile")}>
                <X size={17} />
              </button>
            </header>
            <div className="player-profile-details">
              <ProfileField icon={<MapPin size={15} />} label={t("player.playerId")} value={selectedPlayer.id} />
              <ProfileField icon={<Server size={15} />} label={t("player.serverId")} value={selectedPlayer.server || selectedPlayer.job || t("player.profileNotReported")} />
              <ProfileField icon={<Clock size={15} />} label={t("player.connected")} value={formatTime(selectedPlayer.connectedAt)} />
              <ProfileField icon={<Activity size={15} />} label={t("player.lastSeen")} value={formatTime(profileLastSeenAt ?? selectedPlayer.lastSeenAt)} />
              <ProfileField icon={<UserRound size={15} />} label={t("player.currentTask")} value={runningTaskByAgent.get(selectedPlayer.id)?.title ?? t("player.noTaskAssigned")} />
              {robloxProfile && (
                <ProfileField icon={<UserRound size={15} />} label={t("player.robloxProfile")} value={`${robloxProfile.displayName} (@${robloxProfile.username})`} />
              )}
            </div>
            <footer className="player-profile-actions">
              <button onClick={() => void copyValue(selectedPlayer.id, t("player.playerId"))}>
                <Copy size={14} /> {t("player.copyPlayerId")}
              </button>
              <button
                disabled={!selectedPlayer.placeId}
                onClick={() => selectedPlayer.placeId && void copyValue(selectedPlayer.placeId, t("player.placeId"))}
              >
                <Copy size={14} /> {t("player.copyPlaceId")}
              </button>
              <button
                disabled={!(selectedPlayer.server || selectedPlayer.job)}
                onClick={() => {
                  const jobId = selectedPlayer.server || selectedPlayer.job;
                  if (jobId) void copyValue(jobId, t("player.jobId"));
                }}
              >
                <Copy size={14} /> {t("player.copyJobId")}
              </button>
            </footer>
          </section>
        </div>
      )}
      {contextMenu && contextPlayer && (
        createPortal(
          <div
            className="player-context-dismiss"
            onPointerDown={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          >
            <div
              className="player-context-menu"
              role="menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="player-context-title">{contextPlayer.name}</div>
              <button
                role="menuitem"
                onClick={() => {
                  openProfile(contextPlayer);
                  setContextMenu(null);
                }}
              >
                <UserRound size={14} /> {t("agents.viewProfile")}
              </button>
              <button
                role="menuitem"
                disabled={contextPlayer.status === "offline"}
                title={contextPlayer.status === "offline" ? t("player.playerOffline") : undefined}
                onClick={() => openExecuteModal(contextPlayer)}
              >
                <Play size={14} /> {t("agents.executeScript")}
              </button>
              <button role="menuitem" onClick={() => void copyValue(contextPlayer.id, t("player.playerId"))}>
                <Copy size={14} /> {t("agents.copyPlayerId")}
              </button>
              <button role="menuitem" className="player-context-danger" onClick={() => void deletePlayerAccounts(contextPlayer)}>
                <Trash2 size={14} /> {multiSelectedPlayerIds.has(contextPlayer.id) && multiSelectedPlayerIds.size > 1
                  ? t("agents.deleteSelectedAccounts", { count: multiSelectedPlayerIds.size })
                  : t("agents.deleteAccount")}
              </button>
              <button
                role="menuitem"
                disabled={!contextPlayer.placeId}
                onClick={() => contextPlayer.placeId && void copyValue(contextPlayer.placeId, t("player.placeId"))}
              >
                <MapPin size={14} /> {t("agents.copyPlaceId")}
              </button>
              <button
                role="menuitem"
                disabled={!(contextPlayer.server || contextPlayer.job)}
                onClick={() => {
                  const jobId = contextPlayer.server || contextPlayer.job;
                  if (jobId) void copyValue(jobId, t("player.jobId"));
                }}
              >
                <Copy size={14} /> {t("player.copyJobId")}
              </button>
              <div className="player-context-divider" />
              <span className="player-context-label">{t("agents.setStatus")}</span>
              {(["online", "busy", "idle"] as const).map((status) => (
                <button
                  key={status}
                  role="menuitemradio"
                  aria-checked={contextPlayer.status === status}
                  onClick={() => void changeStatus(contextPlayer, status)}
                >
                  <i className={`player-context-dot ${status}`} /> {statusLabel(status)}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )
      )}
      {executePlayer && (
        <div className="player-execute-overlay" onClick={closeExecuteModal}>
          <form
            className="modal player-execute-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="player-execute-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => void executeScript(event)}
          >
            <header>
              <div>
                <h3 id="player-execute-title">
                  {t("player.executeTitle")}
                </h3>
                <p className="player-execute-target">
                  {t("player.codeWillRunOn", {
                    targets: executePlayers.length === 1
                      ? executePlayer.name
                      : t("player.selectedAccounts", {
                        count: executePlayers.length,
                        names: executePlayers.map((player) => player.name).join(", "),
                      }),
                  })}
                </p>
              </div>
              <button type="button" className="icon-btn" onClick={closeExecuteModal} disabled={isExecuting} aria-label={t("common.close")}>
                <X size={16} />
              </button>
            </header>
            <label htmlFor="player-execute-script">
              {t("agents.clientCode")}
            </label>
            <SyntaxCodeEditor
              id="player-execute-script"
              value={scriptDraft}
              onChange={setScriptDraft}
              placeholder={t("player.executePlaceholder")}
              rows={14}
              autoFocus
              disabled={isExecuting}
              className="player-execute-code-editor"
            />
            <small className="player-execute-help">
              {t("player.executeHelp")}
            </small>
            <small className={`player-execute-size ${scriptTooLarge ? "exceeded" : ""}`}>
              {scriptBytes.toLocaleString()} / {MAX_SCRIPT_BYTES.toLocaleString()} bytes
            </small>
            <footer>
              <button type="button" className="btn-ghost" onClick={closeExecuteModal} disabled={isExecuting}>
                {t("agents.cancel")}
              </button>
              <button className="btn-primary" type="submit" disabled={isExecuting || scriptTooLarge || executePlayers.some((player) => player.status === "offline")}>
                <Play size={14} />
                {isExecuting
                  ? t("agents.sending")
                  : t("player.sendCode")}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "blue" | "green" | "violet" | "red" | "amber";
}) {
  return (
    <div className={`player-stat tone-${tone}`}>
      <div className="player-stat-ic">{icon}</div>
      <div className="player-stat-meta">
        <b>{value}</b>
        <span>{label}</span>
      </div>
    </div>
  );
}

function ProfileField({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="player-profile-field">
      <span>{icon}{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------