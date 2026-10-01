import { describe, expect, it, vi } from "vitest";
import { noteMetaUsage, parseMetaUsage, retryAfterMsFromHeaders, setMetaUsageObserver } from "./usage.js";

const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null });

describe("parseMetaUsage", () => {
  it("reads the business-use-case header (Instagram)", () => {
    const usage = parseMetaUsage(
      headers({ "x-business-use-case-usage": JSON.stringify({ "17841": [{ type: "instagram", call_count: 80, total_cputime: 12, total_time: 30, estimated_time_to_regain_access: 0 }] }) })
    );
    expect(usage).toEqual({ callCountPct: 80, totalTimePct: 30, totalCpuPct: 12, regainMinutes: 0 });
  });

  it("reads the app-level header and takes the worst value across both", () => {
    const usage = parseMetaUsage(
      headers({
        "x-app-usage": JSON.stringify({ call_count: 20, total_cputime: 5, total_time: 90 }),
        "x-business-use-case-usage": JSON.stringify({ "1": [{ call_count: 60, estimated_time_to_regain_access: 15 }] })
      })
    );
    expect(usage?.callCountPct).toBe(60);
    expect(usage?.totalTimePct).toBe(90);
    expect(usage?.regainMinutes).toBe(15);
  });

  it("returns null when there are no usage headers, and survives garbage", () => {
    expect(parseMetaUsage(headers({}))).toBeNull();
    expect(parseMetaUsage(headers({ "x-app-usage": "not json", "x-business-use-case-usage": "{{" }))).toBeNull();
  });
});

describe("retryAfterMsFromHeaders", () => {
  it("converts Meta's minutes-until-access-returns to milliseconds", () => {
    const h = headers({ "x-business-use-case-usage": JSON.stringify({ "1": [{ call_count: 100, estimated_time_to_regain_access: 30 }] }) });
    expect(retryAfterMsFromHeaders(h)).toBe(30 * 60_000);
  });

  it("honours Retry-After when larger, and returns 0 with no hint", () => {
    expect(retryAfterMsFromHeaders(headers({ "retry-after": "120" }))).toBe(120_000);
    expect(retryAfterMsFromHeaders(headers({}))).toBe(0);
  });
});

describe("noteMetaUsage", () => {
  it("warns at 75% or when throttled, but not below, and only once per interval", () => {
    const seen = vi.fn();
    setMetaUsageObserver(seen);
    noteMetaUsage({ callCountPct: 40, totalTimePct: 10, totalCpuPct: 5, regainMinutes: 0 }, "/x");
    expect(seen).not.toHaveBeenCalled();
    noteMetaUsage({ callCountPct: 80, totalTimePct: 10, totalCpuPct: 5, regainMinutes: 0 }, "/x");
    expect(seen).toHaveBeenCalledTimes(1);
    noteMetaUsage({ callCountPct: 95, totalTimePct: 10, totalCpuPct: 5, regainMinutes: 20 }, "/x");
    expect(seen).toHaveBeenCalledTimes(1);
    setMetaUsageObserver(undefined);
  });
});
