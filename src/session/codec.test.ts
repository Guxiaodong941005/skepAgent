import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, FrameError, MAX_FRAME } from "./codec.js";

describe("session framing", () => {
  it("decodes split headers, split payloads and coalesced frames", () => {
    const values = [Buffer.from("hello"), Buffer.from("world"), Buffer.alloc(MAX_FRAME, 7)];
    const encoded = Buffer.concat(values.map(encodeFrame));
    const decoder = new FrameDecoder();
    const frames: Buffer[] = [];
    for (let i = 0; i < encoded.length; i += 3)
      frames.push(...decoder.push(encoded.subarray(i, i + 3)));
    expect(frames).toEqual(values);
    expect(new FrameDecoder().push(encoded)).toEqual(values);
  });

  it.each([0, MAX_FRAME + 1, 0xffff_ffff])(
    "rejects length %i and keeps the failure sticky",
    (length) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length);
      const decoder = new FrameDecoder();
      expect(() => decoder.push(header)).toThrow(FrameError);
      expect(() => decoder.push(encodeFrame(Buffer.from("valid")))).toThrow(FrameError);
      expect(() => decoder.push(Buffer.alloc(0))).toThrow(FrameError);
    },
  );

  it("validates outbound lengths", () => {
    expect(() => encodeFrame(Buffer.alloc(0))).toThrow(FrameError);
    expect(() => encodeFrame(Buffer.alloc(MAX_FRAME + 1))).toThrow(FrameError);
  });
});
