// ed25519 signing rail — the Trust Receipt is signed so it's tamper-evident
// and verifiable offline by anyone (no AgentReceipt server in the path).
// Key derives from AGENTRECEIPT_SIGNING_SEED, else a local key in ~/.agentreceipt.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stableStringify, type JsonValue } from "./stable-json.js";

export interface SignaturePayload {
  algo: "ed25519";
  fingerprint: string;
  digest: string;
  signature: string;
  publicKeySpki: string;
  signedAt: number;
}

interface KeyBundle {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  fingerprint: string;
  publicKeySpki: string;
}

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
let cached: KeyBundle | null = null;

function fpOf(pub: crypto.KeyObject): { fingerprint: string; spki: string } {
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  return {
    spki: der.toString("base64url"),
    fingerprint: crypto.createHash("sha256").update(der).digest("base64url").slice(0, 16),
  };
}

function fromSeed(seed: Buffer): KeyBundle {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey);
  const { fingerprint, spki } = fpOf(publicKey);
  return { privateKey, publicKey, fingerprint, publicKeySpki: spki };
}

function keyFile(): string {
  const dir = process.env.AGENTRECEIPT_HOME ?? path.join(os.homedir(), ".agentreceipt");
  return path.join(dir, "key.json");
}

export function loadKey(): KeyBundle {
  if (cached) return cached;
  const seedEnv = process.env.AGENTRECEIPT_SIGNING_SEED;
  if (seedEnv && seedEnv.length >= 16) {
    cached = fromSeed(crypto.createHash("sha256").update(seedEnv).digest());
    return cached;
  }
  const file = keyFile();
  try {
    const { seedB64 } = JSON.parse(fs.readFileSync(file, "utf8")) as { seedB64: string };
    cached = fromSeed(Buffer.from(seedB64, "base64"));
    return cached;
  } catch {
    /* generate */
  }
  const seed = crypto.randomBytes(32);
  cached = fromSeed(seed);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ seedB64: seed.toString("base64") }), { mode: 0o600 });
  } catch {
    /* read-only fs — ephemeral */
  }
  return cached;
}

export function sign(document: JsonValue): SignaturePayload {
  const { privateKey, fingerprint, publicKeySpki } = loadKey();
  const msg = stableStringify(document);
  return {
    algo: "ed25519",
    fingerprint,
    digest: crypto.createHash("sha256").update(msg).digest("hex"),
    signature: crypto.sign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64url"),
    publicKeySpki,
    signedAt: Date.now(),
  };
}

export function verify(document: JsonValue, p: SignaturePayload): { valid: boolean; reason?: string } {
  try {
    const msg = stableStringify(document);
    if (crypto.createHash("sha256").update(msg).digest("hex") !== p.digest)
      return { valid: false, reason: "digest mismatch — document altered after signing" };
    const pub = crypto.createPublicKey({
      key: Buffer.from(p.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    if (fpOf(pub).fingerprint !== p.fingerprint)
      return { valid: false, reason: "fingerprint mismatch" };
    const ok = crypto.verify(null, Buffer.from(msg, "utf8"), pub, Buffer.from(p.signature, "base64url"));
    return ok ? { valid: true } : { valid: false, reason: "signature invalid" };
  } catch (e) {
    return { valid: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
