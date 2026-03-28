import fs from "node:fs";
import path from "node:path";

import { resolveDefaultStorageDir } from "../config.js";
import type { WeixinAccountState } from "../types/ilink.js";

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

  loadContextTokens(): Record<string, string> {
    return this.readJson<Record<string, string>>(this.contextTokensFile(), {});
  }

  saveContextTokens(tokens: Record<string, string>): void {
    this.writeJson(this.contextTokensFile(), tokens);
  }
}
