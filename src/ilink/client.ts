import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import qrcodeTerminal from "qrcode-terminal";

import { DEFAULT_BASE_URL, DEFAULT_BOT_TYPE, DEFAULT_CDN_BASE_URL } from "../config.js";
import type {
  GetConfigResp,
  GetUpdatesResp,
  GetUploadUrlResp,
  MessageItem,
  QrStartResult,
  QrWaitResult,
  UploadedMedia,
  WeixinAccountState,
} from "../types/ilink.js";
import { MessageState, MessageType, UploadMediaType } from "../types/ilink.js";
import { Logger } from "../util/logger.js";
import { decryptAesEcb, encryptAesEcb, md5Hex, paddedCipherSize, randomHexKey, randomWechatUin } from "./crypto.js";
import { getExtensionFromMimeOrUrl, getMimeFromFilename } from "./mime.js";

const CHANNEL_VERSION = "0.1.0";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = 0x00000100;
const LOGIN_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_MS = 35_000;

function buildBaseInfo(): { channel_version: string } {
  return { channel_version: CHANNEL_VERSION };
}

function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

const PNG_1X1_TRANSPARENT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=",
  "base64",
);

function getImageDimensions(buffer: Buffer): { width?: number; height?: number } {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer.length >= 10 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      if (length <= 2) break;
      offset += 2 + length;
    }
  }

  return {};
}

export class IlinkClient {
  constructor(
    private readonly logger: Logger,
    private readonly options: {
      baseUrl?: string;
      requestTimeoutMs?: number;
      longPollTimeoutMs?: number;
    } = {},
  ) {}

  private buildHeaders(body?: string, token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...buildCommonHeaders(),
      "X-WECHAT-UIN": randomWechatUin(),
    };
    if (body != null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
    }
    if (token?.trim()) {
      headers.AuthorizationType = "ilink_bot_token";
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    return headers;
  }

