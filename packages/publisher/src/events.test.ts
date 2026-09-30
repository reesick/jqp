import { describe, expect, it } from "vitest";
import { scrubMeta, scrubText } from "./events.js";

describe("scrubText", () => {
  it("removes connection strings and URLs", () => {
    const out = scrubText("connect failed postgres://postgres.abc:hunter2@aws-0-ap-south-1.pooler.supabase.com:5432/postgres");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("supabase.com");
  });

  it("removes bearer tokens and long opaque strings", () => {
    expect(scrubText("Authorization: Bearer abc.def-ghi_123")).toContain("Bearer [redacted]");
    expect(scrubText("token IGAAKx0123456789abcdefABCDEF0123456789abcdef failed")).not.toContain("IGAAKx0123456789");
  });

  it("truncates and collapses whitespace", () => {
    expect(scrubText("a\n\n  b")).toBe("a b");
    expect(scrubText("x y ".repeat(500)).length).toBeLessThanOrEqual(300);
  });
});

describe("scrubMeta", () => {
  it("drops keys that could hold personal content or secrets", () => {
    const out = scrubMeta({ commenterName: "Asha", commentText: "hi", accessToken: "x", email: "a@b.c", attempt: 2, stage: "upload", ok: false });
    expect(out).toEqual({ attempt: 2, stage: "upload", ok: false });
  });

  it("drops non-primitive values", () => {
    expect(scrubMeta({ nested: { a: 1 } as unknown, list: [1, 2] as unknown, n: 1 })).toEqual({ n: 1 });
  });

  it("handles undefined", () => {
    expect(scrubMeta(undefined)).toEqual({});
  });
});
