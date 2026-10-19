import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Eraser, Search, Terminal } from "lucide-react";
import type { LogEntry } from "../data/mock";
import { clearLogs, getLogs, MAX_LOG_ENTRIES, subscribeLogs } from "../services/logService";
import { useLanguage } from "../i18n/LanguageContext";
import { SyntaxTerminalText } from "./SyntaxCode";

type LevelFilter = "all" | "info" | "warn" | "error";

interface Props {
  fullPage?: boolean;
  embedded?: boolean;
}

export default function LiveLog({ fullPage = false, embedded = false }: Props) {
  const { t } = useLanguage();
  const [logRevision, setLogRevision] = useState(0);
  const logs: readonly LogEntry[] = getLogs();
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [levelMenuOpen, setLevelMenuOpen] = useState(false);
  const levelDropdownRef = useRef<HTMLDivElement>(null);
  const levelTriggerRef = useRef<HTMLButtonElement>(null);
  const levelOptions: { value: LevelFilter; label: string }[] = [
    { value: "all", label: t("console.allLevels") },
    { value: "info", label: t("console.info") },
    { value: "warn", label: t("console.warnings") },
    { value: "error", label: t("console.errors") },
  ];

  useEffect(() => subscribeLogs(() => setLogRevision(revision => revision + 1)), []);

  useEffect(() => {
    if (!levelMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !levelDropdownRef.current?.contains(event.target)) {
        setLevelMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLevelMenuOpen(false);
        levelTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [levelMenuOpen]);

  const focusLevelOption = (index: number) => {
    const options = levelDropdownRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    if (!options?.length) return;
    options[Math.max(0, Math.min(index, options.length - 1))]?.focus();
  };

  const errorCount = useMemo(
    () => logs.filter((log) => log.level === "error").length,
    [logRevision, logs],
  );
  const displayedLogs = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filtered = logs.filter((log) => (
      (levelFilter === "all" || log.level === levelFilter || (levelFilter === "info" && log.level === "ok"))
      && (!normalizedQuery || `${log.time} ${log.source} ${log.text}`.toLocaleLowerCase().includes(normalizedQuery))
    ));
    return fullPage || embedded ? filtered : filtered.slice(0, 9);
  }, [embedded, fullPage, levelFilter, logRevision, logs, query]);

  const feed = (
    <>
      {fullPage && (
        <div className="console-toolbar">
          <label className="console-search">
            <Search size={14} />
            <input
              aria-label={t("console.search")}
              placeholder={t("console.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="language-dropdown console-level-dropdown" ref={levelDropdownRef}>
            <button
              ref={levelTriggerRef}
              type="button"
              className="language-dropdown-trigger"
              aria-label={t("console.level")}
              aria-haspopup="listbox"
              aria-expanded={levelMenuOpen}
              onClick={() => setLevelMenuOpen(open => !open)}
              onKeyDown={event => {
                if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setLevelMenuOpen(true);
                  window.requestAnimationFrame(() => focusLevelOption(
                    Math.max(0, levelOptions.findIndex(option => option.value === levelFilter)),
                  ));
                }
              }}
            >
              <span>{levelOptions.find(option => option.value === levelFilter)?.label}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {levelMenuOpen && (
              <div className="language-dropdown-options" role="listbox" aria-label={t("console.level")}>
                {levelOptions.map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === levelFilter}
                    className={option.value === levelFilter ? "selected" : ""}
                    onClick={() => {
                      setLevelFilter(option.value);
                      setLevelMenuOpen(false);
                    }}
                    onKeyDown={event => {
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        focusLevelOption(index + (event.key === "ArrowDown" ? 1 : -1));
                      } else if (event.key === "Home" || event.key === "End") {
                        event.preventDefault();
                        focusLevelOption(event.key === "Home" ? 0 : levelOptions.length - 1);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setLevelMenuOpen(false);
                        levelTriggerRef.current?.focus();
                      }
                    }}
                  >
                    <span>{option.label}</span>
                    {option.value === levelFilter && <Check size={14} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="console-log-count">
            {logs.length}/{MAX_LOG_ENTRIES} · {t("console.errors")}: {errorCount}
          </span>
          <button className="console-clear" onClick={clearLogs}>
            <Eraser size={13} /> {t("console.clear")}
          </button>
        </div>
      )}
      <div className={`log-list ${fullPage ? "console-log-list" : ""}`}>
        {displayedLogs.length === 0 ? (
          <div className="empty">{query || levelFilter !== "all" ? t("console.noMatches") : t("console.empty")}</div>
        ) : displayedLogs.map((log, index) => (
          <div className="log-row" key={log.id ?? `${log.timestamp}-${index}`}>
            <span className="log-time">{log.time}</span>
            <i className={`log-dot ${log.level}`} />
            <span className="log-src">{log.source}</span>
            <span className={`log-text log-text-${log.level}`} title={log.text}>
              <SyntaxTerminalText text={log.text} />
            </span>
          </div>
        ))}
      </div>
    </>
  );

  if (embedded) return feed;

  return (
    <section className={`card ${fullPage ? "console-page-card" : ""}`}>
      <header className="card-head">
        <div className="card-title">
          <Terminal size={16} />
          <h2>{fullPage ? t("console.title") : t("console.liveTitle")}</h2>
        </div>
        {!fullPage && <span className="live-badge">{t("console.live")}</span>}
      </header>
      {fullPage && <p className="console-notice">{t("console.description")}</p>}
      {feed}
    </section>
  );
}
