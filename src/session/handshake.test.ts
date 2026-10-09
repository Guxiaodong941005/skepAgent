import { createHash, createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  confirmation,
  createEphemeral,
  deriveKeys,
  fingerprint,
  generateJoinCode,
  JoinCodeError,
  normalizeJoinCode,
} from "./handshake.js";


function seededBytes(seed: number): { bytes(n: number): Uint8Array } {
  let x = seed >>> 0 || 1;
  return {
    bytes(n: number) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        out[i] = x & 0xff;
      }
      return out;
    },
  };
}

describe("join codes", () => {
  it("rejection-samples five bytes and formats twelve decimal digits", () => {
    const bytes = vi
      .fn()
      .mockReturnValueOnce(Buffer.alloc(5, 255))
      .mockReturnValueOnce(Buffer.from([0, 0, 0, 0, 42]));
    expect(generateJoinCode({ bytes })).toBe("0000-0000-0042");
    expect(bytes.mock.calls).toEqual([[5], [5]]);
    expect(generateJoinCode(seededBytes(1))).toMatch(/^\d{4}-\d{4}-\d{4}$/);
  });

  it("normalizes spaces and hyphens and rejects other input", () => {
    expect(normalizeJoinCode(" 1234 - 5678- 9012 ")).toBe("123456789012");
    for (const value of [
      "12345678901",
      "1234567890123",
      "1234_5678_9012",
      "１２３４５６７８９０１２",
      "12345678901x",
      "123456789012\n",
    ]) {
      expect(() => normalizeJoinCode(value)).toThrow(JoinCodeError);
    }
  });
});

describe("temporary HKDF handshake", () => {
  it("derives identical directional keys and fingerprint, but a different MAC key for a wrong code", () => {
    const rng = seededBytes(0x68616e64);
    const sub = createEphemeral(rng);
    const master = createEphemeral(rng);
    const common = {
      subPub: sub.pub,
      subNonce: Buffer.from(rng.bytes(16)),
      masterPub: master.pub,
      masterNonce: Buffer.from(rng.bytes(16)),
      device: "app",
      code: "1234-5678-9012",
    };
    const a = deriveKeys({ ...common, privateKey: sub.privateKey, remotePub: master.pub });
    const b = deriveKeys({ ...common, privateKey: master.privateKey, remotePub: sub.pub });
    expect(a).toEqual(b);
    expect(fingerprint(a.th)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(fingerprint(a.th)).toBe(fingerprint(b.th));
    expect(a.kM2S).not.toEqual(a.kS2M);
    const wrong = deriveKeys({
      ...common,
      privateKey: sub.privateKey,
      remotePub: master.pub,
      code: "000000000000",
    });
    expect(wrong.confirmS).not.toEqual(a.confirmS);
    expect(wrong.th).toEqual(a.th);
    expect(confirmation(a, "sub")).toEqual(
      createHmac("sha256", a.confirmS).update("sub").update(a.th).digest(),
    );
  });

  it("matches the RFC 7748 X25519 vector and specified transcript/HKDF encoding", () => {
    const alice = Buffer.from(
      "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
      "hex",
    );
    const bob = Buffer.from(
      "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
      "hex",
    );
    const sub = createEphemeral({ bytes: () => alice });
    const master = createEphemeral({ bytes: () => bob });
    expect(sub.pub.toString("hex")).toBe(
      "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
    );
    expect(master.pub.toString("hex")).toBe(
      "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
    );
    const th = createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from("skep-session-v1"),
          sub.pub,
          Buffer.alloc(16, 1),
          master.pub,
          Buffer.alloc(16, 2),
          Buffer.from("app"),
        ]),
      )
      .digest();
    const expected = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742", "hex"),
        createHash("sha256").update("skep-join-code123456789012").digest(),
        Buffer.concat([Buffer.from("skep-session-v1 keys"), th]),
        128,
      ),
    );
    const actual = deriveKeys({
      privateKey: sub.privateKey,
      remotePub: master.pub,
      subPub: sub.pub,
      masterPub: master.pub,
      subNonce: Buffer.alloc(16, 1),
      masterNonce: Buffer.alloc(16, 2),
      device: "app",
      code: "123456789012",
    });
    expect(actual.th).toEqual(th);
    expect(Buffer.concat([actual.confirmS, actual.confirmM, actual.kM2S, actual.kS2M])).toEqual(
      expected,
    );
    expect(() =>
      deriveKeys({
        privateKey: sub.privateKey,
        remotePub: Buffer.alloc(32),
        subPub: sub.pub,
        masterPub: master.pub,
        subNonce: Buffer.alloc(16),
        masterNonce: Buffer.alloc(16),
        device: "app",
        code: "123456789012",
      }),
    ).toThrow("Unable to derive");
  });
});
