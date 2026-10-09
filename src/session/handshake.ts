import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import type { RandomSource } from "../util/random.js";
import type { JoinRejectReason } from "./messages.js";

export class JoinCodeError extends Error {
  override readonly name = "JoinCodeError";
}
export class JoinRejectedError extends Error {
  override readonly name = "JoinRejectedError";
  constructor(readonly reason: JoinRejectReason) {
    super(`Session join rejected: ${reason}`);
  }
}
export class HandshakeError extends Error {
  override readonly name = "HandshakeError";
}

export function generateJoinCode(rs: RandomSource): string {
  for (;;) {
    const value = Buffer.from(rs.bytes(5)).readUIntBE(0, 5);
    if (value >= 1_000_000_000_000) continue;
    const digits = value.toString().padStart(12, "0");
    return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
}

export function normalizeJoinCode(s: string): string {
  const code = s.replace(/[ -]/g, "");
  if (!/^\d{12}$/.test(code)) throw new JoinCodeError("Join code must contain exactly 12 digits");
  return code;
}

const PRIVATE_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const PUBLIC_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function createEphemeral(rs: RandomSource): { privateKey: KeyObject; pub: Buffer } {
  // Import random private bytes so simulations also control X25519's randomness.
  const privateKey = createPrivateKey({
    key: Buffer.concat([PRIVATE_PREFIX, Buffer.from(rs.bytes(32))]),
    format: "der",
    type: "pkcs8",
  });
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, pub };
}

export interface KeyMaterial {
  th: Buffer;
  confirmS: Buffer;
  confirmM: Buffer;
  kM2S: Buffer;
  kS2M: Buffer;
}
export interface DeriveKeysOptions {
  privateKey: KeyObject;
  remotePub: Buffer;
  subPub: Buffer;
  subNonce: Buffer;
  masterPub: Buffer;
  masterNonce: Buffer;
  device: string;
  code: string;
}

export function deriveKeys(o: DeriveKeysOptions): KeyMaterial {
  if (
    o.remotePub.length !== 32 ||
    o.subPub.length !== 32 ||
    o.masterPub.length !== 32 ||
    o.subNonce.length !== 16 ||
    o.masterNonce.length !== 16
  ) {
    throw new HandshakeError("Invalid X25519 public key or handshake nonce length");
  }
  const code = normalizeJoinCode(o.code);
  try {
    const shared = diffieHellman({
      privateKey: o.privateKey,
      publicKey: createPublicKey({
        key: Buffer.concat([PUBLIC_PREFIX, o.remotePub]),
        format: "der",
        type: "spki",
      }),
    });
    const th = createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from("skep-session-v1"),
          o.subPub,
          o.subNonce,
          o.masterPub,
          o.masterNonce,
          Buffer.from(o.device, "utf8"),
        ]),
      )
      .digest();
    const salt = createHash("sha256").update(`skep-join-code${code}`, "ascii").digest();
    const okm = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        salt,
        Buffer.concat([Buffer.from("skep-session-v1 keys"), th]),
        128,
      ),
    );
    shared.fill(0);
    return {
      th,
      confirmS: okm.subarray(0, 32),
      confirmM: okm.subarray(32, 64),
      kM2S: okm.subarray(64, 96),
      kS2M: okm.subarray(96, 128),
    };
  } catch (cause) {
    throw new HandshakeError("Unable to derive session keys from the supplied X25519 key", {
      cause,
    });
  }
}

export function confirmation(keys: KeyMaterial, side: "sub" | "master"): Buffer {
  return createHmac("sha256", side === "sub" ? keys.confirmS : keys.confirmM)
    .update(side)
    .update(keys.th)
    .digest();
}

export function fingerprint(th: Buffer): string {
  if (th.length !== 32) throw new HandshakeError("Transcript hash must be 32 bytes");
  return th.subarray(0, 8).toString("hex").match(/.{4}/g)?.join("-") ?? "";
}
