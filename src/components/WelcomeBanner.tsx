import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useLanguage } from "../i18n/LanguageContext";

export default function WelcomeBanner() {
  const { t } = useLanguage();
  const [now, setNow] = useState(() => new Date());
  const [computerName, setComputerName] = useState<string | null>(
    () => isTauri() ? null : __COMPUTER_NAME__ || null,
  );

  useEffect(() => {
    if (!isTauri()) return;

    let active = true;
    invoke<string>("get_computer_name")
      .then(name => {
        if (active) setComputerName(name);
      })
      .catch(error => {
        console.error("Unable to load the computer name for the welcome message", error);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setNow(new Date()),
      60_000 - (Date.now() % 60_000),
    );
    return () => window.clearTimeout(timeout);
  }, [now]);

  const hour = now.getHours();
  const greetingKey = hour >= 5 && hour < 12
    ? "welcome.greeting.morning"
    : hour >= 12 && hour < 16
      ? "welcome.greeting.afternoon"
      : hour >= 16 && hour < 19
        ? "welcome.greeting.evening"
        : "welcome.greeting.night";
  return (
    <section className="banner">
      <div className="banner-glow g1" />
      <div className="banner-glow g2" />
      <div className="banner-content">
        <h1>{t(greetingKey).replace("{name}", computerName ?? t("welcome.fallbackName"))}</h1>
        <p>{t("welcome.description")}</p>
      </div>
    </section>
  );
}
