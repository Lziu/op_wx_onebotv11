import type { WeixinAdapter } from "../adapter/weixin-adapter.js";
import type {
  OneBotApiRequest,
  OneBotApiResponse,
  OneBotSendMsgParams,
  OneBotSendPrivateMsgParams,
} from "../types/onebot.js";
import { failed, ok } from "../types/onebot.js";

const UNSUPPORTED_ACTIONS = new Set([
  "send_group_msg",
  "delete_msg",
  "get_msg",
  "get_forward_msg",
  "send_like",
  "set_group_kick",
  "set_group_ban",
  "set_group_anonymous_ban",
  "set_group_whole_ban",
  "set_group_admin",
  "set_group_anonymous",
  "set_group_card",
  "set_group_name",
  "set_group_leave",
  "set_group_special_title",
  "set_friend_add_request",
  "set_group_add_request",
  "get_friend_list",
  "get_stranger_info",
  "get_group_info",
  "get_group_list",
  "get_group_member_info",
  "get_group_member_list",
  "get_group_honor_info",
  "get_cookies",
  "get_csrf_token",
  "get_credentials",
  "get_record",
  "get_image",
  "can_send_group_msg",
  "get_essence_msg_list"
]);

export class OneBotActionHandler {
  constructor(private readonly adapter: WeixinAdapter) {}

  private requireParams<T>(params: Record<string, unknown> | undefined): T {
    return (params ?? {}) as unknown as T;
  }

  async handle(request: OneBotApiRequest): Promise<OneBotApiResponse> {
    const { action, params, echo } = request;

    if (UNSUPPORTED_ACTIONS.has(action)) {
      return failed("unsupported by current weixin direct-only adapter", 10004, echo);
    }

    try {
      switch (action) {
        case "send_private_msg": {
          const p = this.requireParams<OneBotSendPrivateMsgParams>(params);
          const result = await this.adapter.sendPrivateMessage(p.user_id, p.message, { autoEscape: p.auto_escape });
          return ok(result, echo);
        }
        case "send_msg": {
          const p = this.requireParams<OneBotSendMsgParams>(params);
          if (p.message_type && p.message_type !== "private") {
            return failed("only private message is supported", 10004, echo);
          }
          const result = await this.adapter.sendPrivateMessage(p.user_id, p.message, { autoEscape: p.auto_escape });
          return ok(result, echo);
        }
        case "get_login_info":
          return ok(await this.adapter.getLoginInfo(), echo);
        case "get_status":
          return ok(this.adapter.getStatus(), echo);
        case "get_version_info":
          return ok({
            app_name: "op_wx_onebotv11",
            app_version: "0.1.0",
            protocol_version: "v11",
          }, echo);
        case "can_send_image":
          return ok({ yes: this.adapter.canSendImage() }, echo);
        case "can_send_record":
          return ok({ yes: this.adapter.canSendRecord() }, echo);
        default:
          return failed(`unsupported action: ${action}`, 1404, echo);
      }
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error), 100, echo);
    }
  }
}
