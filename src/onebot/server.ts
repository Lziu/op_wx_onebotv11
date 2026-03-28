import crypto from "node:crypto";
import http from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import { segmentsToCqString } from "../adapter/weixin-adapter.js";
import type { OneBotV11ServerConfig } from "../config.js";
import type { OneBotApiRequest, OneBotApiResponse, OneBotEvent, OneBotMessageSegment } from "../types/onebot.js";
import { Logger } from "../util/logger.js";
import { OneBotActionHandler } from "./action-handler.js";

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeMessageFormat(event: OneBotEvent, format: "array" | "string"): OneBotEvent {
  if (event.post_type !== "message") return event;
  if (format === "array") return event;
  return {
    ...event,
    message: segmentsToCqString(event.message as OneBotMessageSegment[]),
  } as OneBotEvent;
}

export class OneBotV11Server {
  private readonly logger = new Logger("op_wx_onebotv11:server", "info");
  private readonly actionHandler: OneBotActionHandler;
  private httpServer: http.Server | null = null;
  private wsUniversal: WebSocketServer | null = null;
  private wsApi: WebSocketServer | null = null;
  private wsEvent: WebSocketServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private reverseWsSockets = new Map<string, WebSocket>();
  private reverseWsReconnectTimers = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(private readonly config: OneBotV11ServerConfig) {
    this.actionHandler = new OneBotActionHandler(config.adapter);
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    if (!this.config.accessToken) return true;
    const auth = req.headers.authorization;
    const fromQuery = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("access_token");
    return auth === `Bearer ${this.config.accessToken}` || fromQuery === this.config.accessToken;
  }

