import { useState, type FormEvent } from "react";
import { X, FileCode2 } from "lucide-react";
import type { Task } from "../data/mock";
import { useLanguage } from "../i18n/LanguageContext";

interface Props {
  onClose: () => void;
  onSubmit: (t: Omit<Task, "id" | "status" | "progress" | "created" | "updated">) => void;
}

const TAGS = ["Blox Fruits", "Raid", "Test", "Script", "Team"];
const COLOR_BY_TAG: Record<string, Task["color"]> = {
  "Blox Fruits": "blue",
  Raid: "violet",
  Test: "green",
  Script: "amber",
  Team: "pink",
};

export default function CreateTaskModal({ onClose, onSubmit }: Props) {
  const { t } = useLanguage();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [tag, setTag] = useState(TAGS[0]);
  const [total, setTotal] = useState(3);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      desc: desc.trim() || "—",
      tag,
      icon: FileCode2,
      color: COLOR_BY_TAG[tag],
      total,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <header>
          <h3>{t("createTask.title")}</h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <label>
          {t("createTask.taskName")}
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t("createTask.taskNamePlaceholder")} autoFocus />
        </label>

        <label>
          {t("createTask.description")}
          <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder={t("createTask.descriptionPlaceholder")} rows={3} />
        </label>

        <div className="form-row">
          <label>
            {t("createTask.tag")}
            <select value={tag} onChange={e => setTag(e.target.value)}>
              {TAGS.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            {t("createTask.agentCount")}
            <input
              type="number"
              min={1}
              max={10}
              value={total}
              onChange={e => setTotal(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            />
          </label>
        </div>

        <footer>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t("createTask.cancel")}
          </button>
          <button className="btn-primary" type="submit">
            {t("createTask.create")}
          </button>
        </footer>
      </form>
    </div>
  );
}
