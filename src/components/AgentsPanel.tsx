import { useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, MapPin, Play, Terminal, Trash2, UserRound, Users, X } from "lucide-react";
import { playerService } from "../services/playerService";
import { useLanguage } from "../i18n/LanguageContext";
import type { PlayerInfo, PlayerStatus } from "../lua-api/types";
import {
  getRobloxAvatarSnapshot,
  invalidateRobloxAvatar,
  requestRobloxAvatars,
  subscribeRobloxAvatars,
} from "../services/robloxAvatarService";
import LiveLog from "./LiveLog";
import { SyntaxCodeEditor } from "./SyntaxCode";

type Tab = "players" | "logs";

export default function AgentsPanel({
  notify,
  onOpenPlayer,
}: {
  notify: (message: string) => void;
  onOpenPlayer: (playerId: string) => void;
}) {
  const { t } = useLanguage();
  const [players, setPlayers] = useState<PlayerInfo[]>(() => playerService.getPlayers());
  const avatarUrls = useSyncExternalStore(
    subscribeRobloxAvatars,
    getRobloxAvatarSnapshot,
    getRobloxAvatarSnapshot,
  );
  const [tab, setTab] = useState<Tab>("players");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; playerId: string } | null>(null);
  const [scriptTargetIds, setScriptTargetIds] = useState<string[]>([]);
  const [scriptDraft, setScriptDraft] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const sortedPlayers = useMemo(
    () => [...players].sort((left, right) =>
      Number(left.status === "offline") - Number(right.status === "offline"),
    ),
    [players],
  );
  const scriptTargets = scriptTargetIds
    .map((id) => players.find((player) => player.id === id))
    .filter((player): player is PlayerInfo => player !== undefined);
  const getStatusLabel = (status: PlayerStatus) => t(`agents.status.${status}`);

  useEffect(() => {
    return playerService.subscribe((snapshot) => setPlayers(snapshot.players));
  }, []);

  useEffect(() => {
    const playerIds = new Set(sortedPlayers.map((player) => player.id));
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => playerIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [sortedPlayers]);

  useEffect(() => {
    requestRobloxAvatars(sortedPlayers.map(({ id, name }) => ({ id, name })));
  }, [sortedPlayers]);

  useEffect(() => {
    const handleSelectAll = (event: KeyboardEvent) => {
      if (tab !== "players" || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      setSelectedIds(new Set(sortedPlayers.map((player) => player.id)));
    };
    window.addEventListener("keydown", handleSelectAll);
    return () => window.removeEventListener("keydown", handleSelectAll);
  }, [sortedPlayers, tab]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const toggleSelection = (playerId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  };

  const showContextMenu = (event: MouseEvent<HTMLDivElement>, player: PlayerInfo) => {
    event.preventDefault();
    if (!selectedIds.has(player.id)) setSelectedIds(new Set([player.id]));
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 350)),
      playerId: player.id,
    });
  };

  const openExecute = (agentIds: string[]) => {
    const onlineIds = agentIds.filter((id) => players.some((player) => player.id === id && player.status !== "offline"));
    if (onlineIds.length === 0) {
      notify(t("agents.noOnlineTargets"));
      setContextMenu(null);
      return;
    }
    setScriptTargetIds(onlineIds);
    setScriptDraft("");
    setContextMenu(null);
  };

  const executeSelected = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!scriptDraft.trim() || scriptTargets.length === 0) return;
    setIsExecuting(true);
    try {
      const results = await playerService.executeScripts(
        scriptTargets.map((player) => player.id),
        scriptDraft,
      );
      const failed = results.filter((result) => result.error);
      const sent = results.length - failed.length;
      if (failed.length === 0) {
        notify(t("agents.scriptSent", { count: sent }));
        setScriptTargetIds([]);
        setScriptDraft("");
      } else {
        notify(t("agents.scriptResults", {
          success: sent,
          total: results.length,
          errors: failed.map((result) => `${players.find((player) => player.id === result.agentId)?.name ?? result.agentId}: ${result.error}`).join("; "),
        }));
        setScriptTargetIds(failed.map((result) => result.agentId));
      }
    } catch (error) {
      notify(t("agents.operationFailed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setIsExecuting(false);
    }
  };

  const deleteSelected = async (agentIds: string[]) => {
    const targets = [...new Set(agentIds)];
    if (targets.length === 0) return;
    const confirmed = window.confirm(
      t("agents.deleteConfirm", { count: targets.length }),
    );
    setContextMenu(null);
    if (!confirmed) return;

    const results = await Promise.all(targets.map(async (agentId) => {
      try {
        await playerService.deleteAgent(agentId);
        return { agentId, error: null };
      } catch (error) {
        return { agentId, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    const failed = results.filter((result) => result.error);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const { agentId, error } of results) if (!error) next.delete(agentId);
      return next;
    });
    if (failed.length === 0) {
      notify(t("agents.accountsDeleted", { count: results.length }));
    } else {
      notify(t("agents.deleteResults", {
        success: results.length - failed.length,
        total: results.length,
        errors: failed.map(({ agentId, error }) => `${agentId}: ${error}`).join("; "),
      }));
    }
  };

  const copySelectedIds = async (agentIds: string[]) => {
    try {
      await navigator.clipboard.writeText(agentIds.join("\n"));
      notify(agentIds.length === 1
        ? t("agents.copyIdSuccess")
        : t("agents.copyIdsSuccess", { count: agentIds.length }));
    } catch (error) {
      notify(t("agents.copyFailed", {
        label: t("agents.copyPlayerId"),
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
    setContextMenu(null);
  };

  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(t("agents.copySuccess", { label }));
    } catch (error) {
      notify(t("agents.copyFailed", {
        label,
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
    setContextMenu(null);
  };

  const setSelectedStatus = async (agentIds: string[], status: Extract<PlayerStatus, "online" | "busy" | "idle">) => {
    const results = await Promise.all(agentIds.map(async (agentId) => {
      try {
        await playerService.setAgentStatus(agentId, status);
        return null;
      } catch (error) {
        return `${agentId}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }));
    const errors = results.filter((result): result is string => result !== null);
    notify(errors.length === 0
      ? t("agents.statusChanged", { count: agentIds.length, status: getStatusLabel(status) })
      : t("agents.statusResults", {
        success: agentIds.length - errors.length,
        total: agentIds.length,
        errors: errors.join("; "),
      }));
    setContextMenu(null);
  };

  const contextPlayer = contextMenu
    ? sortedPlayers.find((player) => player.id === contextMenu.playerId)
    : null;
  const contextTargetIds = contextPlayer && selectedIds.has(contextPlayer.id)
    ? [...selectedIds]
    : contextPlayer ? [contextPlayer.id] : [];

  return (
    <section
      className="card home-activity-panel"
      tabIndex={0}
      aria-label={t("agents.playerPanel")}
    >
      <header className="card-head">
        <div className="home-activity-tabs" role="tablist" aria-label={t("agents.statusInfo")}>
          <button
            className={`home-activity-tab ${tab === "players" ? "active" : ""}`}
            role="tab"
            aria-selected={tab === "players"}
            onClick={() => setTab("players")}
          >
            <Users size={15} /> {t("agents.players")}
          </button>
          <button
            className={`home-activity-tab ${tab === "logs" ? "active" : ""}`}
            role="tab"
            aria-selected={tab === "logs"}
            onClick={() => setTab("logs")}
          >
            <Terminal size={15} /> {t("agents.console")}
          </button>
        </div>
      </header>
      {tab === "players" ? (sortedPlayers.length > 0 ? (
        <>
          <div className="connected-player-list">
            {sortedPlayers.map((player) => (
              <div
                className={`connected-player-row ${selectedIds.has(player.id) ? "is-selected" : ""}`}
                key={player.id}
                tabIndex={0}
                onClick={() => toggleSelection(player.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleSelection(player.id);
                  }
                }}
                onContextMenu={(event) => showContextMenu(event, player)}
                aria-label={t("agents.rightClickHint", { name: player.name })}
                title={t("agents.selectHint")}
              >
                <div className={`connected-player-avatar ${avatarUrls[player.id] ? "has-image" : ""}`}>
                  {avatarUrls[player.id] ? (
                    <img
                      src={avatarUrls[player.id]}
                      alt=""
                      aria-hidden="true"
                      onError={() => invalidateRobloxAvatar(player.id)}
                    />
                  ) : player.name.charAt(0).toUpperCase()}
                </div>
                <div className="connected-player-meta">
                  <div className="connected-player-top">
                    <b>{player.name}</b>
                    <span className={`connected-player-status ${player.status}`}>
                      <i /> {getStatusLabel(player.status)}
                    </span>
                  </div>
                  <span className="connected-player-detail">
                    {[player.job, player.server, player.level != null ? t("agents.level", { level: player.level }) : null]
                      .filter(Boolean)
                      .join(" · ") || player.id}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="connected-player-empty">{t("agents.empty")}</p>
      )) : sortedPlayers.length > 0 ? (
        <LiveLog embedded />
      ) : (
        <p className="connected-player-empty">{t("agents.empty")}</p>
      )}

      {contextMenu && contextPlayer && (
        createPortal(
          <div
            className="home-player-context-dismiss"
            onPointerDown={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          >
            <div
              className="home-player-context-menu"
              role="menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <strong>{contextTargetIds.length > 1
                ? t("agents.selectedAccounts", { count: contextTargetIds.length })
                : contextPlayer.name}</strong>
              {contextTargetIds.length === 1 && (
                <button role="menuitem" onClick={() => {
                  onOpenPlayer(contextPlayer.id);
                  setContextMenu(null);
                }}>
                  <UserRound size={13} /> {t("agents.viewProfile")}
                </button>
              )}
              <button
                role="menuitem"
                disabled={contextTargetIds.every((id) => !players.some((player) => player.id === id && player.status !== "offline"))}
                onClick={() => openExecute(contextTargetIds)}
              >
                <Play size={13} /> {t("agents.executeScript")}
              </button>
              <button role="menuitem" onClick={() => void copySelectedIds(contextTargetIds)}>
                <Copy size={13} /> {t("agents.copyPlayerId")}
              </button>
              <button className="danger" role="menuitem" onClick={() => void deleteSelected(contextTargetIds)}>
                <Trash2 size={13} /> {contextTargetIds.length > 1
                  ? t("agents.deleteSelectedAccounts", { count: contextTargetIds.length })
                  : t("agents.deleteAccount")}
              </button>
              {contextTargetIds.length === 1 && (
                <button
                  role="menuitem"
                  disabled={!contextPlayer.placeId}
                  onClick={() => contextPlayer.placeId && void copyValue(contextPlayer.placeId, t("agents.copyPlaceId"))}
                >
                  <MapPin size={13} /> {t("agents.copyPlaceId")}
                </button>
              )}
              {contextTargetIds.length === 1 && (
                <button
                  role="menuitem"
                  disabled={!(contextPlayer.server || contextPlayer.job)}
                  onClick={() => {
                    const jobId = contextPlayer.server || contextPlayer.job;
                    if (jobId) void copyValue(jobId, t("agents.copyJobId"));
                  }}
                >
                  <Copy size={13} /> {t("agents.copyJobId")}
                </button>
              )}
              <div className="home-player-context-divider" />
              <strong className="home-player-context-section">{t("agents.setStatus")}</strong>
              {(["online", "busy", "idle"] as const).map((status) => (
                <button key={status} role="menuitemradio" aria-checked={contextPlayer.status === status} onClick={() => void setSelectedStatus(contextTargetIds, status)}>
                  <i className={`player-context-dot ${status}`} /> {getStatusLabel(status)}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )
      )}

      {scriptTargets.length > 0 && (
        <div className="player-execute-overlay" onClick={() => !isExecuting && setScriptTargetIds([])}>
          <form
            className="modal player-execute-modal"
            role="dialog"
            aria-modal="true"
            onSubmit={(event) => void executeSelected(event)}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h3>{t("agents.executeTitle")}</h3>
                <p className="player-execute-target">
                  {t("agents.runningOn", {
                    countLabel: scriptTargets.length === 1
                      ? t("agents.oneAccount")
                      : t("agents.manyAccounts", { count: scriptTargets.length }),
                  })}{" "}
                  <strong>{scriptTargets.map((player) => player.name).join(", ")}</strong>
                </p>
              </div>
              <button type="button" className="icon-btn" onClick={() => setScriptTargetIds([])} disabled={isExecuting} aria-label={t("common.close")}>
                <X size={16} />
              </button>
            </header>
            <label htmlFor="home-player-script">{t("agents.clientCode")}</label>
            <SyntaxCodeEditor
              id="home-player-script"
              value={scriptDraft}
              onChange={setScriptDraft}
              placeholder={t("agents.codePlaceholder")}
              rows={12}
              disabled={isExecuting}
              className="player-execute-code-editor home-player-code-editor"
            />
            <small className="player-execute-help">{t("agents.executeHelp")}</small>
            <footer>
              <button type="button" className="btn-ghost" onClick={() => setScriptTargetIds([])} disabled={isExecuting}>{t("agents.cancel")}</button>
              <button className="btn-primary" type="submit" disabled={isExecuting || !scriptDraft.trim()}>
                <Play size={14} /> {isExecuting ? t("agents.sending") : t("agents.sendCode")}
              </button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}
