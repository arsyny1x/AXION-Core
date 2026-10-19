import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Context, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import english from "../../config/locales/en-US.json";
import thai from "../../config/locales/th-TH.json";
import vietnamese from "../../config/locales/vi-VN.json";
import {
  getLocaleMessage,
  validateAndMergeLocale,
  type LocaleCatalog,
  type TranslationParams,
} from "./localeCatalog";

export type LanguageCode = string;
export type LanguageStatus =
  | { type: "error"; detail: string }
  | {
      type: "warning";
      locale: string;
      missing: number;
      invalid: number;
      placeholders: number;
      missingPaths: string[];
      invalidPaths: string[];
      placeholderPaths: string[];
    }
  | null;

interface LanguageContextValue {
  language: LanguageCode;
  languages: LanguageCode[];
  languageStatus: LanguageStatus;
  setLanguage: (language: LanguageCode) => Promise<void>;
  refreshLanguages: () => Promise<void>;
  t: (key: string, params?: TranslationParams) => string;
}

const hot = import.meta.hot;
// Keep provider and consumer on the same context when Vite reevaluates this module.
const LanguageContext = (hot?.data.languageContext as Context<LanguageContextValue | null> | undefined) ??
  createContext<LanguageContextValue | null>(null);
if (hot) hot.data.languageContext = LanguageContext;
const LANGUAGE_STORAGE_KEY = "axion.language";
const LEGACY_LANGUAGE_STORAGE_KEY = "autohub.language";
const FALLBACK_CATALOG = english as LocaleCatalog;
const BUILTIN_CATALOGS: Record<string, LocaleCatalog> = {
  "en-US": FALLBACK_CATALOG,
  "th-TH": thai as LocaleCatalog,
  "vi-VN": vietnamese as LocaleCatalog,
};

function normalizeLanguageCode(code: string): string {
  const legacyCodes: Record<string, string> = {
    en: "en-US",
    th: "th-TH",
    vn: "vi-VN",
  };
  return legacyCodes[code] ?? code;
}

function getInitialLanguage(): LanguageCode {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? localStorage.getItem(LEGACY_LANGUAGE_STORAGE_KEY);
    return stored && /^[A-Za-z0-9_-]{2,16}$/.test(stored) ? normalizeLanguageCode(stored) : "th-TH";
  } catch {
    return "th-TH";
  }
}

function persistLanguage(language: string): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch (error) {
    console.error("Could not save selected language", error);
  }
}

async function readLocale(language: string): Promise<{
  catalog: LocaleCatalog;
  missing: number;
  invalid: number;
  placeholders: number;
  missingPaths: string[];
  invalidPaths: string[];
  placeholderPaths: string[];
}> {
  if (!isTauri()) {
    const catalog = BUILTIN_CATALOGS[language];
    if (!catalog) throw new Error(`Custom locale "${language}" can only be loaded in AXION Core Desktop.`);
    return {
      catalog,
      missing: 0,
      invalid: 0,
      placeholders: 0,
      missingPaths: [],
      invalidPaths: [],
      placeholderPaths: [],
    };
  }
  const source = await invoke<string>("axion_read_locale", { locale: language });
  const validation = validateAndMergeLocale(source, FALLBACK_CATALOG);
  return {
    catalog: validation.catalog,
    missing: validation.missingKeys,
    invalid: validation.invalidValues,
    placeholders: validation.placeholderMismatches,
    missingPaths: validation.missingKeyPaths,
    invalidPaths: validation.invalidValuePaths,
    placeholderPaths: validation.placeholderMismatchPaths,
  };
}

