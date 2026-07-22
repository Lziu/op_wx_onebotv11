import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import qrcodeTerminal from "qrcode-terminal";

import { DEFAULT_BASE_URL, DEFAULT_BOT_TYPE, DEFAULT_CDN_BASE_URL } from "../config.js";
import type {
  GetConfigResp,
  GetUpdatesResp,
  GetUploadUrlResp,
  MessageItem,
  NotifyLifecycleResp,
  QrStartResult,
  QrWaitResult,
  SendMessageResp,
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
const API_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_MS = 35_000;

function sanitizeBotAgent(value?: string): string {
  const fallback = `op_wx_onebotv11/${CHANNEL_VERSION}`;
  if (!value?.trim()) return fallback;
  const normalized = value.trim().replace(/[^\x20-\x7e]/g, "").slice(0, 256);
  return normalized || fallback;
}

function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

export function classifyFetchError(error: unknown): {
  type: "dns" | "tcp" | "tls" | "timeout" | "unknown";
  description: string;
  code?: string;
} {
  if (error instanceof Error && error.name === "AbortError") {
    return { type: "timeout", description: "request aborted or timed out" };
  }
  const value = error as { cause?: unknown; code?: unknown };
  const cause = value?.cause;
  const causeCode = typeof cause === "object" && cause != null && "code" in cause
    ? String((cause as { code?: unknown }).code ?? "")
    : typeof value?.code === "string" ? value.code : "";
  const text = `${String(error)} ${String(cause ?? "")} ${causeCode}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return { type: "dns", description: "DNS resolution failed", ...(causeCode ? { code: causeCode } : {}) };
  if (/ECONNREFUSED/i.test(text)) return { type: "tcp", description: "TCP connection refused", ...(causeCode ? { code: causeCode } : {}) };
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(text)) return { type: "tcp", description: "TCP timeout or unreachable", ...(causeCode ? { code: causeCode } : {}) };
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(text)) return { type: "tls", description: "TLS or socket failure", ...(causeCode ? { code: causeCode } : {}) };
  return { type: "unknown", description: "network request failed", ...(causeCode ? { code: causeCode } : {}) };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["qrcode", "verify_code", "encrypted_query_param", "filekey"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "***");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function createAbortContext(timeoutMs?: number, externalSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = timeoutMs != null && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export type VerifyCodeProvider = (prompt: string) => Promise<string>;

export interface WaitForQrLoginOptions {
  timeoutMs?: number;
  verifyCodeProvider?: VerifyCodeProvider;
  abortSignal?: AbortSignal;
}

export class IlinkClient {
  constructor(
    private readonly logger: Logger,
    private readonly options: {
      baseUrl?: string;
      requestTimeoutMs?: number;
      longPollTimeoutMs?: number;
      botAgent?: string;
    } = {},
  ) {}

  private buildBaseInfo(): { channel_version: string; bot_agent: string } {
    return {
      channel_version: CHANNEL_VERSION,
      bot_agent: sanitizeBotAgent(this.options.botAgent),
    };
  }

  private buildHeaders(body?: string, token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...buildCommonHeaders(),
      "X-WECHAT-UIN": randomWechatUin(),
    };
    if (body != null) {
      headers["Content-Type"] = "application/json";
    }
    headers.AuthorizationType = "ilink_bot_token";
    if (token?.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    return headers;
  }

  private async getText(baseUrl: string, endpoint: string, timeoutMs = this.options.requestTimeoutMs ?? API_TIMEOUT_MS, abortSignal?: AbortSignal): Promise<string> {
    const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
    const abort = createAbortContext(timeoutMs, abortSignal);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: buildCommonHeaders(),
        signal: abort.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`);
      return text;
    } catch (error) {
      const classified = classifyFetchError(error);
      const message = `${endpoint}: GET failed url=${redactUrl(url)} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""} error=${String(error)}`;
      if (error instanceof Error && error.name === "AbortError") this.logger.debug(message);
      else this.logger.error(message);
      throw error;
    } finally {
      abort.cleanup();
    }
  }

  private async postJson<T>(params: {
    baseUrl: string;
    endpoint: string;
    body: Record<string, unknown>;
    token?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<T> {
    const body = JSON.stringify({ ...params.body, base_info: this.buildBaseInfo() });
    const url = new URL(params.endpoint, params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`).toString();
    const timeoutMs = params.timeoutMs === 0
      ? undefined
      : params.timeoutMs ?? this.options.requestTimeoutMs ?? API_TIMEOUT_MS;
    const abort = createAbortContext(timeoutMs, params.abortSignal);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(body, params.token),
        body,
        signal: abort.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${params.endpoint} ${res.status}: ${text}`);
      return JSON.parse(text || "{}") as T;
    } catch (error) {
      const classified = classifyFetchError(error);
      const message = `${params.endpoint}: POST failed url=${redactUrl(url)} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""} error=${String(error)}`;
      if (error instanceof Error && error.name === "AbortError") this.logger.debug(message);
      else this.logger.error(message);
      throw error;
    } finally {
      abort.cleanup();
    }
  }

  async startQrLogin(botType = DEFAULT_BOT_TYPE, localTokenList: string[] = [], abortSignal?: AbortSignal): Promise<QrStartResult> {
    const parsed = await this.postJson<{ qrcode: string; qrcode_img_content: string }>({
      baseUrl: this.options.baseUrl || DEFAULT_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      body: { local_token_list: localTokenList.filter(Boolean).slice(0, 10) },
      timeoutMs: 0,
      abortSignal,
    });
    return {
      sessionKey: randomUUID(),
      qrcode: parsed.qrcode,
      qrcodeUrl: parsed.qrcode_img_content,
    };
  }

  private async promptVerifyCode(prompt: string): Promise<string> {
    if (!process.stdin.isTTY) throw new Error("weixin login requires a verify code, but stdin is not interactive");
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await readline.question(prompt)).trim();
    } finally {
      readline.close();
    }
  }

  async waitForQrLogin(qrcode: string, options: WaitForQrLoginOptions = {}): Promise<QrWaitResult> {
    const deadline = Date.now() + (options.timeoutMs ?? 8 * 60_000);
    let currentBaseUrl = this.options.baseUrl || DEFAULT_BASE_URL;
    let verifyCode: string | undefined;
    while (Date.now() < deadline) {
      if (options.abortSignal?.aborted) return { connected: false, message: "login aborted" };
      try {
        let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
        if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
        const raw = await this.getText(
          currentBaseUrl,
          endpoint,
          this.options.longPollTimeoutMs ?? LONG_POLL_TIMEOUT_MS,
          options.abortSignal,
        );
        const parsed = JSON.parse(raw) as {
          status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
          bot_token?: string;
          ilink_bot_id?: string;
          ilink_user_id?: string;
          baseurl?: string;
          redirect_host?: string;
        };
        if (parsed.status === "scaned" && verifyCode) verifyCode = undefined;
        if (parsed.status === "scaned_but_redirect" && parsed.redirect_host) {
          currentBaseUrl = /^https?:\/\//i.test(parsed.redirect_host)
            ? parsed.redirect_host
            : `https://${parsed.redirect_host}`;
          continue;
        }
        if (parsed.status === "need_verifycode") {
          const provider = options.verifyCodeProvider ?? ((prompt: string) => this.promptVerifyCode(prompt));
          verifyCode = (await provider(verifyCode
            ? "验证数字不匹配，请重新输入："
            : "请输入手机微信显示的验证数字：")).trim();
          if (!verifyCode) throw new Error("empty verify code");
          continue;
        }
        if (parsed.status === "verify_code_blocked") {
          return { connected: false, message: "verify code blocked; generate a new QR code later" };
        }
        if (parsed.status === "binded_redirect") {
          return { connected: false, alreadyConnected: true, message: "account is already connected" };
        }
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
        if (options.abortSignal?.aborted) return { connected: false, message: "login aborted" };
        if (error instanceof Error && /verify code|验证|stdin|empty verify/i.test(error.message)) {
          return { connected: false, message: error.message };
        }
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

  async getUpdates(account: WeixinAccountState, getUpdatesBuf: string, options: {
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<GetUpdatesResp> {
    try {
      return await this.postJson<GetUpdatesResp>({
        baseUrl: account.baseUrl,
        endpoint: "ilink/bot/getupdates",
        token: account.token,
        timeoutMs: options.timeoutMs ?? this.options.longPollTimeoutMs ?? LONG_POLL_TIMEOUT_MS,
        abortSignal: options.abortSignal,
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
    const response = await this.postJson<SendMessageResp>({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      token: account.token,
      timeoutMs: 10_000,
      body: { ilink_user_id: userId, typing_ticket: typingTicket, status },
    });
    if (response.ret != null && response.ret !== 0) {
      throw new Error(`sendTyping ret=${response.ret} errmsg=${response.errmsg ?? "(none)"}`);
    }
  }

  async sendMessage(account: WeixinAccountState, params: {
    to: string;
    itemList: MessageItem[];
    contextToken?: string;
    clientId?: string;
  }): Promise<{ messageId: string }> {
    const clientId = params.clientId ?? `opwx-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const response = await this.postJson<SendMessageResp>({
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
    if (response.ret != null && response.ret !== 0) {
      throw new Error(`sendMessage ret=${response.ret} errmsg=${response.errmsg ?? "(none)"}`);
    }
    return { messageId: clientId };
  }

  async notifyStart(account: WeixinAccountState): Promise<NotifyLifecycleResp> {
    return this.postJson<NotifyLifecycleResp>({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/msg/notifystart",
      token: account.token,
      timeoutMs: 10_000,
      body: {},
    });
  }

  async notifyStop(account: WeixinAccountState): Promise<NotifyLifecycleResp> {
    return this.postJson<NotifyLifecycleResp>({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/msg/notifystop",
      token: account.token,
      timeoutMs: 10_000,
      body: {},
    });
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
    const uploadResp = await this.getUploadUrl(account, {
      filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: plaintext.length,
      rawfilemd5: plainMd5,
      filesize: paddedCipherSize(plaintext.length),
      no_need_thumb: true,
      aeskey: aesKeyHex,
    });
    const uploadUrl = uploadResp.upload_full_url?.trim()
      || (uploadResp.upload_param ? this.buildCdnUploadUrl(account.cdnBaseUrl || DEFAULT_CDN_BASE_URL, uploadResp.upload_param, filekey) : undefined);
    if (!uploadUrl) {
      const details = [
        uploadResp.errcode != null ? `errcode=${uploadResp.errcode}` : "",
        uploadResp.ret != null ? `ret=${uploadResp.ret}` : "",
        uploadResp.errmsg ? `errmsg=${uploadResp.errmsg}` : "",
      ].filter(Boolean).join(" ");
      throw new Error(`getuploadurl returned neither upload_full_url nor upload_param${details ? ` (${details})` : ""}`);
    }
    const encrypted = encryptAesEcb(plaintext, aesKey);
    let encryptedParam: string | undefined;
    let lastUploadError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const uploadRes = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(encrypted),
        });
        if (uploadRes.status >= 400 && uploadRes.status < 500) {
          const detail = uploadRes.headers.get("x-error-message") || await uploadRes.text();
          throw new Error(`cdn upload client error ${uploadRes.status}: ${detail || uploadRes.statusText}`);
        }
        if (uploadRes.status !== 200) {
          const detail = uploadRes.headers.get("x-error-message") || uploadRes.statusText;
          throw new Error(`cdn upload server error ${uploadRes.status}: ${detail}`);
        }
        encryptedParam = uploadRes.headers.get("x-encrypted-param") ?? undefined;
        if (!encryptedParam) throw new Error("cdn upload missing x-encrypted-param");
        break;
      } catch (error) {
        lastUploadError = error;
        if (error instanceof Error && error.message.includes("client error")) throw error;
        const classified = classifyFetchError(error);
        this.logger.warn(`cdn upload attempt ${attempt}/3 failed url=${redactUrl(uploadUrl)} type=${classified.type} description=${classified.description} error=${String(error)}`);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
    if (!encryptedParam) throw lastUploadError instanceof Error ? lastUploadError : new Error("cdn upload failed after 3 attempts");

    return {
      filekey,
      aesKeyHex,
      plainSize: plaintext.length,
      plainMd5,
      cipherSize: paddedCipherSize(plaintext.length),
      downloadEncryptedQueryParam: encryptedParam,
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
            aes_key: Buffer.from(uploaded.aesKeyHex).toString("base64"),
            encrypt_type: 1,
          },
          mid_size: uploaded.cipherSize,
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
            aes_key: Buffer.from(uploaded.aesKeyHex).toString("base64"),
            encrypt_type: 1,
          },
          video_size: uploaded.cipherSize,
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
            aes_key: Buffer.from(uploaded.aesKeyHex).toString("base64"),
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