  private async maybePostReverseHttp(event: OneBotEvent): Promise<void> {
    const urls = this.config.reverseHttp?.urls ?? [];
    if (urls.length === 0) return;
    const payload = JSON.stringify(normalizeMessageFormat(event, this.config.messagePostFormat || "array"));
    const signature = this.config.reverseHttp?.secret
      ? `sha1=${crypto.createHmac("sha1", this.config.reverseHttp.secret).update(payload).digest("hex")}`
      : undefined;
    await Promise.all(urls.map(async (url) => {
      try {
        await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(signature ? { "X-Signature": signature } : {}),
          },
          body: payload,
        });
      } catch (error) {
        this.logger.warn(`reverse http post failed: ${url} ${String(error)}`);
      }
    }));
  }

  private broadcastEvent(event: OneBotEvent): void {
    const normalized = normalizeMessageFormat(event, this.config.messagePostFormat || "array");
    const payload = JSON.stringify(normalized);
    for (const server of [this.wsUniversal, this.wsEvent]) {
      if (!server) continue;
      for (const client of server.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    }
    for (const socket of this.reverseWsSockets.values()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
    void this.maybePostReverseHttp(normalized);
  }

  private reverseWsHeaders(): Record<string, string> {
    const selfId = this.config.adapter.getSelfId() || "unknown";
    return {
      "X-Self-ID": selfId,
      "X-Client-Role": "Universal",
      "User-Agent": "op_wx_onebotv11/0.1.0",
      ...(this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {}),
    };
  }

  private clearReverseWsReconnect(url: string): void {
    const timer = this.reverseWsReconnectTimers.get(url);
    if (timer) {
      clearTimeout(timer);
      this.reverseWsReconnectTimers.delete(url);
    }
  }

  private scheduleReverseWsReconnect(url: string): void {
    if (!this.started || this.reverseWsReconnectTimers.has(url)) return;
    const delay = this.config.reverseWs?.reconnectIntervalMs ?? 5000;
    const timer = setTimeout(() => {
      this.reverseWsReconnectTimers.delete(url);
      void this.connectReverseWs(url);
    }, delay);
    this.reverseWsReconnectTimers.set(url, timer);
  }

  private async connectReverseWs(url: string): Promise<void> {
    if (!this.started) return;
    const existing = this.reverseWsSockets.get(url);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.clearReverseWsReconnect(url);

    const socket = new WebSocket(url, { headers: this.reverseWsHeaders() });
    this.reverseWsSockets.set(url, socket);

    socket.on("open", () => {
      this.logger.info(`reverse ws connected: ${url}`);
    });

    socket.on("message", async (data) => {
      try {
        const request = JSON.parse(String(data)) as OneBotApiRequest;
        const response = await this.handleApiRequest(request);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(response));
        }
      } catch (error) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            status: "failed",
            retcode: 400,
            data: null,
            wording: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    });

    socket.on("error", (error) => {
      this.logger.warn(`reverse ws error: ${url} ${String(error)}`);
    });

    socket.on("close", () => {
      const current = this.reverseWsSockets.get(url);
      if (current === socket) {
        this.reverseWsSockets.delete(url);
      }
      this.logger.warn(`reverse ws closed: ${url}`);
      this.scheduleReverseWsReconnect(url);
    });
  }

  private async startReverseWs(): Promise<void> {
    const urls = this.config.reverseWs?.urls ?? [];
    await Promise.all(urls.map((url) => this.connectReverseWs(url)));
  }

  private setupHeartbeat(): void {
    const interval = this.config.heartbeatIntervalMs ?? 15000;
    this.heartbeatTimer = setInterval(() => {
      this.broadcastEvent(this.config.adapter.createHeartbeat(interval));
    }, interval);
  }

  private async handleApiRequest(request: OneBotApiRequest): Promise<OneBotApiResponse> {
    return this.actionHandler.handle(request);
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    this.started = true;

    this.unsubscribe = this.config.adapter.onEvent((event) => this.broadcastEvent(event));

    this.httpServer = http.createServer(async (req, res) => {
      if (!this.isAuthorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "failed", retcode: 401, data: null, wording: "unauthorized" }));
        return;
      }

      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "op_wx_onebotv11" }));
        return;
      }

      if (!["GET", "POST"].includes(req.method || "")) {
        res.writeHead(405).end();
        return;
      }

      const action = url.pathname.replace(/^\//, "");
      if (!action) {
        res.writeHead(404).end();
        return;
      }

      const queryParams = req.method === "GET" ? Object.fromEntries(url.searchParams.entries()) : {};
      const bodyText = req.method === "POST" ? await parseBody(req) : "";
      let bodyParams: Record<string, unknown> = {};
      if (bodyText) {
        try {
          bodyParams = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          bodyParams = {};
        }
      }
      const result = await this.handleApiRequest({ action, params: { ...queryParams, ...bodyParams } });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });

    this.wsUniversal = new WebSocketServer({ noServer: true });
    this.wsApi = new WebSocketServer({ noServer: true });
    this.wsEvent = new WebSocketServer({ noServer: true });

    const setupApiWs = (server: WebSocketServer) => {
      server.on("connection", (socket, req) => {
        if (!this.isAuthorized(req)) {
          socket.close(1008, "unauthorized");
          return;
        }
        socket.on("message", async (data) => {
          try {
            const request = JSON.parse(String(data)) as OneBotApiRequest;
            const response = await this.handleApiRequest(request);
            socket.send(JSON.stringify(response));
          } catch (error) {
            socket.send(JSON.stringify({
              status: "failed",
              retcode: 400,
              data: null,
              wording: error instanceof Error ? error.message : String(error),
            }));
          }
        });
      });
    };

    setupApiWs(this.wsUniversal);
    setupApiWs(this.wsApi);

    this.wsEvent.on("connection", (socket, req) => {
      if (!this.isAuthorized(req)) {
        socket.close(1008, "unauthorized");
      }
    });

    this.httpServer.on("upgrade", (req, socket, head) => {
      if (!this.isAuthorized(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const wsRoot = this.config.ws?.path || "/";
      const prefix = wsRoot === "/" ? "" : wsRoot;
      const target = url.pathname;
      const match = target === wsRoot
        ? this.wsUniversal
        : target === `${prefix}/api`
          ? this.wsApi
          : target === `${prefix}/event`
            ? this.wsEvent
            : null;
      if (!match) {
        socket.destroy();
        return;
      }
      match.handleUpgrade(req, socket, head, (client) => match.emit("connection", client, req));
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(this.config.http?.port || 5700, this.config.http?.host || "127.0.0.1", () => resolve());
    });

    await this.startReverseWs();
    this.setupHeartbeat();
    this.broadcastEvent({
      time: Math.floor(Date.now() / 1000),
      self_id: this.config.adapter.getSelfId() || "unknown",
      post_type: "meta_event",
      meta_event_type: "lifecycle",
      sub_type: "connect",
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const timer of this.reverseWsReconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reverseWsReconnectTimers.clear();
    await Promise.all([
      ...Array.from(this.reverseWsSockets.values()).map((socket) => new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once("close", () => resolve());
        socket.close();
      })),
      new Promise<void>((resolve) => this.wsUniversal?.close(() => resolve()) ?? resolve()),
      new Promise<void>((resolve) => this.wsApi?.close(() => resolve()) ?? resolve()),
      new Promise<void>((resolve) => this.wsEvent?.close(() => resolve()) ?? resolve()),
      new Promise<void>((resolve) => this.httpServer?.close(() => resolve()) ?? resolve())
    ]);
    this.reverseWsSockets.clear();
    this.wsUniversal = null;
    this.wsApi = null;
    this.wsEvent = null;
    this.httpServer = null;
  }
}
