import fs from "node:fs";
import path from "node:path";

import { resolveDefaultStorageDir, type WeixinUserIdMappingConfig } from "../config.js";
import type { WeixinAccountState } from "../types/ilink.js";

export interface UserIdMappings {
  prefix: string;
  nextId: number;
  actualToSimple: Record<string, string>;
  simpleToActual: Record<string, string>;
}

export const DEFAULT_USER_ID_PREFIX = "wx_user_";
export const DEFAULT_USER_ID_START = 114514;

function normalizeMappingConfig(config: WeixinUserIdMappingConfig = {}): Required<Omit<WeixinUserIdMappingConfig, "aliases">> & { aliases: Record<string, string> } {
  const prefix = config.prefix?.trim() || DEFAULT_USER_ID_PREFIX;
  const start = Number.isSafeInteger(config.start) && (config.start ?? -1) >= 0
    ? config.start!
    : DEFAULT_USER_ID_START;
  return { prefix, start, aliases: config.aliases ?? {} };
}

export class FileStore {
  readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir || resolveDefaultStorageDir();
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  private ensureDir(subdir: string): string {
    const dir = path.join(this.rootDir, subdir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private readJson<T>(filePath: string, fallback: T): T {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  }

  accountFile(): string {
    return path.join(this.ensureDir("accounts"), "default.json");
  }

  syncBufFile(): string {
    return path.join(this.ensureDir("runtime"), "sync-buf.json");
  }

  contextTokensFile(): string {
    return path.join(this.ensureDir("runtime"), "context-tokens.json");
  }

  userIdMappingsFile(): string {
    return path.join(this.ensureDir("runtime"), "user-id-mappings.json");
  }

  mediaDir(kind = "inbound"): string {
    return this.ensureDir(path.join("media", kind));
  }

  loadAccount(): WeixinAccountState | null {
    return this.readJson<WeixinAccountState | null>(this.accountFile(), null);
  }

  saveAccount(account: WeixinAccountState): void {
    this.writeJson(this.accountFile(), account);
  }

  loadSyncBuf(): string {
    const data = this.readJson<{ get_updates_buf?: string }>(this.syncBufFile(), {});
    return data.get_updates_buf ?? "";
  }

  saveSyncBuf(getUpdatesBuf: string): void {
    this.writeJson(this.syncBufFile(), { get_updates_buf: getUpdatesBuf });
  }

  clearSyncBuf(): void {
    this.saveSyncBuf("");
  }

  loadContextTokens(): Record<string, string> {
    return this.readJson<Record<string, string>>(this.contextTokensFile(), {});
  }

  saveContextTokens(tokens: Record<string, string>): void {
    this.writeJson(this.contextTokensFile(), tokens);
  }

  loadUserIdMappings(config: WeixinUserIdMappingConfig = {}): UserIdMappings {
    const normalizedConfig = normalizeMappingConfig(config);
    const stored = this.readJson<UserIdMappings>(this.userIdMappingsFile(), {
      prefix: normalizedConfig.prefix,
      nextId: normalizedConfig.start,
      actualToSimple: {},
      simpleToActual: {},
    });
    const storedPrefix = typeof stored.prefix === "string" && stored.prefix
      ? stored.prefix
      : DEFAULT_USER_ID_PREFIX;
    const normalized: UserIdMappings = {
      prefix: normalizedConfig.prefix,
      nextId: storedPrefix === normalizedConfig.prefix && Number.isSafeInteger(stored.nextId)
        ? Math.max(stored.nextId, normalizedConfig.start)
        : normalizedConfig.start,
      actualToSimple: {},
      simpleToActual: {},
    };

    const assign = (simpleId: string, actualId: string): void => {
      if (!simpleId || !actualId) return;
      const previousActual = normalized.simpleToActual[simpleId];
      if (previousActual) delete normalized.actualToSimple[previousActual];
      const previousSimple = normalized.actualToSimple[actualId];
      if (previousSimple) delete normalized.simpleToActual[previousSimple];
      normalized.actualToSimple[actualId] = simpleId;
      normalized.simpleToActual[simpleId] = actualId;
    };

    for (const [actualId, simpleId] of Object.entries(stored.actualToSimple ?? {})) {
      if (typeof actualId === "string" && typeof simpleId === "string") assign(simpleId, actualId);
    }
    for (const [simpleId, actualId] of Object.entries(stored.simpleToActual ?? {})) {
      if (typeof simpleId === "string" && typeof actualId === "string" && !normalized.simpleToActual[simpleId]) {
        assign(simpleId, actualId);
      }
    }
    for (const [simpleId, actualId] of Object.entries(normalizedConfig.aliases)) {
      if (typeof simpleId === "string" && typeof actualId === "string") assign(simpleId.trim(), actualId.trim());
    }

    const escapedPrefix = normalizedConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const generatedIdPattern = new RegExp(`^${escapedPrefix}(\\d+)$`);
    for (const simpleId of Object.keys(normalized.simpleToActual)) {
      const match = generatedIdPattern.exec(simpleId);
      if (match) normalized.nextId = Math.max(normalized.nextId, Number(match[1]) + 1);
    }

    const changed = JSON.stringify(normalized) !== JSON.stringify(stored);

    if (changed) {
      this.saveUserIdMappings(normalized);
    }

    return normalized;
  }

  saveUserIdMappings(mappings: UserIdMappings): void {
    this.writeJson(this.userIdMappingsFile(), mappings);
  }
}
