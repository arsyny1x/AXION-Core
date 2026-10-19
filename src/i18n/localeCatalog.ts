export type LocaleCatalog = { [key: string]: string | LocaleCatalog };
export type TranslationParams = Record<string, string | number>;

function isCatalog(value: unknown): value is LocaleCatalog {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipWhitespace(source: string, index: number): number {
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function scanJsonValue(source: string, start: number): number {
  let index = skipWhitespace(source, start);
  if (source[index] === '"') {
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index++] === '"') break;
    }
    return index;
  }
  if (source[index] === "{") {
    index += 1;
    const keys = new Set<string>();
    index = skipWhitespace(source, index);
    while (source[index] !== "}") {
      const keyStart = index;
      index = scanJsonValue(source, index);
      const key = JSON.parse(source.slice(keyStart, index)) as string;
      if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
      keys.add(key);
      index = skipWhitespace(source, index);
      index = scanJsonValue(source, index + 1);
      index = skipWhitespace(source, index);
      if (source[index] === ",") index = skipWhitespace(source, index + 1);
      else break;
    }
    return index + 1;
  }
  if (source[index] === "[") {
    index = skipWhitespace(source, index + 1);
    while (source[index] !== "]") {
      index = scanJsonValue(source, index);
      index = skipWhitespace(source, index);
      if (source[index] === ",") index = skipWhitespace(source, index + 1);
      else break;
    }
    return index + 1;
  }
  while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
  return index;
}

export function assertNoDuplicateKeys(source: string): void {
  scanJsonValue(source, 0);
}

function cloneCatalog(source: LocaleCatalog): LocaleCatalog {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      typeof value === "string" ? value : cloneCatalog(value),
    ]),
  );
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();
}

export interface LocaleValidationResult {
  catalog: LocaleCatalog;
  missingKeys: number;
  missingKeyPaths: string[];
  invalidValues: number;
  invalidValuePaths: string[];
  placeholderMismatches: number;
  placeholderMismatchPaths: string[];
}

export function validateAndMergeLocale(source: string, fallback: LocaleCatalog): LocaleValidationResult {
  assertNoDuplicateKeys(source);
  const parsed: unknown = JSON.parse(source);
  if (!isCatalog(parsed)) throw new Error("Locale root must be a JSON object");

  const missingKeyPaths: string[] = [];
  const invalidValuePaths: string[] = [];
  const placeholderMismatchPaths: string[] = [];

  const merge = (base: LocaleCatalog, candidate: unknown, prefix = ""): LocaleCatalog => {
    const translated = isCatalog(candidate) ? candidate : {};
    const result: LocaleCatalog = {};
    invalidValuePaths.push(
      ...Object.keys(translated)
        .filter(key => !Object.prototype.hasOwnProperty.call(base, key))
        .map(key => prefix ? `${prefix}.${key}` : key),
    );
    for (const [key, fallbackValue] of Object.entries(base)) {
      const value = translated[key];
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof fallbackValue === "string") {
        if (typeof value !== "string") {
          if (value === undefined) missingKeyPaths.push(path);
          else invalidValuePaths.push(path);
          result[key] = fallbackValue;
        } else if (JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(fallbackValue))) {
          placeholderMismatchPaths.push(path);
          result[key] = fallbackValue;
        } else {
          result[key] = value;
        }
      } else if (value === undefined) {
        missingKeyPaths.push(...listStringPaths(fallbackValue, path));
        result[key] = cloneCatalog(fallbackValue);
      } else if (!isCatalog(value)) {
        invalidValuePaths.push(path);
        result[key] = cloneCatalog(fallbackValue);
      } else {
        result[key] = merge(fallbackValue, value, path);
      }
    }
    return result;
  };

  return {
    catalog: merge(fallback, parsed),
    missingKeys: missingKeyPaths.length,
    missingKeyPaths,
    invalidValues: invalidValuePaths.length,
    invalidValuePaths,
    placeholderMismatches: placeholderMismatchPaths.length,
    placeholderMismatchPaths,
  };
}

function listStringPaths(catalog: LocaleCatalog, prefix: string): string[] {
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = `${prefix}.${key}`;
    return typeof value === "string" ? [path] : listStringPaths(value, path);
  });
}

export function getLocaleMessage(
  catalog: LocaleCatalog,
  key: string,
  params?: TranslationParams,
): string {
  let value: string | LocaleCatalog | undefined = catalog;
  for (const part of key.split(".")) {
    value = typeof value === "string" ? undefined : value?.[part];
  }
  if (typeof value !== "string") return key;
  if (!params) return value;
  return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
