# 能力对照

`op_wx_onebotv11` 目前只聚焦在 **官方 OpenClaw Weixin 私聊能力**，只实现了能比较老实映射到 OneBot v11 的那部分功能。

## 当前已支持的 OneBot v11 动作

- `send_private_msg`
- `send_msg`（仅支持 `message_type=private`）
- `get_login_info`
- `get_status`
- `get_version_info`
- `can_send_image`（当前固定返回 `false`）
- `can_send_record`

## 当前已支持的 OneBot v11 事件

- `message.private`
- `meta_event.lifecycle`
- `meta_event.heartbeat`

## 消息能力映射

### 入站

- 文本 -> `text`
- 图片 -> `image`
- 语音（可转文字）-> `text`
- 语音（二进制）-> `record`
- 文件 -> `file`
- 视频 -> `video`

### 出站

- `text` -> 官方 `sendmessage`
- `image` -> 暂未实现
- `video` -> 暂未实现
- `file` -> 暂未实现
- `record` -> 暂未实现

## 当前版本明确不支持

下面这些能力当前不会对外暴露：

- 群聊相关动作 / 事件
- 好友 / 群 / 群成员列表查询
- 撤回 / 删除 / 历史消息 / 合并转发
- 图片 / GIF / 视频 / 文件发送
- 语音发送

## 备注

- `self_id` 和 `user_id` 都是字符串，不会强行转成数字。
- 字符串消息默认支持 CQ 码解析；如果要按纯文本发送，可以设置 `auto_escape=true`。
- 当前实现走的是官方 OpenClaw Weixin 这套消息链路，不是旧的非官方 `uploadmedia` 方案。
