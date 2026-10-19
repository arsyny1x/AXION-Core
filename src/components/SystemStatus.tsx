import { Activity, Monitor, MonitorX, Play } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";

interface Props {
  online: number;
  offline: number;
  running: number;
  queued: number;
}

export default function SystemStatus({ online, offline, running, queued }: Props) {
  const { t } = useLanguage();
  return (
    <section className="card">
      <header className="card-head">
        <div className="card-title">
          <Activity size={16} />
          <h2>{t("system.status")}</h2>
        </div>
        <span className="pill ok-mini"><i className="pulse-dot" /> {t("system.normal")}</span>
      </header>
      <div className="stat-grid">
        <div className="stat-box">
          <Monitor size={18} className="s-green" />
          <b className="s-green">{online}</b>
          <span>{t("system.agentOnline")}</span>
        </div>
        <div className="stat-box">
          <MonitorX size={18} className="s-red" />
          <b className="s-red">{offline}</b>
          <span>{t("system.agentOffline")}</span>
        </div>
        <div className="stat-box">
          <Play size={18} className="s-violet" />
          <b className="s-violet">{running}</b>
          <span>{t("system.running")}</span>
          <div className="stat-inline">
            <b>{queued}</b>
            <span>{t("system.queue")}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
