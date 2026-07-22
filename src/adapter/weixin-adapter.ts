import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, type WeixinAdapterConfig } from "../config.js";
import { IlinkClient, type VerifyCodeProvider } from "../ilink/client.js";
import { DEFAULT_USER_ID_PREFIX, FileStore, type UserIdMappings } from "../storage/file-store.js";
import type { MessageItem, WeixinAccountState, WeixinMessage } from "../types/ilink.js";
import { MessageItemType } from "../types/ilink.js";
import type {
  OneBotEvent,
  OneBotGetStatusData,
  OneBotLoginInfoData,
  OneBotMessage,
  OneBotMessageSegment,
} from "../types/onebot.js";
import { Logger } from "../util/logger.js";

function encodeFileUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

function detectImageExtension(buffer: Buffer): string {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ".jpg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return ".gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buffer.subarray(0, 2).toString("ascii") === "BM") return ".bmp";
  return ".bin";
}

function escapeCq(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;").replace(/,/g, "&#44;");
}

function unescapeCq(value: string): string {
  return value.replace(/&#44;/g, ",").replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&amp;/g, "&");
}

function parseCqString(message: string): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];
  const pattern = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(message)) != null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", data: { text: unescapeCq(message.slice(lastIndex, match.index)) } });
    }
    const type = match[1];
    const attrs = (match[2] || "").replace(/^,/, "");
    const data = Object.fromEntries(
      attrs
        ? attrs.split(",").map((entry) => {
          const [key, ...rest] = entry.split("=");
          return [key, unescapeCq(rest.join("="))];
        })
        : [],
    );
    segments.push({ type, data });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < message.length) {
    segments.push({ type: "text", data: { text: unescapeCq(message.slice(lastIndex)) } });
  }
  return segments.length > 0 ? segments : [{ type: "text", data: { text: "" } }];
}

export function segmentsToCqString(segments: OneBotMessageSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") return segment.data.text || "";
    const body = Object.entries(segment.data).map(([k, v]) => `${k}=${escapeCq(String(v))}`).join(",");
    return `[CQ:${segment.type}${body ? `,${body}` : ""}]`;
  }).join("");
}

export interface StartQrLoginResult {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
}

export interface AdapterStatus extends OneBotGetStatusData {
  self_id?: string;
}

export class WeixinAdapter {
  private readonly logger: Logger;
  private readonly store: FileStore;
  private readonly client: IlinkClient;
  private listeners = new Set<(event: OneBotEvent) => void>();
  private account: WeixinAccountState | null = null;
  private contextTokens: Record<string, string>;
  private running = false;
  private pollTask: Promise<void> | null = null;
  private qrcodeMap = new Map<string, { qrcode: string; qrcodeUrl: string }>();
  private stats = { received: 0, sent: 0, failed: 0 };
  private syncBuf: string;
  private reloginTask: Promise<boolean> | null = null;
  private pollAbortController: AbortController | null = null;
  private reloginAbortController: AbortController | null = null;
  private userIdMappings: UserIdMappings;
  private readonly userIdPrefix: string;

  constructor(private readonly config: WeixinAdapterConfig = {}) {
    this.logger = new Logger("op_wx_onebotv11", config.debug ? "debug" : "info");
    this.store = new FileStore(config.storageDir);
    this.client = new IlinkClient(this.logger.child("ilink"), {
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      longPollTimeoutMs: config.longPollTimeoutMs,
      botAgent: config.botAgent,
    });
    this.account = this.store.loadAccount();
    this.contextTokens = this.store.loadContextTokens();
    this.syncBuf = this.store.loadSyncBuf();
    this.userIdPrefix = config.userIdMapping?.prefix?.trim() || DEFAULT_USER_ID_PREFIX;
    this.userIdMappings = this.store.loadUserIdMappings(config.userIdMapping);
  }

