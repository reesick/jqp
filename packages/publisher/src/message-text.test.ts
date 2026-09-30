import { describe, expect, it } from "vitest";
import { normalizeMessageText, normalizeOptionalMessage } from "./message-text.js";

describe("normalizeMessageText", () => {
  it("strips bold and italic markers but keeps the words", () => {
    expect(normalizeMessageText("Hey! **Here** is your *free* guide")).toBe("Hey! Here is your free guide");
    expect(normalizeMessageText("__important__ and ~~old~~")).toBe("important and old");
  });

  it("turns literal backslash-n into real line breaks", () => {
    expect(normalizeMessageText("Line one\\nLine two")).toBe("Line one\nLine two");
    expect(normalizeMessageText("a\\r\\nb")).toBe("a\nb");
  });

  it("normalises Windows line endings and collapses blank runs", () => {
    expect(normalizeMessageText("a\r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
  });

  it("converts markdown bullets and removes headings and quotes", () => {
    expect(normalizeMessageText("# Title\n- one\n- two\n> quoted")).toBe("Title\n• one\n• two\nquoted");
  });

  it("replaces double hyphens used as dashes, but not inside words or URLs", () => {
    expect(normalizeMessageText("wait -- really")).toBe("wait – really");
    expect(normalizeMessageText("see https://example.com/a--b for details")).toContain("https://example.com/a--b");
  });

  it("rewrites markdown links to label plus URL", () => {
    expect(normalizeMessageText("Grab it [here](https://example.com/guide)")).toBe("Grab it here https://example.com/guide");
  });

  it("strips inline code backticks", () => {
    expect(normalizeMessageText("use `LINK` to get it")).toBe("use LINK to get it");
  });

  it("leaves URLs, placeholders, underscores in words and plain text alone", () => {
    const text = "Hi {name}, your link: https://example.com/a_b_c?x=1&y=2 snake_case_word 5 * 3";
    expect(normalizeMessageText(text)).toBe(text);
  });

  it("removes zero-width characters and non-breaking spaces", () => {
    expect(normalizeMessageText("hi​ there")).toBe("hi there");
  });

  it("collapses to one line for button labels", () => {
    expect(normalizeMessageText("Send me\nthe guide", { singleLine: true })).toBe("Send me the guide");
  });

  it("is idempotent", () => {
    const once = normalizeMessageText("**Hi**\\n- a\\n- b -- ok");
    expect(normalizeMessageText(once)).toBe(once);
  });
});

describe("normalizeOptionalMessage", () => {
  it("passes null through and turns empty results into null", () => {
    expect(normalizeOptionalMessage(null)).toBeNull();
    expect(normalizeOptionalMessage(undefined)).toBeNull();
    expect(normalizeOptionalMessage("  **  **  ")).toBeNull();
  });
});
