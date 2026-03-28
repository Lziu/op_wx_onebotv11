import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const DEFAULT_BOT_TYPE = "3";

export interface WeixinAdapterConfig {
  baseUrl?: string;
  cdnBaseUrl?: string;
  storageDir?: string;
  requestTimeoutMs?: number;
  longPollTimeoutMs?: number;
  debug?: boolean;
}

export interface OneBotHttpConfig {
  host?: string;
  port?: number;
}

export interface OneBotWsConfig {
  path?: string;
}

export interface OneBotReverseHttpConfig {
  urls?: string[];
  secret?: string;
}

export interface OneBotV11ServerConfig {
  adapter: import("./adapter/weixin-adapter.js").WeixinAdapter;
  accessToken?: string;
  http?: OneBotHttpConfig;
  ws?: OneBotWsConfig;
  reverseHttp?: OneBotReverseHttpConfig;
  heartbeatIntervalMs?: number;
  messagePostFormat?: "array" | "string";
}

export function resolveDefaultStorageDir(): string {
  return path.join(homedir(), ".op_wx_onebotv11");
}
