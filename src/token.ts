import { gzipSync } from "node:zlib";
import type { TrustReceipt } from "./receipt.js";

export function encodeReceipt(receipt: TrustReceipt): string {
  const json = Buffer.from(JSON.stringify(receipt), "utf8");
  return gzipSync(json, { level: 9 }).toString("base64url");
}
