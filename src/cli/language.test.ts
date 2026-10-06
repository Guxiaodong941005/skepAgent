import { describe, expect, it } from "vitest";
import { isPredominantlyNonLatin } from "./language.js";

describe("isPredominantlyNonLatin", () => {
  it("is false for English prose", () => {
    expect(isPredominantlyNonLatin("Fix the login redirect when the session expires")).toBe(false);
  });

  it("is false when there are no letters", () => {
    expect(isPredominantlyNonLatin("1234 --- ...")).toBe(false);
    expect(isPredominantlyNonLatin("")).toBe(false);
  });

  it("is true for predominantly Chinese text", () => {
    expect(isPredominantlyNonLatin("修复登录跳转，会话过期时返回首页")).toBe(true);
  });

  it("is false when Latin letters are the majority", () => {
    // A short Chinese quote inside an otherwise English task body.
    const text = "Handle the error message 「失败」 returned by the gateway and retry once";
    expect(isPredominantlyNonLatin(text)).toBe(false);
  });

  it("counts letters only, so surrounding punctuation does not dilute the script", () => {
    expect(isPredominantlyNonLatin("修复登录！！！")).toBe(true);
  });

  it("treats other non-Latin scripts the same way", () => {
    expect(isPredominantlyNonLatin("Исправь ошибку входа")).toBe(true);
  });
});