export function getLanguageLabel(code: string): string {
  const builtInLabels: Record<string, string> = { "th-TH": "ไทย", "en-US": "English", "vi-VN": "Tiếng Việt" };
  if (builtInLabels[code]) return builtInLabels[code];
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<LanguageCode>(getInitialLanguage);
  const [languages, setLanguages] = useState<string[]>(Object.keys(BUILTIN_CATALOGS));
  const [catalogs, setCatalogs] = useState<Record<string, LocaleCatalog>>(BUILTIN_CATALOGS);
  const [languageStatus, setLanguageStatus] = useState<LanguageStatus>(null);
  const loadSequence = useRef(0);
  const selectionSequence = useRef(0);
  const selectionPending = useRef(false);
  const selectedLanguage = useRef(language);

  const loadLanguage = useCallback(async (code: string, updateSelection: boolean, selectionId?: number) => {
    const sequence = ++loadSequence.current;
    try {
      const result = await readLocale(code);
      if (sequence !== loadSequence.current) return;
      if (updateSelection && selectionId !== selectionSequence.current) return;
      setCatalogs(previous => ({ ...previous, [code]: result.catalog }));
      if (result.missing || result.invalid || result.placeholders) {
        console.warn(
          `[i18n] Locale "${code}" has invalid or missing translations. ` +
            `Update ${code}.json in Settings > Language > Open Language Folder using the listed key paths.`,
          {
            missingKeys: result.missingPaths,
            invalidValues: result.invalidPaths,
            placeholderMismatches: result.placeholderPaths,
          },
        );
      }
      setLanguageStatus(
        result.missing || result.invalid || result.placeholders
          ? {
              type: "warning",
              locale: code,
              missing: result.missing,
              invalid: result.invalid,
              placeholders: result.placeholders,
              missingPaths: result.missingPaths,
              invalidPaths: result.invalidPaths,
              placeholderPaths: result.placeholderPaths,
            }
          : null,
      );
      if (updateSelection) {
        selectedLanguage.current = code;
        setLanguageState(code);
        persistLanguage(code);
      }
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      const detail = error instanceof Error ? error.message : String(error);
      setLanguageStatus({ type: "error", detail });
      console.error(`Could not load locale "${code}"`, error);
    }
  }, []);

  const refreshLanguages = useCallback(async () => {
    if (!isTauri()) {
      setLanguages(Object.keys(BUILTIN_CATALOGS));
      return;
    }
    const selectionId = selectionSequence.current;
    try {
      const discovered = await invoke<string[]>("axion_list_locales");
      const nextLanguages = [...new Set(discovered.filter(code => /^[A-Za-z0-9_-]{2,16}$/.test(code)))].sort();
      setLanguages(nextLanguages);
      let selected = selectedLanguage.current;
      if (!nextLanguages.includes(selected)) {
        selected = nextLanguages.includes("th-TH") ? "th-TH" : "en-US";
        selectedLanguage.current = selected;
        setLanguageState(selected);
        persistLanguage(selected);
      }
      if (!nextLanguages.includes(selected)) {
        setLanguageStatus({ type: "error", detail: "No usable locale files were found." });
      } else if (selectionId === selectionSequence.current && !selectionPending.current) {
        await loadLanguage(selected, false);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setLanguageStatus({ type: "error", detail });
      console.error("Could not refresh available locales", error);
    }
  }, [loadLanguage]);

  useEffect(() => {
    void refreshLanguages();
  }, [refreshLanguages]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback(async (next: string) => {
    const normalized = normalizeLanguageCode(next);
    if (!languages.includes(normalized)) {
      setLanguageStatus({ type: "error", detail: `Locale "${normalized}" is not installed.` });
      return;
    }
    const selectionId = ++selectionSequence.current;
    selectionPending.current = true;
    try {
      await loadLanguage(normalized, true, selectionId);
    } finally {
      if (selectionId === selectionSequence.current) selectionPending.current = false;
    }
  }, [languages, loadLanguage]);

  const t = useCallback(
    (key: string, params?: TranslationParams) =>
      getLocaleMessage(catalogs[language] ?? FALLBACK_CATALOG, key, params),
    [catalogs, language],
  );
  const value = useMemo(
    () => ({ language, languages, languageStatus, setLanguage, refreshLanguages, t }),
    [language, languages, languageStatus, setLanguage, refreshLanguages, t],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within LanguageProvider");
  return context;
}
