import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ListTodo, MoreVertical, Clock, Play, CheckCircle2, Users, Plus, Monitor } from "lucide-react";
import type { Task } from "../data/mock";
import { useLanguage } from "../i18n/LanguageContext";

interface Props {
  tasks: Task[];
  onUpdate: (id: number, patch: Partial<Task>) => void;
  onDelete: (id: number) => void;
  notify: (m: string) => void;
  onAddMockup?: () => void;
  hasMockupTasks?: boolean;
}

export default function TaskBoard({ tasks, onUpdate, onDelete, notify, onAddMockup, hasMockupTasks = false }: Props) {
  const { t } = useLanguage();
  const [menu, setMenu] = useState<{ taskId: number; trigger: HTMLButtonElement; top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !menuRef.current?.contains(target) &&
        !menu.trigger.contains(target)
      ) {
        setMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const closeMenu = () => setMenu(null);

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [menu]);

  const toggleMenu = (taskId: number, trigger: HTMLButtonElement) => {
    if (menu?.taskId === taskId) {
      setMenu(null);
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const menuHeight = 144;
    const top = window.innerHeight - rect.bottom >= menuHeight + 8
      ? rect.bottom + 8
      : Math.max(8, rect.top - menuHeight - 8);
    setMenu({
      taskId,
      trigger,
      top,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  };

  const activeTask = menu ? tasks.find(task => task.id === menu.taskId) : undefined;

  return (
    <section className="card board">
      <header className="card-head">
        <div className="card-title">
          <ListTodo size={17} />
          <h2>{t("task.list")}</h2>
        </div>
        {onAddMockup && (
          <button className="btn-ghost task-mockup-add" onClick={onAddMockup} disabled={hasMockupTasks}>
            <Plus size={14} /> {t("task.addMockup")}
          </button>
        )}
      </header>

      <div className="task-list">
        {tasks.length === 0 && <div className="empty">{t("task.empty")}</div>}
        {tasks.map(task => {
          const Icon = task.icon;
          const pct = task.total === 0 ? 0 : Math.round((task.progress / task.total) * 100);
          const taskTitle = task.mockupType
            ? t(`task.mockup${task.mockupType[0].toUpperCase()}${task.mockupType.slice(1)}Title`)
            : task.title;
          const taskDescription = task.mockupType
            ? t(`task.mockup${task.mockupType[0].toUpperCase()}${task.mockupType.slice(1)}Description`)
            : task.desc;
          return (
            <article key={task.id} className="task-row">
              <div className={`task-ic c-${task.color}`}>
                <Icon size={20} />
              </div>
              <div className="task-body">
                <div className="task-top">
                  <h3>{taskTitle}</h3>
                  {task.people ? (
                    <span className="chip neutral">
                      <Users size={12} /> {t("task.people", { count: task.people })}
                    </span>
                  ) : null}
                  <span className="chip tag">{task.tag}</span>
                  {task.isMockup && <span className="chip mockup">{t("task.mockup")}</span>}
                </div>
                <p>{taskDescription}</p>
                {task.status === "running" && (
                  <div className="task-agents">
                    <span>{t("task.agentWorking")}</span>
                    {task.agentIds?.length ? task.agentIds.map(agentId => (
                      <code key={agentId}>{agentId}</code>
                    )) : <span className="task-agents-empty">{t("task.agentIdsMissing")}</span>}
                  </div>
                )}
                <div className="task-meta">
                  <Clock size={12} />
                  <span>{t("task.createdAt", { date: task.created })}</span>
                  <span className="sep">•</span>
                  <span>{t("task.updatedAt", { date: task.updated })}</span>
                </div>
              </div>
              <div className="task-side">
                <span className={`pill ${task.status}`}>
                  {task.status === "running" && <Play size={11} />}
                  {task.status === "pending" && <Clock size={11} />}
                  {task.status === "done" && <CheckCircle2 size={11} />}
                  {t(`task.${task.status}`)}
                </span>
                <div className="task-progress">
                  <small>
                    {t("task.progressCount", { progress: task.progress, total: task.total })}
                    <Monitor size={12} role="img" aria-label={t("task.progress", { progress: task.progress, total: task.total })} />
                  </small>
                  <div className="bar">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <div className="menu-wrap">
                  <button
                    className="icon-btn ghost"
                    aria-label={t("task.taskMenu", { title: taskTitle })}
                    aria-expanded={menu?.taskId === task.id}
                    onClick={event => toggleMenu(task.id, event.currentTarget)}
                  >
                    <MoreVertical size={16} />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {menu && activeTask && createPortal(
        <div
          ref={menuRef}
          className="popover menu task-menu-portal"
          style={{ top: menu.top, right: menu.right }}
        >
          {activeTask.status !== "running" && (
            <button
              className="pop-item"
              onClick={() => {
                onUpdate(activeTask.id, { status: "running" });
                setMenu(null);
                notify(t("task.startedTask", { title: activeTask.mockupType
                  ? t(`task.mockup${activeTask.mockupType[0].toUpperCase()}${activeTask.mockupType.slice(1)}Title`)
                  : activeTask.title }));
              }}
            >
              <span>{t("task.startTask")}</span>
            </button>
          )}
          {activeTask.status !== "done" && (
            <button
              className="pop-item"
              onClick={() => {
                onUpdate(activeTask.id, { status: "done", progress: activeTask.total });
                setMenu(null);
                notify(t("task.completedTask", { title: activeTask.mockupType
                  ? t(`task.mockup${activeTask.mockupType[0].toUpperCase()}${activeTask.mockupType.slice(1)}Title`)
                  : activeTask.title }));
              }}
            >
              <span>{t("task.markComplete")}</span>
            </button>
          )}
          <button
            className="pop-item danger"
            onClick={() => {
              onDelete(activeTask.id);
              setMenu(null);
              notify(t("task.deletedTask", { title: activeTask.mockupType
                ? t(`task.mockup${activeTask.mockupType[0].toUpperCase()}${activeTask.mockupType.slice(1)}Title`)
                : activeTask.title }));
            }}
          >
            <span>{t("task.deleteTask")}</span>
          </button>
        </div>,
        document.body
      )}
    </section>
  );
}
