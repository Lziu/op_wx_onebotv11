import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

export function md5Hex(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("hex");
}

export function encryptAesEcb(buffer: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

export function decryptAesEcb(buffer: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

export function paddedCipherSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16;
}

export function randomHexKey(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
