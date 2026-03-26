import { config } from "../../package.json";

const MINERU_ENABLED_KEY = `${config.prefsPrefix}.mineruEnabled`;
const MINERU_API_KEY_KEY = `${config.prefsPrefix}.mineruApiKey`;

export function isMineruEnabled(): boolean {
  const value = Zotero.Prefs.get(MINERU_ENABLED_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function getMineruApiKey(): string {
  const value = Zotero.Prefs.get(MINERU_API_KEY_KEY, true);
  return typeof value === "string" ? value : "";
}

export function setMineruEnabled(value: boolean): void {
  Zotero.Prefs.set(MINERU_ENABLED_KEY, value, true);
}

export function setMineruApiKey(value: string): void {
  Zotero.Prefs.set(MINERU_API_KEY_KEY, value, true);
}
