import { useEffect, useState } from "react";
import { CheckCircle2, Clock3, Database, FileCode, Home, ListTodo, Monitor, MonitorX, Play, Settings, Users, BookOpen, Terminal } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";
import type { LanguageMessageKey } from "../i18n/languages";

interface Props {
  page: string;
  onNavigate: (p: string) => void;
  counts: { tasks: number; scripts: number; players: number };
  status: { online: number; offline: number; running: number; pending: number; done: number };
  uptimeStartedAt: number;
}

const NAV: { id: string; label: LanguageMessageKey; icon: typeof Home; key?: keyof Props["counts"] }[] = [
  { id: "home", label: "nav.home", icon: Home },
  { id: "tasks", label: "nav.tasks", icon: ListTodo, key: "tasks" },
  { id: "players", label: "nav.players", icon: Users, key: "players" },
  { id: "database", label: "nav.database", icon: Database },
  { id: "scripts", label: "nav.scripts", icon: FileCode, key: "scripts" },
  { id: "api-docs", label: "nav.docs", icon: BookOpen },
  { id: "console", label: "nav.console", icon: Terminal },
  { id: "settings", label: "nav.settings", icon: Settings },
];

export default function Sidebar({ page, onNavigate, counts, status, uptimeStartedAt }: Props) {
  const { t } = useLanguage();
  const [uptimeSeconds, setUptimeSeconds] = useState(() => Math.floor((Date.now() - uptimeStartedAt) / 1000));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setUptimeSeconds(Math.floor((Date.now() - uptimeStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [uptimeStartedAt]);

  const runtime = [
    Math.floor(uptimeSeconds / 3600) > 0 ? `${Math.floor(uptimeSeconds / 3600)}h` : null,
    Math.floor((uptimeSeconds % 3600) / 60) > 0 ? `${Math.floor((uptimeSeconds % 3600) / 60)}m` : null,
    `${uptimeSeconds % 60}s`,
  ].filter(Boolean).join(" ");

  return (
    <aside className="sidebar">
      <div className="sidebar-main">
        <div className="brand">
          <div className="brand-logo"><img src="/axion-app-icon.png" alt="" /></div>
          <div>
            <div className="brand-name">AXION Core</div>
            <div className="brand-sub">Lua SDK Central Management</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map(item => (
            <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => onNavigate(item.id)}>
              <item.icon size={17} />
              <span>{t(item.label)}</span>
              {item.key ? <em className="count">{counts[item.key]}</em> : null}
            </button>
          ))}
        </nav>
      </div>

      <section className="sidebar-dashboard">
        <div className="sidebar-dashboard-grid">
          <div className="sidebar-dashboard-stat online" aria-label={`${t("sidebar.online")}: ${status.online}`}><Monitor size={12} /><span>{t("sidebar.online")}</span><b>{status.online}</b></div>
          <div className="sidebar-dashboard-stat offline" aria-label={`${t("sidebar.offline")}: ${status.offline}`}><MonitorX size={12} /><span>{t("sidebar.offline")}</span><b>{status.offline}</b></div>
          <div className="sidebar-dashboard-stat running" aria-label={`${t("sidebar.running")}: ${status.running}`}><Play size={12} /><span>{t("sidebar.running")}</span><b>{status.running}</b></div>
          <div className="sidebar-dashboard-stat pending" aria-label={`${t("sidebar.queued")}: ${status.pending}`}><Clock3 size={12} /><span>{t("sidebar.queued")}</span><b>{status.pending}</b></div>
          <div className="sidebar-dashboard-stat done" aria-label={`${t("sidebar.done")}: ${status.done}`}><CheckCircle2 size={12} /><span>{t("sidebar.done")}</span><b>{status.done}</b></div>
        </div>
        <div className="sidebar-uptime" aria-label={t("sidebar.uptime", { duration: runtime })}>
          <Clock3 size={11} />
          <span>{t("sidebar.uptime", { duration: runtime })}</span>
        </div>
      </section>

    </aside>
  );
}
