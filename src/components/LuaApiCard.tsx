import { Code2 } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";
import { SyntaxCodeBlock } from "./SyntaxCode";

const LUA_API_CODE = `AXION:ReportWorkspace({
  world = "Sea 1",
  profile = { level = 100, beli = 5000 },
  inventory = {
    materials = {
      ["Scrap Metal"] = { quantity = 12 }
    }
  }
})`;

export default function LuaApiCard({ notify }: { notify: (m: string) => void }) {
  const { t } = useLanguage();
  return (
    <section className="card code-card">
      <header className="card-head">
        <div className="card-title">
          <Code2 size={16} />
          <h2>{t("luaApi.title")}</h2>
        </div>
        <button className="link" onClick={() => notify(t("luaApi.docsNotice"))}>
          {t("luaApi.openDocs")}
        </button>
      </header>
      <SyntaxCodeBlock code={LUA_API_CODE} className="code" language="lua" />
    </section>
  );
}
