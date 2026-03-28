export type PrimitiveId = string | number;

export interface OneBotMessageSegment {
  type: string;
  data: Record<string, string>;
}

export type OneBotMessage = string | OneBotMessageSegment[];

export interface OneBotApiRequest {
  action: string;
  params?: Record<string, unknown>;
  echo?: unknown;
}

export interface OneBotApiResponse<T = unknown> {
  status: "ok" | "async" | "failed";
  retcode: number;
  data: T | null;
  message?: string;
  wording?: string;
  echo?: unknown;
}

export interface OneBotSender {
  user_id: PrimitiveId;
  nickname?: string;
  card?: string;
  sex?: "male" | "female" | "unknown";
  age?: number;
}

export interface OneBotMessageEvent {
  time: number;
  self_id: PrimitiveId;
  post_type: "message";
  message_type: "private";
  sub_type: "friend" | "other";
  message_id: PrimitiveId;
  user_id: PrimitiveId;
  message: OneBotMessage | OneBotMessageSegment[];
  raw_message: string;
  font: number;
  sender: OneBotSender;
}

export interface OneBotMetaLifecycleEvent {
  time: number;
  self_id: PrimitiveId;
  post_type: "meta_event";
  meta_event_type: "lifecycle";
  sub_type: "connect" | "enable" | "disable";
}

export interface OneBotMetaHeartbeatEvent {
  time: number;
  self_id: PrimitiveId;
  post_type: "meta_event";
  meta_event_type: "heartbeat";
  interval: number;
  status: {
    online: boolean;
    good: boolean;
    stat: Record<string, number>;
  };
}

export type OneBotEvent = OneBotMessageEvent | OneBotMetaLifecycleEvent | OneBotMetaHeartbeatEvent;

export interface OneBotSendPrivateMsgParams {
  user_id: PrimitiveId;
  message: OneBotMessage;
  auto_escape?: boolean;
}

export interface OneBotSendMsgParams extends OneBotSendPrivateMsgParams {
  message_type?: "private" | "group";
  group_id?: PrimitiveId;
}

export interface OneBotGetStatusData {
  online: boolean;
  good: boolean;
  stat: Record<string, number>;
}

export interface OneBotLoginInfoData {
  user_id: PrimitiveId;
  nickname: string;
}

export interface OneBotVersionInfoData {
  app_name: string;
  app_version: string;
  protocol_version: "v11";
}

export function ok<T>(data: T, echo?: unknown): OneBotApiResponse<T> {
  return { status: "ok", retcode: 0, data, echo };
}

export function failed(wording: string, retcode = 10004, echo?: unknown, message = "failed"): OneBotApiResponse<null> {
  return { status: "failed", retcode, data: null, wording, message, echo };
}
