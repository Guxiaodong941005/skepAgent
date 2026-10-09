import { expect, it } from "vitest";
import { assertSamePath, PathMismatchError } from "./path.js";

it("rejects a change of address family", () => {
  expect(() =>
    assertSamePath({ address: "127.0.0.1", family: "IPv4" }, { address: "::1", family: "IPv6" }),
  ).toThrow(PathMismatchError);
  expect(() =>
    assertSamePath(
      { address: "127.0.0.1", family: "IPv4" },
      { address: "127.0.0.2", family: "IPv4" },
    ),
  ).not.toThrow();
});