  private async getText(baseUrl: string, endpoint: string, timeoutMs = this.options.requestTimeoutMs ?? API_TIMEOUT_MS): Promise<string> {
    const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: buildCommonHeaders(),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  private async postJson<T>(params: {
    baseUrl: string;
    endpoint: string;
    body: Record<string, unknown>;
    token?: string;
    timeoutMs?: number;
  }): Promise<T> {
    const body = JSON.stringify({ ...params.body, base_info: buildBaseInfo() });
    const url = new URL(params.endpoint, params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`).toString();
    const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? this.options.requestTimeoutMs ?? API_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(body, params.token),
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${params.endpoint} ${res.status}: ${text}`);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async startQrLogin(botType = DEFAULT_BOT_TYPE): Promise<QrStartResult> {
    const raw = await this.getText(this.options.baseUrl || DEFAULT_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, LOGIN_TIMEOUT_MS);
    const parsed = JSON.parse(raw) as { qrcode: string; qrcode_img_content: string };
    return {
      sessionKey: randomUUID(),
      qrcode: parsed.qrcode,
      qrcodeUrl: parsed.qrcode_img_content,
    };
  }

  async waitForQrLogin(qrcode: string, timeoutMs = 8 * 60_000): Promise<QrWaitResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = await this.getText(
          this.options.baseUrl || DEFAULT_BASE_URL,
          `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
          this.options.longPollTimeoutMs ?? LONG_POLL_TIMEOUT_MS,
        );
        const parsed = JSON.parse(raw) as {
          status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
          bot_token?: string;
          ilink_bot_id?: string;
          ilink_user_id?: string;
          baseurl?: string;
        };
        if (parsed.status === "confirmed" && parsed.bot_token && parsed.ilink_bot_id) {
          return {
            connected: true,
            message: "login success",
            accountId: parsed.ilink_bot_id,
            botToken: parsed.bot_token,
            baseUrl: parsed.baseurl || DEFAULT_BASE_URL,
            userId: parsed.ilink_user_id,
          };
        }
        if (parsed.status === "expired") {
          return { connected: false, message: "qrcode expired" };
        }
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AbortError") {
          this.logger.warn(`waitForQrLogin retry after error: ${String(error)}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return { connected: false, message: "login timeout" };
  }

  async printQr(qrcodeUrl: string): Promise<void> {
    await new Promise<void>((resolve) => {
      qrcodeTerminal.generate(qrcodeUrl, { small: true }, (terminalQr) => {
        console.log(terminalQr);
        console.log(qrcodeUrl);
        resolve();
      });
    });
  }

  async getUpdates(account: WeixinAccountState, getUpdatesBuf: string): Promise<GetUpdatesResp> {
    try {
      return await this.postJson<GetUpdatesResp>({
        baseUrl: account.baseUrl,
        endpoint: "ilink/bot/getupdates",
        token: account.token,
        timeoutMs: this.options.longPollTimeoutMs ?? LONG_POLL_TIMEOUT_MS,
        body: { get_updates_buf: getUpdatesBuf || "" },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw error;
    }
  }

  async getConfig(account: WeixinAccountState, userId: string, contextToken?: string): Promise<GetConfigResp> {
    return this.postJson<GetConfigResp>({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/getconfig",
      token: account.token,
      timeoutMs: 10_000,
      body: { ilink_user_id: userId, context_token: contextToken },
    });
  }

  async sendTyping(account: WeixinAccountState, userId: string, typingTicket: string, status: 1 | 2): Promise<void> {
    await this.postJson<Record<string, unknown>>({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      token: account.token,
      timeoutMs: 10_000,
      body: { ilink_user_id: userId, typing_ticket: typingTicket, status },
    });
  }

  async sendMessage(account: WeixinAccountState, params: {
    to: string;
    itemList: MessageItem[];
    contextToken?: string;
    clientId?: string;
  }): Promise<{ messageId: string }> {
    const clientId = params.clientId ?? `opwx-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await this.postJson<Record<string, unknown>>({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      token: account.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: params.to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: params.contextToken,
          item_list: params.itemList,
        },
      },
    });
    return { messageId: clientId };
  }

  async getUploadUrl(account: WeixinAccountState, body: Record<string, unknown>): Promise<GetUploadUrlResp> {
    return this.postJson<GetUploadUrlResp>({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/getuploadurl",
      token: account.token,
      body,
    });
  }

  private buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
    return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  }

  private buildCdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string): string {
    return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
  }

  async uploadMedia(account: WeixinAccountState, params: {
    filePath: string;
    toUserId: string;
    mediaType: number;
  }): Promise<UploadedMedia> {
    const plaintext = await fs.readFile(params.filePath);
    const filekey = randomUUID().replace(/-/g, "");
    const aesKeyHex = randomHexKey(16);
    const aesKey = Buffer.from(aesKeyHex, "hex");
    const plainMd5 = md5Hex(plaintext);
    const shouldUploadThumb = params.mediaType === UploadMediaType.IMAGE || params.mediaType === UploadMediaType.VIDEO;
    const thumbPlaintext = shouldUploadThumb
      ? (params.mediaType === UploadMediaType.IMAGE ? plaintext : PNG_1X1_TRANSPARENT)
      : undefined;
    const thumbDimensions = thumbPlaintext ? getImageDimensions(thumbPlaintext) : {};
    const thumbPlainMd5 = thumbPlaintext ? md5Hex(thumbPlaintext) : undefined;
    const thumbCipherSize = thumbPlaintext ? paddedCipherSize(thumbPlaintext.length) : undefined;

    const uploadResp = await this.getUploadUrl(account, {
      filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: plaintext.length,
      rawfilemd5: plainMd5,
      filesize: paddedCipherSize(plaintext.length),
      thumb_rawsize: thumbPlaintext?.length,
      thumb_rawfilemd5: thumbPlainMd5,
      thumb_filesize: thumbCipherSize,
      no_need_thumb: !shouldUploadThumb,
      aeskey: aesKeyHex,
    });
    const uploadUrl = uploadResp.upload_full_url?.trim()
      || (uploadResp.upload_param ? this.buildCdnUploadUrl(account.cdnBaseUrl || DEFAULT_CDN_BASE_URL, uploadResp.upload_param, filekey) : undefined);
    if (!uploadUrl) throw new Error("getuploadurl returned neither upload_full_url nor upload_param");
    const encrypted = encryptAesEcb(plaintext, aesKey);
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(encrypted),
    });
    if (!uploadRes.ok) throw new Error(`cdn upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
    const encryptedParam = uploadRes.headers.get("x-encrypted-param");
    if (!encryptedParam) throw new Error("cdn upload missing x-encrypted-param");

    let thumb: UploadedMedia["thumb"];
    if (thumbPlaintext) {
      const thumbUploadParam = uploadResp.thumb_upload_param?.trim();
      if (!thumbUploadParam) {
        throw new Error("getuploadurl missing thumb_upload_param for image/video media");
      }
      const thumbUploadUrl = this.buildCdnUploadUrl(account.cdnBaseUrl || DEFAULT_CDN_BASE_URL, thumbUploadParam, filekey);
      const thumbEncrypted = encryptAesEcb(thumbPlaintext, aesKey);
      const thumbUploadRes = await fetch(thumbUploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(thumbEncrypted),
      });
      if (!thumbUploadRes.ok) throw new Error(`cdn thumb upload failed: ${thumbUploadRes.status} ${thumbUploadRes.statusText}`);
      const thumbEncryptedParam = thumbUploadRes.headers.get("x-encrypted-param");
      if (!thumbEncryptedParam) throw new Error("cdn thumb upload missing x-encrypted-param");
      thumb = {
        aesKeyHex,
        plainSize: thumbPlaintext.length,
        cipherSize: paddedCipherSize(thumbPlaintext.length),
        downloadEncryptedQueryParam: thumbEncryptedParam,
        width: thumbDimensions.width,
        height: thumbDimensions.height,
      };
    }

    return {
      filekey,
      aesKeyHex,
      plainSize: plaintext.length,
      plainMd5,
      cipherSize: paddedCipherSize(plaintext.length),
      downloadEncryptedQueryParam: encryptedParam,
      thumb,
    };
  }

  async sendText(account: WeixinAccountState, to: string, text: string, contextToken?: string): Promise<{ messageId: string }> {
    return this.sendMessage(account, {
      to,
      contextToken,
      itemList: text ? [{ type: 1, text_item: { text } }] : [],
    });
  }

  async sendImage(account: WeixinAccountState, to: string, filePath: string, caption = "", contextToken?: string): Promise<{ messageId: string }> {
    const uploaded = await this.uploadMedia(account, { filePath, toUserId: to, mediaType: UploadMediaType.IMAGE });
    if (caption) await this.sendText(account, to, caption, contextToken);
    return this.sendMessage(account, {
      to,
      contextToken,
      itemList: [{
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.aesKeyHex, "hex").toString("base64"),
            encrypt_type: 1,
          },
          thumb_media: uploaded.thumb ? {
            encrypt_query_param: uploaded.thumb.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.thumb.aesKeyHex, "hex").toString("base64"),
            encrypt_type: 1,
          } : undefined,
          mid_size: uploaded.cipherSize,
          hd_size: uploaded.cipherSize,
          thumb_size: uploaded.thumb?.cipherSize,
          thumb_width: uploaded.thumb?.width,
          thumb_height: uploaded.thumb?.height,
        },
      }],
    });
  }

  async sendVideo(account: WeixinAccountState, to: string, filePath: string, caption = "", contextToken?: string): Promise<{ messageId: string }> {
    const uploaded = await this.uploadMedia(account, { filePath, toUserId: to, mediaType: UploadMediaType.VIDEO });
    if (caption) await this.sendText(account, to, caption, contextToken);
    return this.sendMessage(account, {
      to,
      contextToken,
      itemList: [{
        type: 5,
        video_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.aesKeyHex, "hex").toString("base64"),
            encrypt_type: 1,
          },
          thumb_media: uploaded.thumb ? {
            encrypt_query_param: uploaded.thumb.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.thumb.aesKeyHex, "hex").toString("base64"),
            encrypt_type: 1,
          } : undefined,
          video_size: uploaded.cipherSize,
          video_md5: uploaded.plainMd5,
          play_length: 0,
          thumb_size: uploaded.thumb?.cipherSize,
          thumb_width: uploaded.thumb?.width,
          thumb_height: uploaded.thumb?.height,
        },
      }],
    });
  }

  async sendFile(account: WeixinAccountState, to: string, filePath: string, caption = "", contextToken?: string): Promise<{ messageId: string }> {
    const uploaded = await this.uploadMedia(account, { filePath, toUserId: to, mediaType: UploadMediaType.FILE });
    if (caption) await this.sendText(account, to, caption, contextToken);
    return this.sendMessage(account, {
      to,
      contextToken,
      itemList: [{
        type: 4,
        file_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.aesKeyHex, "hex").toString("base64"),
            encrypt_type: 1,
          },
          file_name: path.basename(filePath),
          len: String(uploaded.plainSize),
        },
      }],
    });
  }

  async downloadMediaFile(params: {
    account: WeixinAccountState;
    encryptedQueryParam?: string;
    fullUrl?: string;
    aesKey?: string;
    destinationDir: string;
    suggestedName: string;
  }): Promise<string> {
    const url = params.fullUrl || (params.encryptedQueryParam
      ? this.buildCdnDownloadUrl(params.account.cdnBaseUrl || DEFAULT_CDN_BASE_URL, params.encryptedQueryParam)
      : "");
    if (!url) throw new Error("missing encryptedQueryParam/fullUrl for media download");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cdn download failed: ${res.status} ${res.statusText}`);
    let buffer: Buffer = Buffer.from(await res.arrayBuffer());
    if (params.aesKey) {
      const decoded = params.aesKey.startsWith("base64:")
        ? Buffer.from(params.aesKey.slice(7), "base64")
        : Buffer.from(params.aesKey, /^[0-9a-fA-F]+$/.test(params.aesKey) ? "hex" : "base64");
      const key = decoded.length === 16 ? decoded : Buffer.from(decoded.toString("ascii"), "hex");
      buffer = decryptAesEcb(buffer, key);
    }
    await fs.mkdir(params.destinationDir, { recursive: true });
    const ext = path.extname(params.suggestedName) || getExtensionFromMimeOrUrl(res.headers.get("content-type"), url);
    const output = path.join(params.destinationDir, `${path.basename(params.suggestedName, path.extname(params.suggestedName))}${ext}`);
    await fs.writeFile(output, buffer);
    return output;
  }

  detectMediaType(filePath: string): "image" | "video" | "file" | "record" {
    const mime = getMimeFromFilename(filePath);
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "record";
    return "file";
  }

  async downloadRemoteToTemp(url: string, destinationDir: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`remote media download failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(destinationDir, { recursive: true });
    const ext = getExtensionFromMimeOrUrl(res.headers.get("content-type"), url);
    const filePath = path.join(destinationDir, `${randomUUID()}${ext}`);
    await fs.writeFile(filePath, buf);
    return filePath;
  }

  normalizeAccount(wait: QrWaitResult): WeixinAccountState {
    if (!wait.connected || !wait.accountId || !wait.botToken) {
      throw new Error(wait.message || "login failed");
    }
    return {
      accountId: wait.accountId,
      token: wait.botToken,
      baseUrl: wait.baseUrl || DEFAULT_BASE_URL,
      cdnBaseUrl: DEFAULT_CDN_BASE_URL,
      userId: wait.userId,
      name: wait.accountId,
    };
  }
}
