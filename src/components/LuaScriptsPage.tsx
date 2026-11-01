import { useEffect, useMemo, useRef, useState } from "react";
import { FileCode2, Pause, Play, Plus, Save, Send, Trash2 } from "lucide-react";
import type { LuaApiModule } from "../lua-api";
import { useLanguage } from "../i18n/LanguageContext";
import type { LanguageMessageKey } from "../i18n/languages";
import { playerService, type PlayerRegistrySnapshot } from "../services/playerService";
import { SyntaxCodeEditor } from "./SyntaxCode";

const STORAGE_KEY = "axion.lua-scripts.v1";
const LEGACY_STORAGE_KEY = "autohub.lua-scripts.v1";

interface LuaScript {
  id: string;
  name: string;
  scriptId: string;
  source: string;
}

type Translate = ReturnType<typeof useLanguage>["t"];

interface Props {
  api: LuaApiModule;
  apiReady: boolean;
  apiError: string | null;
  notify: (message: string) => void;
  onCountChange: (count: number) => void;
}

function readScripts(t: Translate): LuaScript[] {
  const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return [];
  if (!localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(t("script.invalidSavedList", { detail: error instanceof Error ? error.message : String(error) }));
  }
  if (!Array.isArray(parsed)) throw new Error(t("script.invalidSavedList", { detail: t("script.invalidSavedListShape") }));
  return parsed.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.source !== "string"
    ) {
      throw new Error(t("script.invalidSavedItem", { index: index + 1 }));
    }
    return {
      id: item.id,
      name: item.name,
      scriptId: typeof item.scriptId === "string" ? item.scriptId : typeof item.seed === "string" ? item.seed : "",
      source: item.source,
    };
  });
}

function getStatusKey(status: string | undefined): LanguageMessageKey {
  if (status === "running") return "script.running";
  if (status === "stopped") return "script.stopped";
  if (status === "ready") return "script.ready";
  if (status === "error") return "script.error";
  return "script.saved";
}

function createEmptyScript(): LuaScript {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    scriptId: "",
    source: "",
  };
}

