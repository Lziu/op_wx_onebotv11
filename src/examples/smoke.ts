import { OneBotV11Server } from "../onebot/server.js";
import { WeixinAdapter } from "../adapter/weixin-adapter.js";

async function main(): Promise<void> {
  const storageDir = process.env.OP_WX_STORAGE_DIR || "./.data/op_wx_onebotv11";
  const accessToken = process.env.OP_WX_ACCESS_TOKEN || "change-me";
  const host = process.env.OP_WX_HOST || "127.0.0.1";
  const port = Number(process.env.OP_WX_PORT || "5700");

  const adapter = new WeixinAdapter({
    storageDir,
    debug: true,
  });

  if (!adapter.getStatus().good) {
    console.log("[smoke] no saved login session, starting QR login...");
    const qr = await adapter.startQrLogin();
    console.log(`[smoke] qrcode url: ${qr.qrcodeUrl}`);
    console.log("[smoke] please scan the QR code with WeChat now.");
    await adapter.waitForQrLogin(qr.sessionKey, {
      printQrInTerminal: true,
      timeoutMs: 8 * 60_000,
    });
    console.log("[smoke] QR login success.");
  } else {
    console.log("[smoke] using existing saved login session.");
  }

  await adapter.start();
  console.log("[smoke] adapter started.");

  const server = new OneBotV11Server({
    adapter,
    accessToken,
    http: { host, port },
    ws: { path: "/" },
    heartbeatIntervalMs: 15000,
    messagePostFormat: "array",
  });

  adapter.onEvent((event) => {
    console.log("[event]", JSON.stringify(event, null, 2));
  });

  await server.start();
  const loginInfo = await adapter.getLoginInfo();

  console.log(`[smoke] OneBot HTTP ready at http://${host}:${port}`);
  console.log(`[smoke] OneBot WS ready at ws://${host}:${port}/event`);
  console.log(`[smoke] access token: ${accessToken}`);
  console.log(`[smoke] self: ${loginInfo.user_id} (${loginInfo.nickname})`);
  console.log("[smoke] press Ctrl+C to stop.");

  const shutdown = async (): Promise<void> => {
    console.log("\n[smoke] shutting down...");
    await server.stop().catch((error) => console.error("[smoke] server stop error:", error));
    await adapter.stop().catch((error) => console.error("[smoke] adapter stop error:", error));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[smoke] fatal error:", error);
  process.exit(1);
});
