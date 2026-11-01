import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { Check, ChevronDown, FolderOpen, RefreshCw, Settings } from "lucide-react";
import { getLanguageLabel, useLanguage } from "../i18n/LanguageContext";

type Theme = "dark" | "light";

interface Props {
  notify: (m: string) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

export default function SettingsPage({ notify, theme, onThemeChange }: Props) {
  const { language, languages, languageStatus, setLanguage, refreshLanguages, t } = useLanguage();
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);
  const [notif, setNotif] = useState(true);
  const [refreshingLanguages, setRefreshingLanguages] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const languageDropdownRef = useRef<HTMLDivElement>(null);
  const languageTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    if (!isTauri()) {
      setAutoStartLoading(false);
      return () => {
        active = false;
      };
    }

    void isEnabled()
      .then(enabled => {
        if (active) setAutoStart(enabled);
      })
      .catch(error => {
        if (active) {
          notify(t("settings.autoStartLoadFailed", {
            detail: error instanceof Error ? error.message : String(error),
          }));
        }
      })
      .finally(() => {
        if (active) setAutoStartLoading(false);
      });

    return () => {
      active = false;
    };
  }, [notify, t]);

  useEffect(() => {
    if (!languageMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !languageDropdownRef.current?.contains(event.target)) {
        setLanguageMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLanguageMenuOpen(false);
        languageTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [languageMenuOpen]);

  const focusLanguageOption = (index: number) => {
    const options = languageDropdownRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    if (!options?.length) return;
    options[Math.max(0, Math.min(index, options.length - 1))]?.focus();
  };

  const refreshLocaleList = async () => {
    setRefreshingLanguages(true);
    try {
      await refreshLanguages();
    } catch (error) {
      notify(t("settings.languageRefreshFailed", {
        detail: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setRefreshingLanguages(false);
    }
  };

  const openLocaleFolder = async () => {
    if (!isTauri()) {
      notify(t("settings.languageFolderFailed", { detail: t("settings.desktopRequired") }));
      return;
    }
    try {
      await invoke("axion_open_locale_folder");
    } catch (error) {
      notify(t("settings.languageFolderFailed", {
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const toggleAutoStart = async () => {
    if (!isTauri() || autoStartLoading) return;
    setAutoStartLoading(true);
    try {
      if (autoStart) {
        await disable();
        setAutoStart(false);
      } else {
        await enable();
        setAutoStart(true);
      }
    } catch (error) {
      notify(t("settings.autoStartUpdateFailed", {
        detail: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setAutoStartLoading(false);
    }
  };

  return (
    <div className="page settings-page">
      <section className="card settings-page-card">
        <header className="card-head">
          <div className="card-title">
            <Settings size={17} />
            <h2>{t("settings.title")}</h2>
          </div>
        </header>

        <div className="setting-row">
          <div>
            <b>{t("settings.autoStart")}</b>
            <small>{t("settings.autoStartDescription")}</small>
          </div>
          <button
            className="setting-toggle"
            type="button"
            role="switch"
            aria-label={t("settings.autoStart")}
            aria-checked={autoStart}
            disabled={autoStartLoading || !isTauri()}
            onClick={() => void toggleAutoStart()}
          />
        </div>

        <div className="setting-row">
          <div>
            <b>{t("settings.notifications")}</b>
            <small>{t("settings.notificationsDescription")}</small>
          </div>
          <button
            className="setting-toggle"
            type="button"
            role="switch"
            aria-label={t("settings.notifications")}
            aria-checked={notif}
            onClick={() => setNotif(value => !value)}
          />
        </div>

        <div className="setting-row">
          <div>
            <b>{t("settings.theme")}</b>
            <small>{t("settings.themeDescription")}</small>
          </div>
          <div className="theme-options" role="group" aria-label={t("settings.theme")}>
            <button aria-pressed={theme === "dark"} className={theme === "dark" ? "active" : ""} onClick={() => onThemeChange("dark")}>{t("settings.dark")}</button>
            <button aria-pressed={theme === "light"} className={theme === "light" ? "active" : ""} onClick={() => onThemeChange("light")}>{t("settings.light")}</button>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <b>{t("settings.language")}</b>
            <small>{t("settings.languageDescription")}</small>
            <small className="language-custom-help">{t("settings.languageCustomHelp")}</small>
          </div>
          <div className="language-controls">
            <div className={`language-dropdown ${languageMenuOpen ? "open" : ""}`} ref={languageDropdownRef}>
              <button
                ref={languageTriggerRef}
                type="button"
                className="language-dropdown-trigger"
                aria-label={t("settings.language")}
                aria-haspopup="listbox"
                aria-expanded={languageMenuOpen}
                onClick={() => setLanguageMenuOpen(open => !open)}
                onKeyDown={event => {
                  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setLanguageMenuOpen(true);
                    window.requestAnimationFrame(() => focusLanguageOption(0));
                  }
                }}
              >
                <span>{getLanguageLabel(language)}</span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>
              {languageMenuOpen && (
                <div className="language-dropdown-options" role="listbox" aria-label={t("settings.language")}>
                  {languages.map((code, index) => (
                    <button
                      key={code}
                      type="button"
                      role="option"
                      aria-selected={code === language}
                      className={code === language ? "selected" : ""}
                      onClick={() => {
                        setLanguageMenuOpen(false);
                        void setLanguage(code);
                      }}
                      onKeyDown={event => {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          focusLanguageOption(index + (event.key === "ArrowDown" ? 1 : -1));
                        } else if (event.key === "Home" || event.key === "End") {
                          event.preventDefault();
                          focusLanguageOption(event.key === "Home" ? 0 : languages.length - 1);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setLanguageMenuOpen(false);
                          languageTriggerRef.current?.focus();
                        }
                      }}
                    >
                      <span>{getLanguageLabel(code)}</span>
                      {code === language && <Check size={14} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="btn-ghost" type="button" onClick={() => void refreshLocaleList()} disabled={refreshingLanguages}>
              <RefreshCw size={14} className={refreshingLanguages ? "spin" : undefined} />
              {t("settings.refreshLanguages")}
            </button>
            <button className="btn-ghost" type="button" onClick={() => void openLocaleFolder()}>
              <FolderOpen size={14} />
              {t("settings.languageFolder")}
            </button>
          </div>
        </div>
        {languageStatus && (
          <div className={`language-status ${languageStatus.type}`} role="status">
            {languageStatus.type === "error"
              ? <p>{t("settings.languageLoadError", { detail: languageStatus.detail })}</p>
              : (
                <>
                  <strong>Locale source file: <code>{languageStatus.locale}.json</code></strong>
                  <span>Open Settings → Language → Open Language Folder to edit this file.</span>
                  <span>
                    English fallback is active for {languageStatus.missing} missing keys,{" "}
                    {languageStatus.invalid} invalid values, and {languageStatus.placeholders} placeholder mismatches.
                  </span>
                  {languageStatus.missingPaths.length > 0 && (
                    <details>
                      <summary>Missing translation keys ({languageStatus.missingPaths.length})</summary>
                      <pre>{languageStatus.missingPaths.join("\n")}</pre>
                    </details>
                  )}
                  {languageStatus.invalidPaths.length > 0 && (
                    <details>
                      <summary>Invalid values or unknown keys ({languageStatus.invalidPaths.length})</summary>
                      <pre>{languageStatus.invalidPaths.join("\n")}</pre>
                    </details>
                  )}
                  {languageStatus.placeholderPaths.length > 0 && (
                    <details>
                      <summary>Placeholder mismatches ({languageStatus.placeholderPaths.length})</summary>
                      <pre>{languageStatus.placeholderPaths.join("\n")}</pre>
                    </details>
                  )}
                </>
              )}
          </div>
        )}

        <footer>
          <button className="btn-primary" onClick={() => notify(t("settings.saved"))}>
            {t("settings.save")}
          </button>
        </footer>
      </section>
    </div>
  );
}
