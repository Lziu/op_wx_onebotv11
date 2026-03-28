# op_wx_onebotv11

一个偏实用向的 **OneBot v11 微信私聊适配库**。

简单说，就是把**官方 OpenClaw Weixin 那套登录 / 收消息 / 发文本**流程，整理成一个更好接入的 OneBot v11 形态，方便你接自己的机器人框架。

> 目前定位很明确：**只先把“微信私聊 + 文本收发”这条链路做好。**
> 群聊、复杂媒体、花里胡哨的能力，暂时都不碰。

---

## 现在能干嘛

- 二维码登录
- 微信私聊长轮询收消息
- OneBot v11 HTTP API
- OneBot v11 正向 WebSocket（`/`、`/api`、`/event`）
- 上报 `message.private`
- 上报 `meta_event.lifecycle` / `meta_event.heartbeat`
- 发文本消息
- 收图片 / 语音 / 文件 / 视频
- 自动把消息转成 OneBot 消息段

---

## 现在不能干嘛

先说清楚，免得踩坑：

- **不支持图片 / GIF / 视频 / 文件发送**
- 不支持语音发送（record outbound）
- 不支持群聊相关 API / 事件
- 不支持好友 / 群 / 群成员列表查询
- 不支持撤回 / 合并转发 / 历史消息
- 不支持反向 WebSocket

如果你现在的目标是：

> “让 QQ/OneBot 风格的上层框架能接微信私聊，并且稳定收文本、发文本”

那这个库就是对路的。

---

## 安装

```bash
npm install op-wx-onebotv11
```

---

## 快速开始

```ts
import { WeixinAdapter, OneBotV11Server } from "op-wx-onebotv11";

const adapter = new WeixinAdapter({
  storageDir: "./.data/op_wx_onebotv11"
});

const qr = await adapter.startQrLogin();
console.log("扫码地址：", qr.qrcodeUrl);

await adapter.waitForQrLogin(qr.sessionKey, {
  printQrInTerminal: true
});

await adapter.start();

const server = new OneBotV11Server({
  adapter,
  accessToken: "change-me",
  http: { host: "127.0.0.1", port: 5700 },
  ws: { path: "/" },
  heartbeatIntervalMs: 15000
});

await server.start();
```

---

## HTTP / WebSocket 入口

HTTP 默认动作入口：

- `POST /{action}`

正向 WebSocket 支持：

- `/`：API + 事件混合
- `/api`：只走 API
- `/event`：只推事件

---

## 已实现动作

- `send_private_msg`
- `send_msg`（仅 `message_type=private`）
- `get_login_info`
- `get_status`
- `get_version_info`
- `can_send_image`（当前固定返回 `false`）
- `can_send_record`

---

## 一些你最好先知道的事

### 1）`self_id` / `user_id` 是字符串

这不是 QQ 机器人，所以：

- `self_id`
- `user_id`

天然就是字符串，不是数字。

比如这种形式很正常：

```txt
65d0fe0b9cad@im.bot
o9cq80-xxxxx@im.wechat
```

### 2）字符串消息默认会解析 CQ

如果你传的是字符串消息，默认会按 CQ 码去拆。

如果你就是想老老实实发纯文本，请传：

```ts
auto_escape: true
```

### 3）当前重点是“能用”，不是“全能”

这个库现在的方向不是把所有 OneBot 能力都硬补出来，而是：

> **只对微信私聊里当前能稳定落地的那部分能力负责。**

所以媒体出站先砍掉，是故意的，不是忘了写。

---

## 适合谁用

适合这几类场景：

- 想把微信私聊接到 OneBot v11 上层框架里
- 不想继续依赖桌面自动化那种脆弱方案
- 能接受“先文本稳定，再慢慢补别的能力”

不太适合：

- 一上来就要群聊全家桶
- 必须稳定发 GIF / 图片 / 视频
- 想一步到位把所有 OneBot 标准动作全补齐

---

## 能力说明

更细的能力对照表在：

- [SUPPORTED.md](./SUPPORTED.md)

---

## 现阶段建议

如果你准备把这个库接进自己的项目，我建议你先按这个顺序来：

1. 先跑通登录
2. 先确认私聊收消息正常
3. 先只接文本发送
4. 上层把媒体出站当成“不支持”处理

这样最省时间，也最不容易把问题搞复杂。

---

## 最后

这个项目现在不是“大而全”的微信机器人方案，  
而是一个**先把私聊文本链路做稳**的 OneBot v11 适配层。

如果你也认同这个路线，那它现在就已经能开始用了。