export default function LuaScriptsPage({ api, apiReady, apiError, notify, onCountChange }: Props) {
  const { t } = useLanguage();
  const translateRef = useRef(t);
  translateRef.current = t;
  const [playerSnapshot, setPlayerSnapshot] = useState<PlayerRegistrySnapshot>(() => ({
    players: playerService.getPlayers(),
    updatedAt: Date.now(),
    connected: playerService.isConnected(),
    serverError: null,
  }));
  const [scripts, setScripts] = useState<LuaScript[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetPlayerId, setTargetPlayerId] = useState("");
  const [draft, setDraft] = useState<LuaScript | null>(null);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string[]>([]);
  const [isSendingToPlayer, setIsSendingToPlayer] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    playerService.start();
    return playerService.subscribe(setPlayerSnapshot);
  }, []);

  useEffect(() => {
    const connectedPlayers = playerSnapshot.players.filter(
      player => player.status !== "offline" && player.status !== "error",
    );
    if (!connectedPlayers.some(player => player.id === targetPlayerId)) {
      setTargetPlayerId(connectedPlayers[0]?.id ?? "");
    }
  }, [playerSnapshot.players, targetPlayerId]);

  useEffect(() => {
    try {
      const saved = readScripts(translateRef.current);
      setScripts(saved);
      setSelectedId(saved[0]?.id ?? null);
      if (saved.length === 0) setDraft(createEmptyScript());
      setStatuses(Object.fromEntries(
        saved.map(script => [script.id, api.scripts.get(script.id)?.runtimeState ?? "saved"])
      ));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setInitialized(true);
    }
  }, [api, notify]);

  useEffect(() => {
    onCountChange(scripts.length);
  }, [onCountChange, scripts.length]);

  const selected = scripts.find(script => script.id === selectedId) ?? null;
  const editor = draft ?? selected;
  const isNewScript = Boolean(editor && !scripts.some(script => script.id === editor.id));
  const connectedPlayers = playerSnapshot.players.filter(
    player => player.status !== "offline" && player.status !== "error",
  );
  const hasUnsavedChanges = Boolean(
    draft &&
    scripts.some(script => script.id === draft.id) &&
    (() => {
      const saved = scripts.find(script => script.id === draft.id);
      return saved && (
        saved.name !== draft.name ||
        saved.scriptId !== draft.scriptId ||
        saved.source !== draft.source
      );
    })()
  );
  const runningCount = useMemo(
    () => Object.values(statuses).filter(status => status === "running").length,
    [statuses]
  );

  const persist = (next: LuaScript[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setScripts(next);
    onCountChange(next.length);
  };

  const createScript = () => {
    setSelectedId(null);
    setDraft(createEmptyScript());
  };

  const saveScript = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const scriptId = draft.scriptId.trim();
    if (!name || !draft.source.trim()) {
      notify(t("script.nameAndCodeRequired"));
      return;
    }

    const savedScript = { ...draft, name, scriptId };
    const existing = scripts.some(script => script.id === savedScript.id);
    const next = existing
      ? scripts.map(script => script.id === savedScript.id ? savedScript : script)
      : [...scripts, savedScript];

    try {
      persist(next);
    } catch (error) {
      notify(t("script.saveFailed", { detail: error instanceof Error ? error.message : String(error) }));
      return;
    }

    if (apiReady && api.scripts.get(savedScript.id)) {
      try {
        await api.scripts.reload(savedScript.id, savedScript.source);
        setStatuses(current => ({ ...current, [savedScript.id]: "ready" }));
      } catch (error) {
        notify(t("script.reloadAfterSaveFailed", { detail: error instanceof Error ? error.message : String(error) }));
      }
    } else {
      setStatuses(current => ({ ...current, [savedScript.id]: "saved" }));
    }

    setSelectedId(savedScript.id);
    setDraft(null);
    notify(t("script.savedNamed", { name: savedScript.name }));
  };

  const runAction = async (script: LuaScript, action: "start" | "stop") => {
    if (!apiReady) {
      notify(apiError ?? t("script.runtimePreparing"));
      return;
    }
    setBusy(current => [...current, script.id]);
    try {
      const record = api.scripts.get(script.id);
      if (action === "start") {
        if (record?.runtimeState === "running") {
          notify(t("script.alreadyRunning", { name: script.name }));
          return;
        }
        if (!record) {
          await api.scripts.load({
            id: script.id,
            name: script.name,
            source: script.source,
            metadata: { id: script.scriptId },
          });
        } else if (record.runtimeState === "stopped" || record.runtimeState === "error") {
          await api.scripts.reload(script.id, script.source);
        }
        await api.scripts.start(script.id);
        setStatuses(current => ({ ...current, [script.id]: "running" }));
        notify(t("script.startedNamed", { name: script.name, id: script.scriptId }));
      } else {
        if (!record || record.runtimeState !== "running") {
          notify(t("script.notRunning", { name: script.name }));
          return;
        }
        await api.scripts.stop(script.id);
        await api.scripts.reload(script.id, script.source);
        setStatuses(current => ({ ...current, [script.id]: "stopped" }));
        notify(t("script.stoppedNamed", { name: script.name }));
      }
    } catch (error) {
      setStatuses(current => ({ ...current, [script.id]: "error" }));
      notify(t("script.actionFailed", {
        action: t(action === "start" ? "script.start" : "script.stop"),
        detail: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setBusy(current => current.filter(id => id !== script.id));
    }
  };

  const sendToPlayer = async () => {
    if (!editor) return;
    if (!targetPlayerId) {
      notify(t("script.selectConnectedPlayer"));
      return;
    }
    if (!playerSnapshot.connected) {
      notify(playerSnapshot.serverError ?? t("script.serverNotReady"));
      return;
    }
    if (!editor.source.trim()) {
      notify(t("script.codeRequired"));
      return;
    }

    const target = connectedPlayers.find(player => player.id === targetPlayerId);
    if (!target) {
      notify(t("script.targetDisconnected"));
      return;
    }

    setIsSendingToPlayer(true);
    try {
      await playerService.executeScript(target.id, editor.source);
      notify(t("script.sentToPlayer", { script: editor.name || t("script.luaScript"), player: target.name }));
    } catch (error) {
      notify(t("script.sendFailed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setIsSendingToPlayer(false);
    }
  };

  const deleteScript = async (script: LuaScript) => {
    if (api.scripts.get(script.id)) {
      try {
        await api.scripts.unload(script.id);
      } catch (error) {
        notify(t("script.unloadFailed", { detail: error instanceof Error ? error.message : String(error) }));
        return;
      }
    }
    const next = scripts.filter(item => item.id !== script.id);
    try {
      persist(next);
    } catch (error) {
      notify(t("script.deleteFailed", { detail: error instanceof Error ? error.message : String(error) }));
      return;
    }
    setStatuses(current => {
      const updated = { ...current };
      delete updated[script.id];
      return updated;
    });
    setSelectedId(next[0]?.id ?? null);
    setDraft(null);
    notify(t("script.deletedNamed", { name: script.name }));
  };

  if (!initialized) return <div className="page lua-scripts-page" />;

  return (
    <div className="page lua-scripts-page">
      <div className="lua-scripts-summary">
        <div><b>{scripts.length}</b><span>{t("script.count")}</span></div>
        <div><b>{runningCount}</b><span>{t("script.runningCount")}</span></div>
        <button className="btn-primary" onClick={createScript}><Plus size={15} /> {t("script.add")}</button>
      </div>
      <div className="lua-script-help">
        <b>{t("script.helpTitle")}</b>
        <span>{t("script.helpDescription")}</span>
      </div>
      {apiError && <div className="lua-runtime-warning">{apiError}</div>}

      <div className="lua-scripts-layout">
        <section className="card lua-script-library">
          <header className="card-head">
            <div className="card-title"><FileCode2 size={16} /><h2>{t("script.library")}</h2></div>
          </header>
          {scripts.length === 0 ? (
            <div className="lua-script-empty">{t("script.empty")}</div>
          ) : scripts.map(script => (
            <button
              key={script.id}
              className={`lua-script-item ${selectedId === script.id && !draft ? "active" : ""}`}
              onClick={() => { setDraft(null); setSelectedId(script.id); }}
            >
              <span className="lua-script-item-icon"><FileCode2 size={16} /></span>
              <span className="lua-script-item-copy">
                <b>{script.name}</b>
                <small>ID: {script.scriptId}</small>
              </span>
              <i className={`lua-script-state ${statuses[script.id] === "running" ? "running" : statuses[script.id] === "error" ? "error" : ""}`} />
            </button>
          ))}
        </section>

        <section className="card lua-script-editor">
          {editor ? (
            <>
              <header className="lua-editor-heading">
                <div className="card-title"><FileCode2 size={16} /><h2>{t(isNewScript ? "script.new" : "script.edit")}</h2></div>
                {!isNewScript && <span className={`lua-editor-status ${statuses[editor.id] === "running" ? "running" : ""}`}>{hasUnsavedChanges ? t("script.unsaved") : t(getStatusKey(statuses[editor.id]))}</span>}
              </header>
              <div className="lua-script-fields">
                <label>{t("script.name")}<input value={editor.name} onChange={event => setDraft({ ...editor, name: event.target.value })} placeholder={t("script.namePlaceholder")} /></label>
                <label>{t("script.identifier")}<input value={editor.scriptId} onChange={event => setDraft({ ...editor, scriptId: event.target.value })} placeholder={t("script.identifierPlaceholder")} /></label>
              </div>
              <div className="lua-script-target">
                <label htmlFor="lua-script-player-target">{t("script.targetPlayer")}</label>
                <select
                  id="lua-script-player-target"
                  value={targetPlayerId}
                  onChange={event => setTargetPlayerId(event.target.value)}
                  disabled={connectedPlayers.length === 0}
                >
                  {connectedPlayers.length === 0 ? (
                    <option value="">{t("script.noPlayers")}</option>
                  ) : connectedPlayers.map(player => (
                    <option key={player.id} value={player.id}>{player.name} · {player.id}</option>
                  ))}
                </select>
                <small>{t("script.sendHint")}</small>
              </div>
              <label className="lua-source-label">{t("script.code")}</label>
              <SyntaxCodeEditor
                className="lua-source-editor"
                value={editor.source}
                onChange={source => setDraft({ ...editor, source })}
                placeholder={t("script.defaultCode")}
              />
              <div className="lua-editor-actions">
                {!isNewScript && selected && (
                  <>
                    <button className="btn-ghost lua-delete-button" onClick={() => void deleteScript(selected)}><Trash2 size={14} /> {t("script.delete")}</button>
                    {statuses[selected.id] === "running" ? (
                      <button className="btn-ghost" disabled={busy.includes(selected.id) || hasUnsavedChanges} onClick={() => void runAction(selected, "stop")}><Pause size={14} /> {t("script.stop")}</button>
                    ) : (
                      <button className="btn-ghost" disabled={!apiReady || busy.includes(selected.id) || hasUnsavedChanges} onClick={() => void runAction(selected, "start")}><Play size={14} /> {t("script.start")}</button>
                    )}
                  </>
                )}
                <button
                  className="btn-ghost lua-send-button"
                  disabled={isSendingToPlayer || !editor.source.trim() || !targetPlayerId || !playerSnapshot.connected}
                  onClick={() => void sendToPlayer()}
                  title={t("script.sendHint")}
                >
                  <Send size={14} /> {isSendingToPlayer ? t("script.sending") : t("script.send")}
                </button>
                <button className="btn-primary" disabled={!draft} onClick={() => void saveScript()}><Save size={14} /> {t("script.save")}</button>
              </div>
            </>
          ) : (
            <div className="lua-script-empty lua-editor-placeholder">
              {t("script.choose")}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
