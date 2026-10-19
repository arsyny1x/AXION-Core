import { Search } from "lucide-react";
import type { TaskStatus } from "../data/mock";
import { useLanguage } from "../i18n/LanguageContext";
import type { LanguageMessageKey } from "../i18n/languages";

type Filter = "all" | TaskStatus;

const FILTERS: { id: Filter; label: LanguageMessageKey }[] = [
  { id: "all", label: "task.all" },
  { id: "pending", label: "task.pending" },
  { id: "running", label: "task.running" },
  { id: "done", label: "task.done" },
];

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
  filter: Filter;
  onFilterChange: (filter: Filter) => void;
  counts: Record<Filter, number>;
  layout?: "row" | "stacked";
}

export default function TaskControls({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  counts,
  layout = "row",
}: Props) {
  const { t } = useLanguage();
  return (
    <section className={`card task-control-boxes ${layout === "stacked" ? "stacked" : ""}`}>
      <label className="task-control-search">
        <Search size={15} />
        <input
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder={t("task.search")}
        />
      </label>
      <div className="task-control-filters">
        {FILTERS.map(item => (
          <button
            key={item.id}
            className={`tab ${filter === item.id ? "active" : ""}`}
            onClick={() => onFilterChange(item.id)}
          >
            {t(item.label)} <em>{counts[item.id]}</em>
          </button>
        ))}
      </div>
    </section>
  );
}
