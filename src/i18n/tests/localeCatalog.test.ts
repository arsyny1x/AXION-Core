import { describe, expect, it } from "vitest";
import english from "../../../config/locales/en-US.json";
import thai from "../../../config/locales/th-TH.json";
import vietnamese from "../../../config/locales/vi-VN.json";
import { getLanguageLabel } from "../LanguageContext";
import { getLocaleMessage, validateAndMergeLocale, type LocaleCatalog } from "../localeCatalog";

const fallback: LocaleCatalog = {
  common: { save: "Save", cancel: "Cancel" },
  greeting: "Hello, {name}",
};

describe("locale catalog validation", () => {
  it("fills missing translations from English and interpolates parameters", () => {
    const result = validateAndMergeLocale(
      JSON.stringify({ common: { save: "บันทึก" }, greeting: "สวัสดี {name}" }),
      fallback,
    );

    expect(result.missingKeys).toBe(1);
    expect(result.missingKeyPaths).toEqual(["common.cancel"]);
    expect(getLocaleMessage(result.catalog, "common.cancel")).toBe("Cancel");
    expect(getLocaleMessage(result.catalog, "greeting", { name: "AXION" })).toBe("สวัสดี AXION");
  });

  it("falls back when a translated placeholder changes", () => {
    const result = validateAndMergeLocale(
      JSON.stringify({ common: { save: "บันทึก", cancel: "ยกเลิก" }, greeting: "สวัสดี {player}" }),
      fallback,
    );

    expect(result.placeholderMismatches).toBe(1);
    expect(result.placeholderMismatchPaths).toEqual(["greeting"]);
    expect(getLocaleMessage(result.catalog, "greeting", { name: "AXION" })).toBe("Hello, AXION");
  });

  it("rejects duplicate keys and malformed JSON", () => {
    expect(() => validateAndMergeLocale('{"common":{"save":"Save","save":"Save again"}}', fallback))
      .toThrow("Duplicate JSON key");
    expect(() => validateAndMergeLocale("{invalid", fallback)).toThrow();
  });

  it("falls back when the locale has invalid value types", () => {
    const result = validateAndMergeLocale(
      JSON.stringify({ common: { save: 5 }, greeting: "Hello, {name}" }),
      fallback,
    );

    expect(result.invalidValues).toBe(1);
    expect(result.invalidValuePaths).toEqual(["common.save"]);
    expect(getLocaleMessage(result.catalog, "common.save")).toBe("Save");
  });

  it("reports nested missing and unexpected key paths", () => {
    const result = validateAndMergeLocale(
      JSON.stringify({ common: { save: "Save", extra: "Unexpected" } }),
      fallback,
    );

    expect(result.missingKeyPaths).toEqual(["common.cancel", "greeting"]);
    expect(result.invalidValuePaths).toEqual(["common.extra"]);
  });

  it("keeps the shipped Thai locale aligned with the English key schema", () => {
    const result = validateAndMergeLocale(JSON.stringify(thai), english as LocaleCatalog);
    expect(result.missingKeys).toBe(0);
    expect(result.invalidValues).toBe(0);
    expect(result.placeholderMismatches).toBe(0);
  });

  it("keeps the shipped Vietnamese locale aligned with the English key schema", () => {
    const result = validateAndMergeLocale(JSON.stringify(vietnamese), english as LocaleCatalog);
    expect(result.missingKeys).toBe(0);
    expect(result.invalidValues).toBe(0);
    expect(result.placeholderMismatches).toBe(0);
  });

  it("keeps the Game Scope save error placeholder consistent across built-in locales", () => {
    const catalogs = [english, thai, vietnamese] as LocaleCatalog[];
    for (const catalog of catalogs) {
      const result = validateAndMergeLocale(JSON.stringify(catalog), english as LocaleCatalog);
      expect(result.placeholderMismatchPaths).not.toContain("serverScript.scopeSaveFailed");
    }
  });

  it("discovers native language labels for custom locale codes", () => {
    expect(getLanguageLabel("ja")).not.toBe("ja");
    expect(getLanguageLabel("pt-BR")).not.toBe("pt-BR");
    expect(getLanguageLabel("en-US")).toBe("English");
    expect(getLanguageLabel("th-TH")).toBe("ไทย");
    expect(getLanguageLabel("vi-VN")).toBe("Tiếng Việt");
  });

  it("includes every Console filter translation in all shipped locales", () => {
    const consoleKeys = [
      "console.noMatches",
      "console.search",
      "console.level",
      "console.allLevels",
      "console.info",
      "console.warnings",
    ];
    const catalogs = [english, thai, vietnamese] as LocaleCatalog[];

    for (const catalog of catalogs) {
      for (const key of consoleKeys) {
        expect(getLocaleMessage(catalog, key)).not.toBe(key);
      }
    }
  });

  it("provides Database navigation and page translations in all shipped locales", () => {
    const databaseKeys = [
      "nav.database",
      "page.database.title",
      "page.database.description",
    ];
    const catalogs = [english, thai, vietnamese] as LocaleCatalog[];

    for (const catalog of catalogs) {
      for (const key of databaseKeys) {
        expect(getLocaleMessage(catalog, key)).not.toBe(key);
      }
    }
  });

  it("provides every settings description in each shipped language", () => {
    const keys = [
      "settings.autoDescription",
      "settings.notificationsDescription",
      "settings.themeDescription",
      "settings.languageDescription",
    ];
    const catalogs = [english, thai, vietnamese] as LocaleCatalog[];

    for (const catalog of catalogs) {
      for (const key of keys) {
        expect(getLocaleMessage(catalog, key)).not.toBe(key);
      }
    }
  });
});
