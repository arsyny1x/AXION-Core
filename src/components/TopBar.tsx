import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Bell, Copy, Eraser, Github, Minus, Settings, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLanguage } from "../i18n/LanguageContext";
import {
  clearNotifications,
  getNotificationsSnapshot,
  markNotificationsRead,
  subscribeNotifications,
} from "../services/notificationService";

interface Props {
  title: string;
  description: string;
  notify: (m: string) => void;
  onOpenSettings: () => void;
  serverConnected: boolean;
}

const GITHUB_URL = "https://github.com/arsyny1x/AXION-Core";
const DISCORD_URL = "https://discord.com/invite/zSFhz9VfHu";

export default function TopBar({ title, description, notify, onOpenSettings, serverConnected }: Props) {
  const { t, language } = useLanguage();
  const [open, setOpen] = useState<"none" | "bell">("none");
  const [isMaximized, setIsMaximized] = useState(false);
  const notifications = useSyncExternalStore(
    subscribeNotifications,
    getNotificationsSnapshot,
    getNotificationsSnapshot,
  );
  const windowControlsEnabled = isTauri();
  const unreadCount = notifications.filter(notification => !notification.read).length;
  const close = () => setOpen("none");

  const handleOpenNotifications = () => {
    const nextState = open === "bell" ? "none" : "bell";
    if (nextState === "bell") markNotificationsRead();
    setOpen(nextState);
  };

  useEffect(() => {
    if (!windowControlsEnabled) return;
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let active = true;

    void appWindow.isMaximized().then(maximized => {
      if (active) setIsMaximized(maximized);
    }).catch(error => {
      notify(t("topBar.checkWindowFailed", { detail: error instanceof Error ? error.message : String(error) }));
    });
    void appWindow.onResized(() => {
      void appWindow.isMaximized().then(maximized => {
        if (active) setIsMaximized(maximized);
      }).catch(error => {
        notify(t("topBar.updateWindowFailed", { detail: error instanceof Error ? error.message : String(error) }));
      });
    }).then(dispose => {
      if (active) unlisten = dispose;
      else dispose();
    }).catch(error => {
      notify(t("topBar.watchWindowFailed", { detail: error instanceof Error ? error.message : String(error) }));
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [notify, t, windowControlsEnabled]);

  const controlWindow = async (action: "minimize" | "toggleMaximize" | "close") => {
    if (!windowControlsEnabled) {
      notify(t("topBar.desktopOnly"));
      return;
    }
    const appWindow = getCurrentWindow();
    try {
      if (action === "minimize") {
        await appWindow.minimize();
      }
      else if (action === "toggleMaximize") {
        await appWindow.toggleMaximize();
        setIsMaximized(await appWindow.isMaximized());
      } else await appWindow.close();
    } catch (error) {
      notify(t("topBar.controlWindowFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  };

  const startWindowDrag = (event: React.MouseEvent<HTMLElement>) => {
    if (!windowControlsEnabled) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".top-right, button, a, input, textarea, select")) return;
    void getCurrentWindow().startDragging().catch(error => {
      notify(t("topBar.dragWindowFailed", { detail: error instanceof Error ? error.message : String(error) }));
    });
  };

  return (
    <header className="topbar" data-tauri-drag-region onMouseDown={startWindowDrag}>
      {open === "bell" && createPortal(
        <div className="overlay" onClick={close} />,
        document.body,
      )}
      <span className="topbar-version" data-tauri-drag-region>
        <i
          className={`connection-indicator ${serverConnected ? "connected" : "disconnected"}`}
          role="status"
          aria-label={t(serverConnected ? "topBar.serverConnected" : "topBar.serverDisconnected")}
          title={t(serverConnected ? "topBar.serverConnected" : "topBar.serverDisconnected")}
        />
        <strong>AXION Core</strong>
        <i aria-hidden="true">·</i>
        <span>v0.1.0-beta</span>
      </span>
      <div className="page-heading" data-tauri-drag-region>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>

      <div className="top-right">
        <a
          className="server-status"
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          title={t("topBar.openGitHub")}
          onClick={event => {
            if (!isTauri()) return;
            event.preventDefault();
            void openUrl(GITHUB_URL).catch(error => {
              notify(t("topBar.openGitHubFailed", { detail: error instanceof Error ? error.message : String(error) }));
            });
          }}
        >
          <Github size={16} aria-hidden="true" />
        </a>
        <a
          className="server-status social-icon-link"
          href={DISCORD_URL}
          target="_blank"
          rel="noreferrer"
          title={t("topBar.openDiscord")}
          aria-label={t("topBar.openDiscord")}
          onClick={event => {
            if (!isTauri()) return;
            event.preventDefault();
            void openUrl(DISCORD_URL).catch(error => {
              notify(t("topBar.openDiscordFailed", { detail: error instanceof Error ? error.message : String(error) }));
            });
          }}
        >
          <DiscordIcon />
        </a>

        <button
          className="icon-btn"
          title={t("nav.settings")}
          aria-label={t("nav.settings")}
          onClick={() => {
            close();
            onOpenSettings();
          }}
        >
          <Settings size={17} />
        </button>

        <div className="pop-wrap">
          <button
            className="icon-btn"
            onClick={handleOpenNotifications}
            aria-label={unreadCount > 0
              ? t("topBar.unreadNotifications", { count: unreadCount })
              : t("topBar.notifications")}
          >
            <Bell size={18} />
            {unreadCount > 0 && <i className="dot-badge" aria-label={t("topBar.unreadNotifications", { count: unreadCount })} />}
          </button>
          {open === "bell" && (
            <div className="popover notification-popover">
              <div className="notification-popover-heading">
                <div className="pop-title">{t("topBar.notifications")}</div>
                <button
                  className="notification-clear"
                  onClick={clearNotifications}
                  disabled={notifications.length === 0}
                  title={t("topBar.clearNotifications")}
                >
                  <Eraser size={13} /> {t("topBar.clear")}
                </button>
              </div>
              {notifications.length === 0 ? (
                <div className="notification-empty">{t("topBar.noNotifications")}</div>
              ) : notifications.map(notification => {
                return (
                  <button key={notification.id} className={`pop-item ${notification.read ? "" : "unread"}`} onClick={() => {
                    close();
                  }}>
                    <span>{notification.message}</span>
                    <small>{new Date(notification.createdAt).toLocaleString(language)}</small>
                    {!notification.read && <i className="notification-unread-indicator" aria-label={t("topBar.unreadNotifications", { count: 1 })} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="window-controls">
          <button
            type="button"
            className="window-control"
            aria-label={t("window.minimize")}
            title={t("window.minimize")}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              void controlWindow("minimize");
            }}
          >
            <Minus size={15} />
          </button>
          <button
            className="window-control"
            aria-label={t(isMaximized ? "window.restore" : "window.maximize")}
            title={t(isMaximized ? "window.restore" : "window.maximize")}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation();
              void controlWindow("toggleMaximize");
            }}
          >
            {isMaximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            className="window-control close"
            aria-label={t("window.close")}
            title={t("window.close")}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation();
              void controlWindow("close");
            }}
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}

function DiscordIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.54 5.34a18.8 18.8 0 0 0-4.63-1.43.07.07 0 0 0-.07.03c-.2.36-.43.83-.59 1.2a17.4 17.4 0 0 0-5.2 0c-.16-.38-.4-.84-.6-1.2a.07.07 0 0 0-.07-.03 18.75 18.75 0 0 0-4.63 1.43.06.06 0 0 0-.03.03C.96 9.67.16 13.86.56 18a.08.08 0 0 0 .03.05 18.9 18.9 0 0 0 5.67 2.87.07.07 0 0 0 .08-.03c.44-.6.83-1.24 1.16-1.91a.07.07 0 0 0-.04-.1 12.4 12.4 0 0 1-1.77-.84.07.07 0 0 1-.01-.11c.12-.09.24-.19.36-.29a.07.07 0 0 1 .07-.01c3.72 1.7 7.75 1.7 11.43 0a.07.07 0 0 1 .07.01c.12.1.24.2.36.29a.07.07 0 0 1-.01.11c-.56.33-1.15.61-1.77.84a.07.07 0 0 0-.04.1c.34.67.72 1.31 1.16 1.91a.07.07 0 0 0 .08.03 18.85 18.85 0 0 0 5.68-2.87.07.07 0 0 0 .03-.05c.48-4.79-.8-8.94-3.42-12.63a.06.06 0 0 0-.03-.03ZM8.02 15.32c-1.12 0-2.05-1.03-2.05-2.3 0-1.26.9-2.3 2.05-2.3 1.16 0 2.07 1.05 2.05 2.3 0 1.27-.9 2.3-2.05 2.3Zm7.96 0c-1.12 0-2.05-1.03-2.05-2.3 0-1.26.9-2.3 2.05-2.3 1.16 0 2.07 1.05 2.05 2.3 0 1.27-.89 2.3-2.05 2.3Z" />
    </svg>
  );
}
