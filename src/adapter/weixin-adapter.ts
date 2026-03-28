import path from "node:path";

import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, type WeixinAdapterConfig } from "../config.js";
import { IlinkClient } from "../ilink/client.js";
import { FileStore } from "../storage/file-store.js";
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

  constructor(private readonly config: WeixinAdapterConfig = {}) {
    this.logger = new Logger("op_wx_onebotv11", config.debug ? "debug" : "info");
    this.store = new FileStore(config.storageDir);
    this.client = new IlinkClient(this.logger.child("ilink"), {
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      longPollTimeoutMs: config.longPollTimeoutMs,
    });
    this.account = this.store.loadAccount();
    this.contextTokens = this.store.loadContextTokens();
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

  async startQrLogin(): Promise<StartQrLoginResult> {
    const qr = await this.client.startQrLogin();
    this.qrcodeMap.set(qr.sessionKey, { qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl });
    return qr;
  }

  async waitForQrLogin(sessionKey: string, options?: { printQrInTerminal?: boolean; timeoutMs?: number }): Promise<WeixinAccountState> {
    const qr = this.qrcodeMap.get(sessionKey);
    if (!qr) throw new Error(`unknown sessionKey: ${sessionKey}`);
    if (options?.printQrInTerminal) {
      await this.client.printQr(qr.qrcodeUrl);
    }
    const result = await this.client.waitForQrLogin(qr.qrcode, options?.timeoutMs);
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
    this.requireAccount();
    if (this.running) return;
    this.running = true;
    this.emitLifecycle("connect");
    this.pollTask = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.pollTask?.catch(() => undefined);
    this.pollTask = null;
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
    const account = this.requireAccount();
    let syncBuf = this.store.loadSyncBuf();
    while (this.running) {
      try {
        const response = await this.client.getUpdates(account, syncBuf);
        if (response.get_updates_buf) {
          syncBuf = response.get_updates_buf;
          this.store.saveSyncBuf(syncBuf);
        }
        if ((response.errcode ?? response.ret) === -14) {
          throw new Error("session expired");
        }
        for (const message of response.msgs ?? []) {
          const event = await this.weixinMessageToOneBotEvent(message);
          if (event) {
            this.stats.received += 1;
            this.emit(event);
          }
        }
      } catch (error) {
        this.stats.failed += 1;
        this.logger.error(`poll loop error: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
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
    const userId = message.from_user_id;
    const selfId = this.account?.accountId;
    if (!userId || !selfId) return null;
    if (message.context_token) this.setContextToken(userId, message.context_token);

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
        nickname: userId,
      },
    };
  }

  normalizeIncomingMessage(message: OneBotMessage, autoEscape = false): OneBotMessageSegment[] {
    if (typeof message === "string") {
      return autoEscape ? [{ type: "text", data: { text: message } }] : parseCqString(message);
    }
    return message;
  }

  async sendPrivateMessage(userId: string | number, message: OneBotMessage, options?: { autoEscape?: boolean }): Promise<{ message_id: string }> {
    const account = this.requireAccount();
    const target = String(userId);
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
      if (segment.type === "record") {
        throw new Error("outbound record is not supported by current implementation");
      }
      throw new Error(`outbound ${segment.type} is not supported by current implementation`);
    }

    await flushText();
    this.stats.sent += 1;
    return { message_id: lastMessageId || String(Date.now()) };
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
    return false;
  }

  canSendRecord(): boolean {
    return false;
  }
}