  onEvent(listener: (event: OneBotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: OneBotEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(`event listener error: ${String(error)}`);
      }
    }
  }

  private saveContextTokens(): void {
    this.store.saveContextTokens(this.contextTokens);
  }

  private setContextToken(userId: string, token: string): void {
    this.contextTokens[userId] = token;
    this.saveContextTokens();
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens[userId];
  }

  private saveUserIdMappings(): void {
    this.store.saveUserIdMappings(this.userIdMappings);
  }

  private toSimpleUserId(actualUserId: string): string {
    const existing = this.userIdMappings.actualToSimple[actualUserId];
    if (existing) return existing;

    let simpleId = "";
    do {
      simpleId = `${this.userIdPrefix}${this.userIdMappings.nextId++}`;
    } while (this.userIdMappings.simpleToActual[simpleId]);
    this.userIdMappings.actualToSimple[actualUserId] = simpleId;
    this.userIdMappings.simpleToActual[simpleId] = actualUserId;
    this.saveUserIdMappings();
    this.logger.info(`mapped user id ${actualUserId} -> ${simpleId}`);
    return simpleId;
  }

  private resolveActualUserId(inputUserId: string): string {
    return this.userIdMappings.simpleToActual[inputUserId] || inputUserId;
  }

  getUserIdMappings(): UserIdMappings {
    return {
      prefix: this.userIdMappings.prefix,
      nextId: this.userIdMappings.nextId,
      actualToSimple: { ...this.userIdMappings.actualToSimple },
      simpleToActual: { ...this.userIdMappings.simpleToActual },
    };
  }

  setUserIdMapping(oneBotUserId: string, actualUserId: string): void {
    const simpleId = oneBotUserId.trim();
    const actualId = actualUserId.trim();
    if (!simpleId || !actualId) throw new Error("user_id and weixin_user_id are required");

    const previousActual = this.userIdMappings.simpleToActual[simpleId];
    if (previousActual) delete this.userIdMappings.actualToSimple[previousActual];
    const previousSimple = this.userIdMappings.actualToSimple[actualId];
    if (previousSimple) delete this.userIdMappings.simpleToActual[previousSimple];

    this.userIdMappings.simpleToActual[simpleId] = actualId;
    this.userIdMappings.actualToSimple[actualId] = simpleId;
    if (simpleId.startsWith(this.userIdPrefix)) {
      const suffix = Number(simpleId.slice(this.userIdPrefix.length));
      if (Number.isSafeInteger(suffix) && suffix >= 0) {
        this.userIdMappings.nextId = Math.max(this.userIdMappings.nextId, suffix + 1);
      }
    }
    this.saveUserIdMappings();
  }

  deleteUserIdMapping(oneBotUserId: string): boolean {
    const simpleId = oneBotUserId.trim();
    const actualId = this.userIdMappings.simpleToActual[simpleId];
    if (!actualId) return false;
    delete this.userIdMappings.simpleToActual[simpleId];
    delete this.userIdMappings.actualToSimple[actualId];
    this.saveUserIdMappings();
    return true;
  }

  async startQrLogin(options?: { abortSignal?: AbortSignal }): Promise<StartQrLoginResult> {
    const localTokens = this.account?.token ? [this.account.token] : [];
    const qr = await this.client.startQrLogin(undefined, localTokens, options?.abortSignal);
    this.qrcodeMap.set(qr.sessionKey, { qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl });
    return qr;
  }

  async waitForQrLogin(sessionKey: string, options?: {
    printQrInTerminal?: boolean;
    timeoutMs?: number;
    verifyCodeProvider?: VerifyCodeProvider;
    abortSignal?: AbortSignal;
  }): Promise<WeixinAccountState> {
    const qr = this.qrcodeMap.get(sessionKey);
    if (!qr) throw new Error(`unknown sessionKey: ${sessionKey}`);
    if (options?.printQrInTerminal) {
      await this.client.printQr(qr.qrcodeUrl);
    }
    const result = await this.client.waitForQrLogin(qr.qrcode, {
      timeoutMs: options?.timeoutMs,
      verifyCodeProvider: options?.verifyCodeProvider,
      abortSignal: options?.abortSignal,
    }).finally(() => {
      this.qrcodeMap.delete(sessionKey);
    });
    if (result.alreadyConnected && this.account) return this.account;
    const account = this.client.normalizeAccount(result);
    this.account = {
      ...account,
      baseUrl: account.baseUrl || this.config.baseUrl || DEFAULT_BASE_URL,
      cdnBaseUrl: this.config.cdnBaseUrl || account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
    };
    this.store.saveAccount(this.account);
    return this.account;
  }

  getSelfId(): string | undefined {
    return this.account?.accountId;
  }

  requireAccount(): WeixinAccountState {
    if (!this.account) {
      throw new Error("weixin account not configured, call startQrLogin()/waitForQrLogin() first");
    }
    return this.account;
  }

  async start(): Promise<void> {
    const account = this.requireAccount();
    if (this.running) return;
    this.running = true;
    this.pollAbortController = new AbortController();
    if (this.config.notifyLifecycle !== false) {
      try {
        const response = await this.client.notifyStart(account);
        if (response.ret != null && response.ret !== 0) {
          this.logger.warn(`notifyStart ret=${response.ret} errmsg=${response.errmsg ?? ""}`);
        }
      } catch (error) {
        this.logger.warn(`notifyStart failed (ignored): ${String(error)}`);
      }
    }
    if (!this.running) return;
    this.emitLifecycle("connect");
    this.pollTask = this.pollLoop();
  }

  async stop(): Promise<void> {
    const wasActive = this.running || this.pollTask != null || this.reloginTask != null;
    if (!wasActive) return;
    this.running = false;
    this.pollAbortController?.abort();
    this.reloginAbortController?.abort();
    await this.pollTask?.catch(() => undefined);
    this.pollTask = null;
    await this.reloginTask?.catch(() => undefined);
    this.reloginTask = null;
    this.pollAbortController = null;
    this.reloginAbortController = null;
    if (this.account && this.config.notifyLifecycle !== false) {
      try {
        const response = await this.client.notifyStop(this.account);
        if (response.ret != null && response.ret !== 0) {
          this.logger.warn(`notifyStop ret=${response.ret} errmsg=${response.errmsg ?? ""}`);
        }
      } catch (error) {
        this.logger.warn(`notifyStop failed (ignored): ${String(error)}`);
      }
    }
    this.emitLifecycle("disable");
  }

  private emitLifecycle(subType: "connect" | "enable" | "disable"): void {
    const selfId = this.account?.accountId ?? "unknown";
    this.emit({
      time: Math.floor(Date.now() / 1000),
      self_id: selfId,
      post_type: "meta_event",
      meta_event_type: "lifecycle",
      sub_type: subType,
    });
  }

  createHeartbeat(intervalMs: number): OneBotEvent {
    return {
      time: Math.floor(Date.now() / 1000),
      self_id: this.account?.accountId ?? "unknown",
      post_type: "meta_event",
      meta_event_type: "heartbeat",
      interval: intervalMs,
      status: this.getStatus(),
    };
  }

  private async pollLoop(): Promise<void> {
    let nextTimeoutMs = this.config.longPollTimeoutMs;
    while (this.running) {
      try {
        const account = this.requireAccount();
        const response = await this.client.getUpdates(account, this.syncBuf, {
          abortSignal: this.pollAbortController?.signal,
          timeoutMs: nextTimeoutMs,
        });
        if (!this.running || this.pollAbortController?.signal.aborted) break;
        if (response.longpolling_timeout_ms != null && response.longpolling_timeout_ms > 0) {
          nextTimeoutMs = response.longpolling_timeout_ms;
        }
        if (response.get_updates_buf) {
          this.syncBuf = response.get_updates_buf;
          this.store.saveSyncBuf(this.syncBuf);
        }
        if ((response.errcode ?? response.ret) === -14) {
          const recovered = await this.handleSessionExpired();
          if (recovered) continue;
          throw new Error("session expired");
        }
        if ((response.ret != null && response.ret !== 0) || (response.errcode != null && response.errcode !== 0)) {
          throw new Error(`getUpdates ret=${response.ret ?? ""} errcode=${response.errcode ?? ""} errmsg=${response.errmsg ?? ""}`);
        }
        for (const message of response.msgs ?? []) {
          const event = await this.weixinMessageToOneBotEvent(message);
          if (event) {
            this.stats.received += 1;
            this.emit(event);
          }
        }
      } catch (error) {
        if (!this.running || this.pollAbortController?.signal.aborted) break;
        this.stats.failed += 1;
        this.logger.error(`poll loop error: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private async handleSessionExpired(): Promise<boolean> {
    if (!this.config.autoReloginOnExpire) {
      return false;
    }

    if (!this.reloginTask) {
      this.reloginTask = this.reloginAfterExpire()
        .catch((error) => {
          this.logger.error(`auto re-login failed: ${String(error)}`);
          return false;
        })
        .finally(() => {
          this.reloginTask = null;
        });
    }

    return this.reloginTask;
  }

  private async reloginAfterExpire(): Promise<boolean> {
    this.logger.warn("session expired, requesting a new QR code...");
    this.reloginAbortController = new AbortController();
    try {
      const qr = await this.startQrLogin({ abortSignal: this.reloginAbortController.signal });
      this.logger.warn(`new qrcode url: ${qr.qrcodeUrl}`);
      if (this.config.printQrInTerminalOnExpire) {
        await this.client.printQr(qr.qrcodeUrl);
      }
      const account = await this.waitForQrLogin(qr.sessionKey, {
        printQrInTerminal: false,
        timeoutMs: this.config.qrLoginTimeoutMs ?? 8 * 60_000,
        abortSignal: this.reloginAbortController.signal,
      });
      this.account = account;
      this.syncBuf = "";
      this.store.clearSyncBuf();
      this.emitLifecycle("connect");
      this.logger.info(`session refreshed: ${account.accountId}`);
      return true;
    } finally {
      this.reloginAbortController = null;
    }
  }

  private async messageItemToSegments(item: MessageItem, index: number): Promise<OneBotMessageSegment[]> {
    const account = this.requireAccount();
    const inboundDir = this.store.mediaDir("inbound");
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return [{ type: "text", data: { text: item.text_item.text } }];
    }
    if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
      const filePath = await this.client.downloadMediaFile({
        account,
        encryptedQueryParam: item.image_item.media.encrypt_query_param,
        fullUrl: item.image_item.media.full_url,
        aesKey: item.image_item.aeskey || item.image_item.media.aes_key,
        destinationDir: inboundDir,
        suggestedName: `image-${Date.now()}-${index}.jpg`,
      });
      return [{ type: "image", data: { file: encodeFileUri(filePath) } }];
    }
    if (item.type === MessageItemType.VOICE) {
      if (item.voice_item?.text) {
        return [{ type: "text", data: { text: item.voice_item.text } }];
      }
      if (item.voice_item?.media) {
        const filePath = await this.client.downloadMediaFile({
          account,
          encryptedQueryParam: item.voice_item.media.encrypt_query_param,
          fullUrl: item.voice_item.media.full_url,
          aesKey: item.voice_item.media.aes_key,
          destinationDir: inboundDir,
          suggestedName: `voice-${Date.now()}-${index}.silk`,
        });
        return [{ type: "record", data: { file: encodeFileUri(filePath) } }];
      }
    }
    if (item.type === MessageItemType.FILE && item.file_item?.media) {
      const filePath = await this.client.downloadMediaFile({
        account,
        encryptedQueryParam: item.file_item.media.encrypt_query_param,
        fullUrl: item.file_item.media.full_url,
        aesKey: item.file_item.media.aes_key,
        destinationDir: inboundDir,
        suggestedName: item.file_item.file_name || `file-${Date.now()}-${index}`,
      });
      return [{ type: "file", data: { file: encodeFileUri(filePath), name: path.basename(filePath) } }];
    }
    if (item.type === MessageItemType.VIDEO && item.video_item?.media) {
      const filePath = await this.client.downloadMediaFile({
        account,
        encryptedQueryParam: item.video_item.media.encrypt_query_param,
        fullUrl: item.video_item.media.full_url,
        aesKey: item.video_item.media.aes_key,
        destinationDir: inboundDir,
        suggestedName: `video-${Date.now()}-${index}.mp4`,
      });
      return [{ type: "video", data: { file: encodeFileUri(filePath) } }];
    }
    return [{ type: "text", data: { text: "[unsupported message item]" } }];
  }

  private async weixinMessageToOneBotEvent(message: WeixinMessage): Promise<OneBotEvent | null> {
    const actualUserId = message.from_user_id;
    const selfId = this.account?.accountId;
    if (!actualUserId || !selfId) return null;
    if (message.context_token) this.setContextToken(actualUserId, message.context_token);
    const userId = this.toSimpleUserId(actualUserId);

    const segments: OneBotMessageSegment[] = [];
    const items = message.item_list ?? [];
    for (let i = 0; i < items.length; i += 1) {
      segments.push(...(await this.messageItemToSegments(items[i]!, i)));
    }
    if (segments.length === 0) segments.push({ type: "text", data: { text: "" } });

    return {
      time: Math.floor((message.create_time_ms ?? Date.now()) / 1000),
      self_id: selfId,
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: String(message.message_id ?? message.seq ?? Date.now()),
      user_id: userId,
      message: segments,
      raw_message: segmentsToCqString(segments),
      font: 0,
      sender: {
        user_id: userId,
        nickname: actualUserId,
      },
    };
  }

  normalizeIncomingMessage(message: OneBotMessage, autoEscape = false): OneBotMessageSegment[] {
    if (typeof message === "string") {
      return autoEscape ? [{ type: "text", data: { text: message } }] : parseCqString(message);
    }
    return message;
  }

  private async resolveOutboundImage(source: string): Promise<{ filePath: string; temporary: boolean }> {
    if (!source) throw new Error("outbound image is missing data.file");

    if (/^https?:\/\//i.test(source)) {
      const filePath = await this.client.downloadRemoteToTemp(source, this.store.mediaDir("outbound-temp"));
      return { filePath, temporary: true };
    }

    if (source.startsWith("base64://") || /^data:image\/[a-z0-9.+-]+;base64,/i.test(source)) {
      const encoded = source.startsWith("base64://")
        ? source.slice("base64://".length)
        : source.slice(source.indexOf(",") + 1);
      const buffer = Buffer.from(encoded, "base64");
      if (buffer.length === 0) throw new Error("outbound image contains empty base64 data");
      const filePath = path.join(
        this.store.mediaDir("outbound-temp"),
        `${randomUUID()}${detectImageExtension(buffer)}`,
      );
      await fs.writeFile(filePath, buffer);
      return { filePath, temporary: true };
    }

    const filePath = source.startsWith("file://") ? fileURLToPath(source) : path.resolve(source);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`outbound image file does not exist: ${filePath}`);
    return { filePath, temporary: false };
  }

  private async sendPrivateMessageInternal(userId: string | number, message: OneBotMessage, options?: { autoEscape?: boolean }): Promise<{ message_id: string }> {
    const account = this.requireAccount();
    const target = this.resolveActualUserId(String(userId));
    const segments = this.normalizeIncomingMessage(message, options?.autoEscape);
    const contextToken = this.getContextToken(target);

    let textBuffer = "";
    let lastMessageId = "";
    const flushText = async () => {
      if (!textBuffer) return;
      const sent = await this.client.sendText(account, target, textBuffer, contextToken);
      lastMessageId = sent.messageId;
      textBuffer = "";
    };

    for (const segment of segments) {
      if (segment.type === "text") {
        textBuffer += segment.data.text ?? "";
        continue;
      }
      if (segment.type === "reply") continue;
      if (segment.type === "at") {
        textBuffer += `@${segment.data.qq ?? segment.data.user_id ?? ""}`;
        continue;
      }
      if (segment.type === "image") {
        await flushText();
        const resolved = await this.resolveOutboundImage(segment.data.file ?? segment.data.url ?? "");
        try {
          const sent = await this.client.sendImage(account, target, resolved.filePath, "", contextToken);
          lastMessageId = sent.messageId;
        } finally {
          if (resolved.temporary) await fs.unlink(resolved.filePath).catch(() => undefined);
        }
        continue;
      }
      if (segment.type === "record") {
        throw new Error("outbound record is not supported by current implementation");
      }
      throw new Error(`outbound ${segment.type} is not supported by current implementation`);
    }

    await flushText();
    this.stats.sent += 1;
    return { message_id: lastMessageId || String(Date.now()) };
  }

  async sendPrivateMessage(userId: string | number, message: OneBotMessage, options?: { autoEscape?: boolean }): Promise<{ message_id: string }> {
    try {
      return await this.sendPrivateMessageInternal(userId, message, options);
    } catch (error) {
      this.stats.failed += 1;
      throw error;
    }
  }

  async getLoginInfo(): Promise<OneBotLoginInfoData> {
    const account = this.requireAccount();
    return {
      user_id: account.accountId,
      nickname: account.name || account.accountId,
    };
  }

  getStatus(): AdapterStatus {
    return {
      online: Boolean(this.account && this.running),
      good: Boolean(this.account),
      self_id: this.account?.accountId,
      stat: {
        received: this.stats.received,
        sent: this.stats.sent,
        failed: this.stats.failed,
      },
    };
  }

  canSendImage(): boolean {
    return true;
  }

  canSendRecord(): boolean {
    return false;
  }
}
