import { createHash, randomBytes } from "node:crypto";

export const generateUuidV7 = (): string => {
  const timestamp = BigInt(Date.now());
  const bytes = randomBytes(16);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const hashToken = (rawToken: string): string => {
  return createHash("sha256").update(rawToken).digest("hex");
};

export const createOpaqueToken = (): string => {
  return randomBytes(48).toString("base64url");
};

export const createPkceChallenge = (codeVerifier: string): string => {
  return createHash("sha256").update(codeVerifier).digest("base64url");
};
