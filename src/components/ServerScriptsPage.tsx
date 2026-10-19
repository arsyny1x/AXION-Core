import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Copy, Database, Download, Eye, EyeOff, FileCode2, Pencil, Plus, RefreshCw, Save, Search, Trash2, Upload, X } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useLanguage } from "../i18n/LanguageContext";
import axionApiSource from "../../lua/AXION api.lua?raw";
import { SyntaxCodeBlock, SyntaxCodeEditor } from "./SyntaxCode";
import {
  getServerScriptApiToken,
  getInventorySnapshot,
  invalidateSavedServerScripts,
  loadSavedServerScripts,
  loadServerScript,
  removeInventorySnapshot,
  replaceInventorySnapshot,
  refreshInventoryCache,
  subscribeInventory,
  unloadServerScript,
  type InventoryItem,
  type InventorySnapshot,
  type ServerScript,
} from "../services/serverScriptsService";

const STORAGE_KEY = "axion.server-scripts.v1";
const LEGACY_STORAGE_KEY = "autohub.server-scripts.v1";
const SELECTED_SCOPE_STORAGE_KEY = "axion.server-scripts.selected-scope.v1";
const PROFILE_STORAGE_KEYS = ["axion.server-script-profiles.v1", "autohub.server-script-profiles.v1"];
const PROFILE_FORMAT = "axion.server-script-profile";
const LEGACY_PROFILE_FORMAT = "autohub.server-script-profile";
const DEFAULT_API_PORT = 5243;
const DEFAULT_INVENTORY_CATEGORIES = ["fruits", "swords", "guns", "accessories", "materials"];
const INVENTORY_CATEGORY_EMOJI: Record<string, string> = {
  currency: "💰",
  stats: "📊",
  info: "ℹ️",
  stars: "⭐",
  fishing: "🎣",
};
const SAMPLE_SOURCE = `return {
  find_item = function(args)
    local matches = Server.Items.search(args.query or "", args.includeOffline == true)
    return {
      customGameId = Server.Game.customGameId,
      count = #matches,
      items = matches
    }
  end,
  get_online_inventory = function(args)
    args = args or {}
    local items = Server.Items.getOnline(args.agentId)
    return {
      customGameId = Server.Game.customGameId,
      count = #items,
      items = items
    }
  end
}`;

function getStoredGameScope(): string {
  try {
    const stored = localStorage.getItem(SELECTED_SCOPE_STORAGE_KEY);
    return stored && /^[A-Za-z0-9_-]{1,64}$/.test(stored) ? stored : "BLOX_FRUITS";
  } catch {
    return "BLOX_FRUITS";
  }
}

function isValidInventoryCategory(category: string): boolean {
  const characters = Array.from(category);
  if (characters.length < 1 || characters.length > 64) return false;

  return characters.every(character => {
    const codepoint = character.codePointAt(0);
    if (codepoint === undefined) return false;
    if (codepoint < 0x80) return /^[A-Za-z0-9_-]$/.test(character);
    return !(
      (codepoint >= 0x0000 && codepoint <= 0x001f)
      || (codepoint >= 0x007f && codepoint <= 0x009f)
      || codepoint === 0x0085
      || codepoint === 0x00a0
      || codepoint === 0x1680
      || (codepoint >= 0x2000 && codepoint <= 0x200a)
      || codepoint === 0x2028
      || codepoint === 0x2029
      || codepoint === 0x202f
      || codepoint === 0x205f
      || codepoint === 0x3000
    );
  });
}

function getInventoryCategoryLabel(category: string): string {
  const emoji = INVENTORY_CATEGORY_EMOJI[category.toLocaleLowerCase()];
  return emoji ? `${emoji} ${category}` : category;
}

function persistGameScope(customGameId: string): string | null {
  try {
    localStorage.setItem(SELECTED_SCOPE_STORAGE_KEY, customGameId);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function createScript(customGameId: string): ServerScript {
  return {
    id: crypto.randomUUID(),
    name: "Server Script Demo",
    source: SAMPLE_SOURCE,
    customGameId,
  };
}

export default function ServerScriptsPage({
  notify,
  onCountChange,
  view = "scripts",
}: {
  notify: (message: string) => void;
  onCountChange: (count: number) => void;
  view?: "scripts" | "database";
}) {
  const { language, t } = useLanguage();
  const translateRef = useRef(t);
  translateRef.current = t;
  const [scripts, setScripts] = useState<ServerScript[]>([]);
  const [selectedGameId, setSelectedGameId] = useState(getStoredGameScope);
  const [gameIdInput, setGameIdInput] = useState("");
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const scopeDropdownRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerScript | null>(null);
  const [inventories, setInventories] = useState<InventorySnapshot[]>([]);
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [apiPort, setApiPort] = useState(DEFAULT_API_PORT);
  const [apiPortInput, setApiPortInput] = useState(String(DEFAULT_API_PORT));
  const [apiPortBusy, setApiPortBusy] = useState(false);
  const [apiRunning, setApiRunning] = useState(false);
  const [websocketPort, setWebsocketPort] = useState("5242");
  const [websocketRunning, setWebsocketRunning] = useState(false);
  const [websocketPortBusy, setWebsocketPortBusy] = useState(false);
  const [showApiToken, setShowApiToken] = useState(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshingInventory, setRefreshingInventory] = useState(false);
  const [workspaceReportNotice, setWorkspaceReportNotice] = useState<
    | { type: "received"; scope: string; account: string; count: number }
    | { type: "error"; agent: string; message: string }
    | null
  >(null);
  const [itemContextMenu, setItemContextMenu] = useState<{
    x: number;
    y: number;
    inventory: InventorySnapshot;
    item: InventoryItem | null;
    mode: "menu" | "add" | "edit";
  } | null>(null);
  const itemContextMenuRef = useRef<HTMLDivElement>(null);
  const [inventoryItemDraft, setInventoryItemDraft] = useState<InventoryItem | null>(null);
  const [savingInventoryItem, setSavingInventoryItem] = useState(false);
  const [itemCategoryMenuOpen, setItemCategoryMenuOpen] = useState(false);
  const [newInventoryCategory, setNewInventoryCategory] = useState("");
  const profileFileInput = useRef<HTMLInputElement>(null);
  const [confirmation, setConfirmation] = useState<{
    message: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  useLayoutEffect(() => {
    if (!itemContextMenu || !itemContextMenuRef.current) return;
    const menu = itemContextMenuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(itemContextMenu.x, window.innerWidth - menu.width - 8));
    const y = Math.max(8, Math.min(itemContextMenu.y, window.innerHeight - menu.height - 8));
    if (x !== itemContextMenu.x || y !== itemContextMenu.y) {
      setItemContextMenu(current => current ? { ...current, x, y } : current);
    }
  }, [itemContextMenu]);

  useEffect(() => {
    if (!scopeMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !scopeDropdownRef.current?.contains(event.target)) {
        setScopeMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setScopeMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [scopeMenuOpen]);

  const requestConfirmation = (message: string): Promise<boolean> =>
    new Promise(resolve => setConfirmation({ message, resolve }));

  const closeConfirmation = (confirmed: boolean) => {
    confirmation?.resolve(confirmed);
    setConfirmation(null);
  };

  useEffect(() => subscribeInventory(setInventories), []);

  useEffect(() => {
    if (!isTauri()) {
      setInitializationError(t("serverScript.desktopRequired"));
      setInitializing(false);
      return;
    }
    let active = true;
    let unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<InventorySnapshot>("axion-item-cache-updated", ({ payload }) => {
        if (payload.customGameId !== selectedGameId) return;
        setWorkspaceReportNotice({
          type: "received",
          scope: payload.customGameId,
          account: payload.accountId,
          count: payload.items.length,
        });
      }),
      listen<{ agentId: string; message: string }>("axion-agent-protocol-error", ({ payload }) => {
        setWorkspaceReportNotice({
          type: "error",
          agent: payload.agentId,
          message: payload.message,
        });
      }),
    ]).then(listeners => {
      if (active) unlisteners = listeners;
      else listeners.forEach(unlisten => unlisten());
    }).catch(error => {
      notify(t("serverScript.listenFailed", { detail: error instanceof Error ? error.message : String(error) }));
    });

    return () => {
      active = false;
      unlisteners.forEach(unlisten => unlisten());
    };
  }, [notify, selectedGameId, t]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void invoke<{ running: boolean; port: number }>("axion_server_status")
      .then(status => {
        if (!active) return;
        setWebsocketPort(String(status.port));
        setWebsocketRunning(status.running);
      })
      .catch(error => {
        notify(t("serverScript.websocketPortLoadFailed", {
          detail: error instanceof Error ? error.message : String(error),
        }));
      });
    return () => {
      active = false;
    };
  }, [notify, t]);

  useEffect(() => {
    if (!isTauri()) {
      setInitializationError(t("serverScript.desktopRequired"));
      setInitializing(false);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const apiStatus = await invoke<{ running: boolean; port: number }>("axion_server_script_api_status");
        if (!active) return;
        setApiPort(apiStatus.port);
        setApiPortInput(String(apiStatus.port));
        setApiRunning(apiStatus.running);
        const { scripts: savedScripts, errors } = await loadSavedServerScripts();
        if (!active) return;
        errors.forEach(notify);
        setScripts(savedScripts);
        const storedScriptData = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
        if (storedScriptData && !localStorage.getItem(STORAGE_KEY)) {
          localStorage.setItem(STORAGE_KEY, storedScriptData);
        }
        const cachedInventories = getInventorySnapshot();
        const storedGame = (() => {
          try {
            const stored = localStorage.getItem(SELECTED_SCOPE_STORAGE_KEY);
            return stored && /^[A-Za-z0-9_-]{1,64}$/.test(stored) ? stored : null;
          } catch {
            return null;
          }
        })();
        const initialGame = storedGame
          ?? (savedScripts.some(script => script.customGameId === "BLOX_FRUITS")
            ? "BLOX_FRUITS"
            : savedScripts[0]?.customGameId
              ?? cachedInventories[0]?.customGameId
              ?? "BLOX_FRUITS");
        setSelectedGameId(initialGame);
        const initialGameScripts = savedScripts.filter(script => script.customGameId === initialGame);
        setSelectedId(initialGameScripts[0]?.id ?? null);
        if (initialGameScripts.length === 0) setDraft(createScript(initialGame));
        setApiToken(getServerScriptApiToken());
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setInitializationError(detail);
        notify(translateRef.current("serverScript.initializationFailed", { detail }));
      } finally {
        if (active) setInitializing(false);
      }
    })();
    return () => { active = false; };
  }, [notify, t]);

  useEffect(() => {
    if (view === "scripts") onCountChange(scripts.length);
  }, [onCountChange, scripts.length, view]);

  const scopedScripts = scripts.filter(script => script.customGameId === selectedGameId);
  const selected = scopedScripts.find(script => script.id === selectedId) ?? null;
  const editor = draft ?? selected;
  const isNewScript = Boolean(editor && !scopedScripts.some(script => script.id === editor.id));
  const hasUnsavedChanges = Boolean(
    draft && scopedScripts.some(script => script.id === draft.id) &&
      (() => {
        const saved = scopedScripts.find(script => script.id === draft.id);
        return saved && (saved.name !== draft.name || saved.source !== draft.source);
      })(),
  );
  const gameInventories = inventories.filter(inventory => inventory.customGameId === selectedGameId);
  const inventoryCategories = useMemo(() => [...new Set([
    ...DEFAULT_INVENTORY_CATEGORIES,
    ...gameInventories.flatMap(inventory => inventory.categories ?? []),
    ...gameInventories.flatMap(inventory => inventory.items.map(item => item.category)),
  ])].sort((left, right) => left.localeCompare(right)), [gameInventories]);
  const knownGameIds = [...new Set([
    ...scripts.map(script => script.customGameId),
    ...inventories.map(inventory => inventory.customGameId),
    selectedGameId,
  ])].sort((left, right) => left.localeCompare(right));
  const filteredInventories = useMemo(() => {
    const query = inventoryQuery.trim().toLocaleLowerCase();
    return gameInventories
      .map(inventory => ({
        ...inventory,
        items: inventory.items.filter(item => !query || item.name.toLocaleLowerCase().includes(query)),
      }))
      .filter(inventory => !query || inventory.items.length > 0);
  }, [gameInventories, inventoryQuery]);

  const changeGameScope = async (customGameId: string) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(customGameId)) {
      notify(t("serverScript.invalidScope"));
      return;
    }
    if (
      view === "scripts" &&
      draft &&
      (isNewScript || hasUnsavedChanges) &&
      !(await requestConfirmation(t("serverScript.profileDiscardDraft")))
    ) {
      return;
    }
    const scopeSaveError = persistGameScope(customGameId);
    if (scopeSaveError) {
      notify(t("serverScript.scopeSaveFailed", { detail: scopeSaveError }));
    }
    setSelectedGameId(customGameId);
    setGameIdInput("");
    const nextScripts = scripts.filter(script => script.customGameId === customGameId);
    setSelectedId(nextScripts[0]?.id ?? null);
    setDraft(nextScripts.length === 0 ? createScript(customGameId) : null);
  };

  const saveScript = async () => {
    if (!draft || !draft.name.trim()) {
      notify(t("serverScript.nameRequired"));
      return;
    }
    const updated = { ...draft, name: draft.name.trim(), customGameId: selectedGameId };
    const previous = scopedScripts.find(script => script.id === updated.id);
    setBusy(true);
    try {
      const exports = await loadServerScript(updated);
      const next = previous
        ? scripts.map(script => script.id === updated.id && script.customGameId === selectedGameId ? updated : script)
        : [...scripts, updated];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      invalidateSavedServerScripts();
      setScripts(next);
      setSelectedId(updated.id);
      setDraft(null);
      notify(t("serverScript.savedLoadedExports", {
        count: exports.length,
        scope: selectedGameId,
        exports: exports.join(", "),
      }));
    } catch (error) {
      if (previous) {
        try {
          await loadServerScript(previous);
        } catch (restoreError) {
          notify(t("serverScript.restoreFailed", { detail: restoreError instanceof Error ? restoreError.message : String(restoreError) }));
        }
      } else {
        unloadServerScript(updated.id, updated.customGameId);
      }
      notify(t("serverScript.saveFailed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };

  const removeScript = (script: ServerScript) => {
    try {
      const next = scripts.filter(entry => !(entry.id === script.id && entry.customGameId === script.customGameId));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      invalidateSavedServerScripts();
      unloadServerScript(script.id, script.customGameId);
      setScripts(next);
      const nextScopedScripts = next.filter(entry => entry.customGameId === selectedGameId);
      setSelectedId(nextScopedScripts[0]?.id ?? null);
      setDraft(nextScopedScripts.length === 0 ? createScript(selectedGameId) : null);
    } catch (error) {
      notify(t("serverScript.deleteFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  };

  const validateProfile = (value: unknown): { customGameId: string; scripts: ServerScript[] } => {
    if (!value || typeof value !== "object") throw new Error("Profile must be a JSON object");
    const profile = value as Record<string, unknown>;
    if (
      (profile.format !== PROFILE_FORMAT && profile.format !== LEGACY_PROFILE_FORMAT) ||
      profile.version !== 1
    ) {
      throw new Error("Unsupported Server Script profile format or version");
    }
    if (typeof profile.customGameId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(profile.customGameId)) {
      throw new Error("Profile Game Scope must contain 1-64 letters, numbers, _ or -");
    }
    if (!Array.isArray(profile.scripts) || profile.scripts.length === 0) {
      throw new Error("Profile must contain at least one Server Script");
    }
    const scripts = profile.scripts.map((entry, index) => {
      if (
        !entry || typeof entry !== "object" ||
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" || !entry.name.trim() ||
        typeof entry.source !== "string"
      ) {
        throw new Error(`Profile Server Script ${index + 1} is invalid`);
      }
      if (entry.customGameId !== undefined && entry.customGameId !== profile.customGameId) {
        throw new Error(`Profile Server Script ${index + 1} belongs to a different Game Scope`);
      }
      return {
        id: entry.id || crypto.randomUUID(),
        name: entry.name.trim(),
        source: entry.source,
        customGameId: profile.customGameId as string,
      };
    });
    if (new Set(scripts.map(script => script.id)).size !== scripts.length) {
      throw new Error("Profile contains duplicate Server Script IDs");
    }
    return { customGameId: profile.customGameId, scripts };
  };

  const buildProfile = (customGameId: string, profileScripts: ServerScript[]) => ({
    format: PROFILE_FORMAT,
    version: 1,
    customGameId,
    savedAt: new Date().toISOString(),
    scripts: profileScripts,
  });

  const deleteProfile = async () => {
    const scopeScripts = scripts.filter(script => script.customGameId === selectedGameId);
    if (scopeScripts.length === 0) return;
    if (!(await requestConfirmation(t("serverScript.confirmDeleteProfile").replace("{scope}", selectedGameId)))) return;
    try {
      const nextScripts = scripts.filter(script => script.customGameId !== selectedGameId);
      for (const storageKey of PROFILE_STORAGE_KEYS) {
        const rawProfiles = localStorage.getItem(storageKey);
        if (!rawProfiles) continue;
        const profiles: unknown = JSON.parse(rawProfiles);
        if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
          throw new Error("Saved Server Script profiles must be an object");
        }
        delete (profiles as Record<string, unknown>)[selectedGameId];
        localStorage.setItem(storageKey, JSON.stringify(profiles));
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextScripts));
      scopeScripts.forEach(script => unloadServerScript(script.id, script.customGameId));
      invalidateSavedServerScripts();
      setScripts(nextScripts);
      setSelectedId(null);
      setDraft(null);
      notify(t("serverScript.profileDeleted"));
    } catch (error) {
      notify(t("serverScript.profileDeleteError", { detail: error instanceof Error ? error.message : String(error) }));
    }
  };

  const replaceScopeProfile = async (customGameId: string, profileScripts: ServerScript[]) => {
    const currentScopeScripts = scripts.filter(script => script.customGameId === customGameId);
    const stagedScripts = profileScripts.map(script => ({ ...script, id: crypto.randomUUID() }));
    const loadedIds: string[] = [];
    currentScopeScripts.forEach(script => unloadServerScript(script.id, customGameId));
    try {
      for (const script of stagedScripts) {
        await loadServerScript(script);
        loadedIds.push(script.id);
      }
      const next = [
        ...scripts.filter(script => script.customGameId !== customGameId),
        ...stagedScripts,
      ];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      invalidateSavedServerScripts();
      currentScopeScripts.forEach(script => unloadServerScript(script.id, customGameId));
      setScripts(next);
      const scopeSaveError = persistGameScope(customGameId);
      if (scopeSaveError) {
        notify(t("serverScript.scopeSaveFailed", { detail: scopeSaveError }));
      }
      setSelectedGameId(customGameId);
      setGameIdInput("");
      setSelectedId(stagedScripts[0]?.id ?? null);
      setDraft(null);
    } catch (error) {
      loadedIds.forEach(id => unloadServerScript(id, customGameId));
      const restoreErrors: string[] = [];
      for (const script of currentScopeScripts) {
        try {
          await loadServerScript(script);
        } catch (restoreError) {
          restoreErrors.push(restoreError instanceof Error ? restoreError.message : String(restoreError));
        }
      }
      if (restoreErrors.length > 0) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}. Previous profile restore failed: ${restoreErrors.join("; ")}`,
        );
      }
      throw error;
    }
  };

  const exportProfile = () => {
    void (async () => {
      try {
      const profileScripts = scripts.filter(script => script.customGameId === selectedGameId);
      if (draft && (isNewScript || hasUnsavedChanges)) {
        const exportedDraft = { ...draft, name: draft.name.trim(), customGameId: selectedGameId };
        const existingIndex = profileScripts.findIndex(script => script.id === exportedDraft.id);
        if (existingIndex >= 0) profileScripts[existingIndex] = exportedDraft;
        else profileScripts.push(exportedDraft);
      }
      if (profileScripts.length === 0) {
        notify(t("serverScript.profileEmpty"));
        return;
      }
      const path = await saveFileDialog({
        defaultPath: `AXION-${selectedGameId}-profile.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const serialized = JSON.stringify(buildProfile(selectedGameId, profileScripts), null, 2);
      await invoke("save_server_script_profile", { path, contents: serialized });
      notify(t("serverScript.profileExported"));
      } catch (error) {
        notify(t("serverScript.profileExportError", { detail: error instanceof Error ? error.message : String(error) }));
      }
    })();
  };

  const importProfile = async (event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const profile = validateProfile(JSON.parse(await file.text()) as unknown);
      if (
        draft &&
        (isNewScript || hasUnsavedChanges) &&
        !(await requestConfirmation(t("serverScript.profileDiscardDraft")))
      ) return;
      if (
        (profile.customGameId !== selectedGameId ||
          scripts.some(script => script.customGameId === profile.customGameId)) &&
        !(await requestConfirmation(t("serverScript.profileImportReplace")
          .replace("{scope}", profile.customGameId))
        )
      ) return;
      await replaceScopeProfile(profile.customGameId, profile.scripts);
      notify(t("serverScript.profileImported"));
    } catch (error) {
      notify(t("serverScript.profileImportError", { detail: error instanceof Error ? error.message : String(error) }));
    }
  };

  const copyText = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(successMessage);
    } catch (error) {
      notify(t("serverScript.clipboardFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  };

  const applyApiPort = async () => {
    const port = Number(apiPortInput);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      notify(t("serverScript.invalidPort"));
      return;
    }
    setApiPortBusy(true);
    try {
      await invoke("axion_server_script_set_port", { port });
      setApiPort(port);
      setApiRunning(true);
      notify(t("serverScript.apiListening", { port }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const status = await invoke<{ running: boolean; port: number }>("axion_server_script_api_status");
        setApiPort(status.port);
        setApiPortInput(String(status.port));
        setApiRunning(status.running);
      } catch (statusError) {
        notify(t("serverScript.portChangeAndVerifyFailed", {
          detail: message,
          statusDetail: statusError instanceof Error ? statusError.message : String(statusError),
        }));
        return;
      }
      notify(t("serverScript.portChangeFailed", { detail: message }));
    } finally {
      setApiPortBusy(false);
    }
  };

  const applyWebsocketPort = async () => {
    const port = Number(websocketPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      notify(t("serverScript.websocketPortInvalid"));
      return;
    }
    if (!isTauri()) {
      notify(t("serverScript.desktopRequired"));
      return;
    }

    setWebsocketPortBusy(true);
    try {
      await invoke("axion_server_set_port", { port });
      setWebsocketRunning(true);
      notify(t("serverScript.websocketPortSaved", { host: "localhost", port }));
    } catch (error) {
      notify(t("serverScript.websocketPortFailed", {
        detail: error instanceof Error ? error.message : String(error),
      }));
      try {
        const status = await invoke<{ running: boolean; port: number }>("axion_server_status");
        setWebsocketPort(String(status.port));
        setWebsocketRunning(status.running);
      } catch (statusError) {
        notify(t("serverScript.websocketPortLoadFailed", {
          detail: statusError instanceof Error ? statusError.message : String(statusError),
        }));
      }
    } finally {
      setWebsocketPortBusy(false);
    }
  };

  const copyApiScript = async () => {
    const websocketPortSetting = /^([ \t]*WebSocketHost[ \t]*=[ \t]*)\d+/gm;
    const scriptApiPortSetting = /^([ \t]*ScriptApiPort[ \t]*=[ \t]*)\d+/gm;
    const gameScopeSetting = /^([ \t]*gamescope[ \t]*=[ \t]*)"[^"]*"/gm;
    if (
      axionApiSource.match(websocketPortSetting)?.length !== 1
      || axionApiSource.match(scriptApiPortSetting)?.length !== 1
      || axionApiSource.match(gameScopeSetting)?.length !== 1
    ) {
      notify(t("serverScript.sourceSettingsMissing"));
      return;
    }
    try {
      const serverStatus = await invoke<{ port: number }>("axion_server_status");
      const sourceWithWebsocketPort = axionApiSource.replace(
        websocketPortSetting,
        (_match, prefix: string) => `${prefix}${serverStatus.port}`,
      );
      const sourceWithApiPort = sourceWithWebsocketPort.replace(
        scriptApiPortSetting,
        (_match, prefix: string) => `${prefix}${apiPort}`,
      );
      const source = sourceWithApiPort.replace(
        gameScopeSetting,
        (_match, prefix: string) => `${prefix}${JSON.stringify(selectedGameId)}`,
      );
      await copyText(source, t("serverScript.copyApiSuccess", { scope: selectedGameId, port: apiPort }));
    } catch (error) {
      notify(t("serverScript.copyApiFailed", {
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const refreshCache = async () => {
    setRefreshingInventory(true);
    try {
      await refreshInventoryCache();
    } catch (error) {
      notify(t("serverScript.cacheRefreshFailed", {
        message: t("serverScript.refreshFailed"),
        detail: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setRefreshingInventory(false);
    }
  };

  const openInventoryItemEditor = (inventory: InventorySnapshot, item: InventoryItem | null = null) => {
    setItemContextMenu(current => current
      ? { ...current, inventory, item, mode: item ? "edit" : "add" }
      : current);
    setInventoryItemDraft(item
      ? { ...item }
      : { name: "", quantity: 1, itemId: null, category: DEFAULT_INVENTORY_CATEGORIES[0] });
    setItemCategoryMenuOpen(false);
    setNewInventoryCategory("");
  };

  const beginInventoryItemEdit = () => {
    setItemContextMenu(current => current ? { ...current, mode: "edit" } : current);
    setInventoryItemDraft(itemContextMenu?.item ? { ...itemContextMenu.item } : null);
  };

  const addInventoryCategory = () => {
    const category = newInventoryCategory.trim();
    if (!isValidInventoryCategory(category)) {
      notify(t("serverScript.categoryNameInvalid"));
      return;
    }
    setInventoryItemDraft(current => current ? { ...current, category } : current);
    setNewInventoryCategory("");
    setItemCategoryMenuOpen(false);
  };

  const closeInventoryItemEditor = () => {
    if (savingInventoryItem) return;
    setItemContextMenu(current => current ? { ...current, mode: "menu" } : current);
    setInventoryItemDraft(null);
    setItemCategoryMenuOpen(false);
  };

  const saveInventoryItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!itemContextMenu || itemContextMenu.mode === "menu" || !inventoryItemDraft) return;
    const newName = inventoryItemDraft.name.trim();
    if (!newName || new TextEncoder().encode(newName).length > 80) {
      notify(t("serverScript.itemUpdateError", {
        message: t("serverScript.itemUpdateFailed"),
        detail: t("serverScript.itemNameInvalid"),
      }));
      return;
    }
    if (!Number.isSafeInteger(inventoryItemDraft.quantity) || inventoryItemDraft.quantity < 0 || inventoryItemDraft.quantity > 1_000_000_000) {
      notify(t("serverScript.itemUpdateError", {
        message: t("serverScript.itemUpdateFailed"),
        detail: t("serverScript.itemQuantityInvalid"),
      }));
      return;
    }
    const itemId = inventoryItemDraft.itemId?.trim() || null;
    if (itemId && new TextEncoder().encode(itemId).length > 128) {
      notify(t("serverScript.itemUpdateError", {
        message: t("serverScript.itemUpdateFailed"),
        detail: t("serverScript.itemIdInvalid"),
      }));
      return;
    }

    setSavingInventoryItem(true);
    try {
      const { inventory, item: originalItem } = itemContextMenu;
      const updated = originalItem
        ? await invoke<InventorySnapshot>("axion_item_cache_update", {
          customGameId: inventory.customGameId,
          accountId: inventory.accountId,
          oldCategory: originalItem.category,
          oldName: originalItem.name,
          oldQuantity: originalItem.quantity,
          oldItemId: originalItem.itemId ?? null,
          newCategory: inventoryItemDraft.category,
          newName,
          newQuantity: inventoryItemDraft.quantity,
          newItemId: itemId,
        })
        : await invoke<InventorySnapshot>("axion_item_cache_add", {
          customGameId: inventory.customGameId,
          accountId: inventory.accountId,
          category: inventoryItemDraft.category,
          name: newName,
          quantity: inventoryItemDraft.quantity,
          itemId,
        });
      replaceInventorySnapshot(updated);
      setItemContextMenu(null);
      setInventoryItemDraft(null);
      setItemCategoryMenuOpen(false);
      notify(originalItem ? t("serverScript.itemUpdated") : t("serverScript.itemAdded"));
    } catch (error) {
      notify(t("serverScript.itemUpdateError", {
        message: t("serverScript.itemUpdateFailed"),
        detail: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setSavingInventoryItem(false);
    }
  };

  const deleteInventoryItem = async () => {
    if (!itemContextMenu?.item) return;
    const { inventory, item } = itemContextMenu;
    setItemContextMenu(null);
    if (!(await requestConfirmation(t("serverScript.confirmDeleteItem").replace("{name}", item.name)))) return;
    try {
      const updated = await invoke<InventorySnapshot>("axion_item_cache_delete", {
        customGameId: inventory.customGameId,
        accountId: inventory.accountId,
        category: item.category,
        name: item.name,
        quantity: item.quantity,
        itemId: item.itemId ?? null,
      });
      replaceInventorySnapshot(updated);
      notify(t("serverScript.itemDeleted"));
    } catch (error) {
      notify(t("serverScript.itemDeleteError", {
        message: t("serverScript.itemDeleteFailed"),
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const deleteInventoryWorkspace = async () => {
    const inventory = itemContextMenu?.inventory;
    if (!inventory) return;
    setItemContextMenu(null);
    const confirmationMessage = t("serverScript.confirmDeleteWorkspace")
      .replace("{game}", inventory.customGameId)
      .replace("{account}", inventory.accountId);
    if (!(await requestConfirmation(confirmationMessage))) return;

    try {
      await invoke("axion_item_cache_delete_workspace", {
        customGameId: inventory.customGameId,
        accountId: inventory.accountId,
      });
      removeInventorySnapshot(inventory.customGameId, inventory.accountId);
      notify(t("serverScript.workspaceDeleted"));
    } catch (error) {
      notify(t("serverScript.workspaceDeleteError", {
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const showInventoryContextMenu = (
    event: MouseEvent<HTMLElement>,
    inventory: InventorySnapshot,
    item: InventoryItem | null,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setItemContextMenu({
      x: event.clientX,
      y: event.clientY,
      inventory,
      item,
      mode: "menu",
    });
  };

  if (initializing) return <div className="page lua-scripts-page" />;

  const clientExample = `-- Configure this once; AXION sends it with each WebSocket heartbeat.
getgenv().AXIONInventory = {
  { name = "Potion", quantity = 2, category = "materials" },
  { name = "Iron Ore", quantity = 15, category = "materials" }
}

-- This call only fetches the current online inventory.
local inventory = AXION:FetchOnlineInventory("${apiToken || "YOUR_API_TOKEN"}")
print("Game scope:", inventory.customGameId)
print("Online inventory items:", inventory.count)
for _, item in ipairs(inventory.items) do
  print(item.playerName, item.itemName, item.quantity)
end`;
  const inventoryExample = `AXION:ReportInventory({
  { name = "Potion", quantity = 2 },
  { name = "Iron Ore", quantity = 15 }
})`;

  return (
    <div className="page lua-scripts-page">
      {initializationError && (
        <div className="lua-runtime-warning">
          {t("serverScript.initializationFailed", { detail: initializationError })}
        </div>
      )}
      {workspaceReportNotice && (
        <div className="lua-runtime-warning">
          {workspaceReportNotice.type === "received"
            ? t("serverScript.workspaceReceived", workspaceReportNotice)
            : t("serverScript.workspaceReportError", workspaceReportNotice)}
        </div>
      )}

      {view === "scripts" && (
        <details className="card server-script-connection">
          <summary className="server-script-connection-summary">
            <span className="card-title"><Database size={16} /><h2>{t("serverScript.connection")}</h2></span>
            <span className="server-script-connection-summary-status">
              <span className={`server-script-api-status ${apiRunning ? "online" : "offline"}`}>
                <i /> {apiRunning ? t("serverScript.listeningAt", { port: apiPort }) : t("serverScript.apiOffline")}
              </span>
              <ChevronDown size={15} aria-hidden="true" />
            </span>
          </summary>
          <div className="server-script-connection-content">
            <div className="server-script-config-header">
              <div className="server-script-api-actions">
                <button className="btn-primary" onClick={() => void copyApiScript()}>
                  <Copy size={14} /> {t("serverScript.copyApi")}
                </button>
              </div>
            </div>
            <div className="server-script-listener-grid">
              <div className="server-script-listener-control">
                <label className="server-script-name" htmlFor="server-script-api-port">
                  <span className="server-script-listener-heading">
                    {t("serverScript.apiPortLabel")}
                    <small className={`server-script-endpoint ${apiRunning ? "online" : "offline"}`}>
                      <i aria-hidden="true" />
                      localhost:{apiPort}
                    </small>
                  </span>
                  <input
                    id="server-script-api-port"
                    type="number"
                    min={1024}
                    max={65535}
                    value={apiPortInput}
                    onChange={event => setApiPortInput(event.target.value)}
                  />
                </label>
                <button className="btn-ghost" onClick={() => void applyApiPort()} disabled={apiPortBusy}>
                  {apiPortBusy ? t("serverScript.applyingPort") : t("serverScript.applyPort")}
                </button>
              </div>
              <div className="server-script-listener-control">
                <label className="server-script-name" htmlFor="server-script-websocket-port">
                  <span className="server-script-listener-heading">
                    {t("serverScript.websocketPort")}
                    <small className={`server-script-endpoint ${websocketRunning ? "online" : "offline"}`}>
                      <i aria-hidden="true" />
                      localhost:{websocketPort}
                    </small>
                  </span>
                  <input
                    id="server-script-websocket-port"
                    type="number"
                    min={1024}
                    max={65535}
                    value={websocketPort}
                    onChange={event => setWebsocketPort(event.target.value)}
                    disabled={websocketPortBusy}
                  />
                </label>
                <button className="btn-ghost" onClick={() => void applyWebsocketPort()} disabled={websocketPortBusy}>
                  {websocketPortBusy ? t("serverScript.websocketPortApplying") : t("serverScript.websocketPortApply")}
                </button>
              </div>
            </div>
            <div className="server-script-token-row">
              <label htmlFor="server-script-token">{t("serverScript.apiToken")}</label>
              <input id="server-script-token" type={showApiToken ? "text" : "password"} readOnly value={apiToken} />
              <button
                className="btn-ghost server-script-token-toggle"
                onClick={() => setShowApiToken(visible => !visible)}
                aria-label={showApiToken ? t("serverScript.hideToken") : t("serverScript.showToken")}
                title={showApiToken ? t("serverScript.hideToken") : t("serverScript.showToken")}
              >
                {showApiToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button className="btn-ghost" onClick={() => void copyText(apiToken, t("serverScript.tokenCopied"))} disabled={!apiToken}>
                <Copy size={14} /> {t("serverScript.copyToken")}
              </button>
            </div>
            <div className="server-script-connection-footer">
              <code>http://localhost:{apiPort}/api/v1/call</code>
              <small>{t("serverScript.scopeHelp")}</small>
            </div>
            <details className="server-script-examples">
              <summary>{t("serverScript.usageExamples")}</summary>
              <div className="server-script-example-grid">
                <div>
                  <div className="server-script-section-heading">
                    <b>{t("serverScript.callExample")}</b>
                    <button className="btn-ghost" onClick={() => void copyText(clientExample, t("serverScript.exampleCopied"))}><Copy size={13} /> {t("serverScript.copy")}</button>
                  </div>
                  <SyntaxCodeBlock code={clientExample} language="lua" />
                </div>
                <div>
                  <div className="server-script-section-heading">
                    <b>{t("serverScript.inventoryExample")}</b>
                    <button className="btn-ghost" onClick={() => void copyText(inventoryExample, t("serverScript.exampleCopied"))}><Copy size={13} /> {t("serverScript.copy")}</button>
                  </div>
                  <SyntaxCodeBlock code={inventoryExample} language="lua" />
                </div>
              </div>
            </details>
          </div>
        </details>
      )}

      <div className="server-script-toolbar">
        <div className="server-script-scope-bar">
          <div className="server-script-scope-actions">
            <label className="server-script-profile-select">
              <span>{t("serverScript.selectScope")}</span>
              <div className={`server-script-profile-dropdown ${scopeMenuOpen ? "open" : ""}`} ref={scopeDropdownRef}>
                <button
                  type="button"
                  className="server-script-profile-trigger"
                  aria-label={t("serverScript.selectScope")}
                  aria-haspopup="listbox"
                  aria-expanded={scopeMenuOpen}
                  onClick={() => setScopeMenuOpen(open => !open)}
                  onKeyDown={event => {
                    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setScopeMenuOpen(true);
                    }
                  }}
                >
                  <span>{selectedGameId}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                {scopeMenuOpen && (
                  <div className="server-script-profile-options" role="listbox" aria-label={t("serverScript.selectScope")}>
                    {knownGameIds.map(gameId => {
                      const scriptCount = scripts.filter(script => script.customGameId === gameId).length;
                      return (
                        <button
                          key={gameId}
                          type="button"
                          role="option"
                          aria-selected={gameId === selectedGameId}
                          className={gameId === selectedGameId ? "selected" : ""}
                          onClick={() => {
                            setScopeMenuOpen(false);
                            void changeGameScope(gameId);
                          }}
                        >
                          <span>{gameId}</span>
                          <small>{t("serverScript.scopeScriptCount", { count: scriptCount })}</small>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </label>
            {view === "scripts" && scopedScripts.length > 0 && (
              <button
                className="btn-ghost server-script-profile-delete"
                onClick={() => void deleteProfile()}
                title={t("serverScript.deleteProfile")}
                aria-label={t("serverScript.deleteProfile")}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            )}
          </div>
          <form
            className="server-script-scope-create"
            onSubmit={event => {
              event.preventDefault();
              void changeGameScope(gameIdInput);
            }}
          >
            <input
              aria-label={t("serverScript.gameScope")}
              value={gameIdInput}
              onChange={event => setGameIdInput(event.target.value.trim())}
              placeholder={t("serverScript.gameScopePlaceholder")}
              maxLength={64}
              pattern="[A-Za-z0-9_-]{1,64}"
              required
            />
            <button className="btn-primary" type="submit">{t("serverScript.applyGameScope")}</button>
          </form>
        </div>
        <div className="server-script-toolbar-actions">
          {view === "scripts" && (
            <>
              <button className="btn-ghost" onClick={exportProfile} title={t("serverScript.exportProfile")}>
                <Download size={14} /> {t("serverScript.exportProfile")}
              </button>
              <button className="btn-ghost" onClick={() => profileFileInput.current?.click()} title={t("serverScript.importProfile")}>
                <Upload size={14} /> {t("serverScript.importProfile")}
              </button>
              <input
                ref={profileFileInput}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={event => void importProfile(event)}
              />
            </>
          )}
        </div>
      </div>

      {view === "scripts" ? (
        <div className="server-script-workspace server-script-tab-panel">
        <section className="card server-script-library">
          <header className="card-head">
            <div className="card-title"><FileCode2 size={16} /><h2>{t("serverScript.library")}</h2></div>
          </header>
          {scopedScripts.length === 0 ? (
            <div className="lua-script-empty">{t("serverScript.emptyProfile")}</div>
          ) : scopedScripts.map(script => (
            <button
              key={script.id}
              className={`lua-script-item ${selectedId === script.id && !draft ? "active" : ""}`}
              onClick={() => { setDraft(null); setSelectedId(script.id); }}
            >
              <span className="lua-script-item-icon"><FileCode2 size={16} /></span>
              <span className="lua-script-item-copy"><b>{script.name}</b><small>{script.customGameId} · {t("serverScript.serverFunction")}</small></span>
            </button>
          ))}
        </section>

        <section className="card lua-script-editor server-script-editor">
          {editor ? (
            <>
              <header className="lua-editor-heading">
                <div className="card-title"><FileCode2 size={16} /><h2>{t(isNewScript ? "serverScript.profileScript" : "serverScript.edit")}</h2></div>
                <div className="server-script-editor-actions">
                  {hasUnsavedChanges && <span className="lua-editor-status">{t("serverScript.unsaved")}</span>}
                  {!isNewScript && selected && (
                    <button className="btn-ghost lua-delete-button" onClick={() => removeScript(selected)}>
                      <Trash2 size={14} /> {t("serverScript.delete")}
                    </button>
                  )}
                  <button className="btn-primary" disabled={!draft || busy} onClick={() => void saveScript()}>
                    <Save size={14} /> {busy ? t("serverScript.saving") : t("serverScript.save")}
                  </button>
                </div>
              </header>
              <label className="server-script-name">{t("serverScript.name")}<input value={editor.name} onChange={event => setDraft({ ...editor, name: event.target.value })} /></label>
              <small>{t("serverScript.registeredOnlyFor", { scope: selectedGameId })}</small>
              <label className="lua-source-label">{t("serverScript.code")}</label>
              <SyntaxCodeEditor
                className="lua-source-editor"
                value={editor.source}
                onChange={source => setDraft({ ...editor, source })}
              />
              <div className="server-script-signature">{t("serverScript.exportsHint")}</div>
            </>
          ) : (
            <div className="lua-script-empty lua-editor-placeholder">{t("serverScript.choose")}</div>
          )}
        </section>
        </div>
      ) : (

      <section className="card server-script-inventory server-script-tab-panel">
        <header className="server-script-section-heading">
          <div className="card-title"><Database size={16} /><h2>{t("serverScript.itemCache")}</h2></div>
          <div className="server-script-cache-actions">
            <label className="server-script-search"><Search size={14} /><input value={inventoryQuery} onChange={event => setInventoryQuery(event.target.value)} placeholder={t("serverScript.searchPlaceholder")} /></label>
            <button className="btn-ghost" onClick={() => void refreshCache()} disabled={refreshingInventory}>
              <RefreshCw size={13} className={refreshingInventory ? "spin" : ""} />
              {refreshingInventory ? t("serverScript.refreshing") : t("serverScript.refresh")}
            </button>
          </div>
        </header>
        <small className="server-script-cache-hint">{t("serverScript.editItemHint")}</small>
        {filteredInventories.length === 0 ? (
          <div className="lua-script-empty">
            {gameInventories.length === 0
              ? `No saved workspace data for ${selectedGameId}. Check the AXION API CustomGameId, apply the same Game scope above, then refresh. Available scopes: ${knownGameIds.filter(gameId => inventories.some(inventory => inventory.customGameId === gameId)).join(", ") || "none"}.`
              : t("serverScript.noItems")}
          </div>
        ) : (
          <div className="server-script-inventory-grid">
            {filteredInventories.map(inventory => (
              <article
                className="server-script-player-cache"
                key={`${inventory.customGameId}/${inventory.accountId}`}
                onContextMenu={event => showInventoryContextMenu(event, inventory, null)}
              >
                <span
                  className={`server-script-status-dot ${inventory.online ? "online" : "offline"}`}
                  title={inventory.online ? t("serverScript.online") : t("serverScript.offline")}
                  aria-label={inventory.online ? t("serverScript.online") : t("serverScript.offline")}
                  role="img"
                />
                <header>
                  <div><b>{inventory.agentName}</b><small>({inventory.customGameId}) / {inventory.accountId}</small></div>
                </header>
                {inventory.items.length > 0 ? (
                  <ul>
                    {inventory.items.map((item, index) => (
                      <li
                        key={`${item.itemId ?? item.name}-${index}`}
                        onContextMenu={event => {
                          showInventoryContextMenu(event, inventory, item);
                        }}
                        title={[
                          `Name: ${item.name}`,
                          `Category: ${item.category}`,
                          `Quantity: ${item.quantity}`,
                          item.itemId ? `Item ID: ${item.itemId}` : null,
                          item.value !== undefined ? `Value: ${String(item.value)}` : null,
                        ].filter(Boolean).join("\n")}
                      >
                        <span className="server-script-cache-item">
                          <span>{item.name}</span>
                          <small title={item.category}>{getInventoryCategoryLabel(item.category)}</small>
                          {item.value !== undefined && <small className="server-script-cache-value">{String(item.value)}</small>}
                        </span>
                        <b>× {item.quantity}</b>
                      </li>
                    ))}
                  </ul>
                ) : <small className="server-script-empty-inventory">{t("serverScript.emptyInventory")}</small>}
              </article>
            ))}
          </div>
        )}
      </section>
      )}
      {itemContextMenu && createPortal(
        <div
          className="cache-context-dismiss"
          onPointerDown={() => setItemContextMenu(null)}
          onContextMenu={event => {
            event.preventDefault();
            setItemContextMenu(null);
          }}
        >
          <div
            ref={itemContextMenuRef}
            className={`cache-context-menu ${itemContextMenu.mode !== "menu" ? "is-editing" : ""}`}
            role={itemContextMenu.mode === "menu" ? "menu" : "dialog"}
            style={{ left: itemContextMenu.x, top: itemContextMenu.y }}
            onPointerDown={event => event.stopPropagation()}
          >
            {itemContextMenu.mode === "menu" ? (
              <>
                <strong>{itemContextMenu.inventory.agentName}</strong>
                <button type="button" role="menuitem" onClick={beginInventoryItemEdit}>
                  <Pencil size={13} /> {t("serverScript.editItemContext")}
                </button>
                <button type="button" role="menuitem" onClick={() => openInventoryItemEditor(itemContextMenu.inventory)}>
                  <Plus size={13} /> {t("serverScript.addItem")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setItemContextMenu(null);
                    void copyText(itemContextMenu.inventory.accountId, t("serverScript.accountIdCopied"));
                  }}
                >
                  <Copy size={13} /> {t("serverScript.copyAccountId")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setItemContextMenu(null);
                    void copyText(
                      `${itemContextMenu.inventory.customGameId}/${itemContextMenu.inventory.accountId}`,
                      t("serverScript.cacheKeyCopied"),
                    );
                  }}
                >
                  <Copy size={13} /> {t("serverScript.copyCacheKey")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => void deleteInventoryWorkspace()}
                >
                  <Trash2 size={13} /> {t("serverScript.deleteWorkspace")}
                </button>
              </>
            ) : (
              <form className="cache-context-editor" onSubmit={event => void saveInventoryItem(event)}>
                <header>
                  <div>
                    <strong>{t(itemContextMenu.mode === "edit" ? "serverScript.editItemTitle" : "serverScript.addItemTitle")}</strong>
                    <small>{itemContextMenu.inventory.agentName} · {itemContextMenu.inventory.accountId}</small>
                  </div>
                  <button
                    type="button"
                    className="icon-btn cache-context-close"
                    onClick={closeInventoryItemEditor}
                    disabled={savingInventoryItem}
                    aria-label={t("common.close")}
                  >
                    <X size={14} />
                  </button>
                </header>
                {itemContextMenu.mode === "edit" && (
                  <div className="cache-context-item-picker" aria-label={t("serverScript.itemName")}>
                    {itemContextMenu.inventory.items.map((item, index) => (
                      <button
                        key={`${item.category}/${item.itemId ?? item.name}/${index}`}
                        type="button"
                        className={itemContextMenu.item === item ? "selected" : ""}
                        onClick={() => {
                          setItemContextMenu(current => current ? { ...current, item } : current);
                          setInventoryItemDraft({ ...item });
                        }}
                      >
                        <span>{item.name}<small>{item.category}</small></span>
                        <b>× {item.quantity}</b>
                      </button>
                    ))}
                  </div>
                )}
                <label>
                  {t("serverScript.itemName")}
                  <input
                    autoFocus={itemContextMenu.mode === "add"}
                    maxLength={80}
                    value={inventoryItemDraft?.name ?? ""}
                    disabled={!inventoryItemDraft}
                    onChange={event => setInventoryItemDraft(current => current ? { ...current, name: event.target.value } : current)}
                  />
                </label>
                <div className="form-row">
                  <label>
                    {t("serverScript.itemQuantity")}
                    <input
                      type="number"
                      min={0}
                      max={1_000_000_000}
                      step={1}
                      value={inventoryItemDraft?.quantity ?? 0}
                      disabled={!inventoryItemDraft}
                      onChange={event => setInventoryItemDraft(current => current ? { ...current, quantity: Number(event.target.value) } : current)}
                    />
                  </label>
                  <label>
                    {t("serverScript.itemCategory")}
                    <div className={`cache-category-dropdown language-dropdown ${itemCategoryMenuOpen ? "open" : ""}`}>
                      <button
                        type="button"
                        className="language-dropdown-trigger"
                        disabled={!inventoryItemDraft}
                        aria-haspopup="listbox"
                        aria-expanded={itemCategoryMenuOpen}
                        onClick={() => setItemCategoryMenuOpen(open => !open)}
                      >
                        <span>{inventoryItemDraft?.category ?? DEFAULT_INVENTORY_CATEGORIES[0]}</span>
                        <ChevronDown size={14} aria-hidden="true" />
                      </button>
                      {itemCategoryMenuOpen && inventoryItemDraft && (
                        <div className="language-dropdown-options cache-category-options" role="listbox" aria-label={t("serverScript.itemCategory")}>
                          {inventoryCategories.map(category => (
                            <button
                              key={category}
                              type="button"
                              role="option"
                              aria-selected={inventoryItemDraft.category === category}
                              className={inventoryItemDraft.category === category ? "selected" : ""}
                              onClick={() => {
                                setInventoryItemDraft(current => current ? { ...current, category } : current);
                                setItemCategoryMenuOpen(false);
                              }}
                            >
                              <span>{category}</span>
                            </button>
                          ))}
                          <form
                            className="cache-new-category"
                            onSubmit={event => {
                              event.preventDefault();
                              addInventoryCategory();
                            }}
                          >
                            <input
                              value={newInventoryCategory}
                              maxLength={128}
                              placeholder={t("serverScript.newCategory")}
                              onChange={event => setNewInventoryCategory(event.target.value)}
                            />
                            <button type="submit" disabled={!newInventoryCategory.trim()}>
                              <Plus size={13} /> {t("serverScript.addCategory")}
                            </button>
                          </form>
                        </div>
                      )}
                    </div>
                  </label>
                </div>
                <label>
                  {t("serverScript.itemId")}
                  <input
                    maxLength={128}
                    value={inventoryItemDraft?.itemId ?? ""}
                    disabled={!inventoryItemDraft}
                    onChange={event => setInventoryItemDraft(current => current ? { ...current, itemId: event.target.value || null } : current)}
                  />
                </label>
                <footer>
                  {itemContextMenu.mode === "edit" && itemContextMenu.item && (
                    <button
                      type="button"
                      className="cache-context-delete"
                      disabled={savingInventoryItem}
                      onClick={() => void deleteInventoryItem()}
                    >
                      <Trash2 size={12} /> {t("serverScript.deleteItem")}
                    </button>
                  )}
                  <button type="button" className="btn-ghost" disabled={savingInventoryItem} onClick={closeInventoryItemEditor}>
                    {t("serverScript.cancelEdit")}
                  </button>
                  <button type="submit" className="btn-primary" disabled={savingInventoryItem || !inventoryItemDraft}>
                    <Save size={14} /> {savingInventoryItem ? t("serverScript.savingItem") : t("serverScript.saveItem")}
                  </button>
                </footer>
              </form>
            )}
          </div>
        </div>,
        document.body,
      )}
      {confirmation && createPortal(
        <div
          className="modal-overlay"
          onPointerDown={event => {
            if (event.target === event.currentTarget) closeConfirmation(false);
          }}
        >
          <section
            className="modal cache-confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-label={t("serverScript.confirmTitle")}
          >
            <h3>{t("serverScript.confirmTitle")}</h3>
            <p>{confirmation.message}</p>
            <footer>
              <button type="button" className="btn-ghost" onClick={() => closeConfirmation(false)}>
                {t("serverScript.cancelEdit")}
              </button>
              <button type="button" className="btn-primary" onClick={() => closeConfirmation(true)}>
                {t("serverScript.confirmAction")}
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
