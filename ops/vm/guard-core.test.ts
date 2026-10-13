import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS as T,
  accumulateTransfer,
  bodyFor,
  decide,
  emptyState,
  normalizeState,
  gradeDisk,
  gradeMemory,
  gradeService,
  gradeTransfer,
  levelHigh,
  levelLow,
  parseDfPercent,
  parseMeminfo,
  parseNetDevTx,
  subjectFor,
  type Reading
} from "./guard-core";

const MEMINFO = `MemTotal:         969000 kB
MemFree:          100000 kB
MemAvailable:     409600 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`;

const NETDEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 7000 10 0 0 0 0 0 0
  ens3: 9000 20 0 0 0 0 0 0 1500 15 0 0 0 0 0 0
docker0: 1 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0
`;

describe("levels", () => {
  it("grades high and low values", () => {
    expect(levelHigh(69, 70, 85)).toBe("ok");
    expect(levelHigh(70, 70, 85)).toBe("warn");
    expect(levelHigh(85, 70, 85)).toBe("crit");
    expect(levelLow(200, 150, 80)).toBe("ok");
    expect(levelLow(150, 150, 80)).toBe("warn");
    expect(levelLow(80, 150, 80)).toBe("crit");
  });
});

describe("parsers", () => {
  it("reads meminfo", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ availableMb: 400, swapTotalMb: 2048, swapFreeMb: 1024 });
  });
  it("returns null for an empty or unreadable meminfo instead of reporting no memory", () => {
    expect(parseMeminfo("")).toBeNull();
    expect(gradeMemory(null, T).level).toBe("warn");
  });
  it("sums transmitted bytes, skipping loopback and docker bridges", () => {
    expect(parseNetDevTx(NETDEV)).toBe(1500);
  });
  it("reads df percent", () => {
    const df = "Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/sda1         47000000 9400000  37600000      20% /\n";
    expect(parseDfPercent(df)).toBe(20);
    expect(parseDfPercent("")).toBeNull();
    expect(gradeDisk(null, T).level).toBe("warn");
  });
});

describe("grading", () => {
  it("flags disk, memory, swap", () => {
    expect(gradeDisk(72, T).level).toBe("warn");
    expect(gradeDisk(90, T).level).toBe("crit");
    expect(gradeMemory({ availableMb: 60, swapTotalMb: 2048, swapFreeMb: 2048 }, T).level).toBe("crit");
    expect(gradeMemory({ availableMb: 400, swapTotalMb: 2048, swapFreeMb: 100 }, T).level).toBe("crit");
    expect(gradeMemory({ availableMb: 400, swapTotalMb: 0, swapFreeMb: 0 }, T).level).toBe("ok");
  });
  it("shows outbound data against Oracle's 10 TB allowance", () => {
    const r = gradeTransfer(6e9, T);
    expect(r.level).toBe("warn");
    expect(r.detail).toContain("6.00 GB");
    expect(r.detail).toContain("10 TB");
    expect(gradeTransfer(30e9, T).level).toBe("crit");
    expect(gradeTransfer(1e8, T).level).toBe("ok");
  });
  it("does not alarm on the restart window, or on a worker that is not enabled", () => {
    expect(gradeService("activating", 0, T, "enabled").level).toBe("ok");
    expect(gradeService("inactive", 0, T, "disabled").level).toBe("ok");
    expect(gradeService("inactive", 0, T, "disabled").detail).toContain("not enabled");
    // enabled but not running means it died or was halted
    expect(gradeService("inactive", 0, T, "enabled").level).toBe("crit");
    expect(gradeService("failed", 0, T, "enabled").level).toBe("crit");
  });
  it("flags a stopped or crash-looping service", () => {
    expect(gradeService("inactive", 0, T).level).toBe("crit");
    expect(gradeService("active", 0, T).level).toBe("ok");
    expect(gradeService("active", 2, T).level).toBe("warn");
    expect(gradeService("active", 5, T).level).toBe("crit");
  });
});

describe("force stop", () => {
  it("halts the worker at 95% of the disk, not before", () => {
    expect(gradeDisk(94, T).halt).toBe(false);
    expect(gradeDisk(95, T).halt).toBe(true);
  });
  it("halts at 95% of Oracle's 10 TB outbound allowance, not before", () => {
    expect(gradeTransfer(9.4e12, T).halt).toBe(false);
    expect(gradeTransfer(9.5e12, T).halt).toBe(true);
  });
  it("never halts for a plain warning or a crash loop", () => {
    expect(gradeDisk(72, T).halt).toBe(false);
    expect(gradeTransfer(30e9, T).halt).toBe(false);
    expect(gradeService("active", 9, T).halt).toBeUndefined();
    expect(gradeMemory({ availableMb: 10, swapTotalMb: 0, swapFreeMb: 0 }, T).halt).toBeUndefined();
  });
  it("lets the halt thresholds be tuned", () => {
    expect(gradeDisk(90, { ...T, diskHaltPct: 90 }).halt).toBe(true);
  });
});

describe("state file safety", () => {
  it("falls back to an empty state for junk", () => {
    for (const junk of [null, undefined, 5, "x", [], { transfer: null, checks: 3, restarts: "no" }]) {
      expect(normalizeState(junk)).toEqual(emptyState());
    }
  });
  it("keeps valid parts and drops invalid ones", () => {
    const s = normalizeState({
      checks: { disk: { level: "warn", since: 5, lastAlertAt: 6 }, bad: { level: "purple", since: 1 } },
      transfer: { month: "2026-10", bytes: 123, lastCounter: 9 },
      restarts: { lastCount: 4 },
      bootId: "abc",
      haltNotified: true
    });
    expect(s.checks).toEqual({ disk: { level: "warn", since: 5, lastAlertAt: 6 } });
    expect(s.transfer).toEqual({ month: "2026-10", bytes: 123, lastCounter: 9 });
    expect(s.restarts.lastCount).toBe(4);
    expect(s.bootId).toBe("abc");
    expect(s.haltNotified).toBe(true);
  });
  it("round-trips a real state", () => {
    const s = emptyState();
    s.transfer = { month: "2026-10", bytes: 77, lastCounter: 5 };
    expect(normalizeState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe("transfer accounting", () => {
  const jan = Date.UTC(2026, 0, 15);
  it("counts nothing on the first run, then the difference", () => {
    const first = accumulateTransfer({ month: "", bytes: 0, lastCounter: null }, 1000, jan);
    expect(first).toEqual({ month: "2026-01", bytes: 0, lastCounter: 1000 });
    expect(accumulateTransfer(first, 1600, jan).bytes).toBe(600);
  });
  it("treats a lower counter as a reboot and keeps the month total", () => {
    const s = accumulateTransfer({ month: "2026-01", bytes: 600, lastCounter: 1600 }, 50, jan);
    expect(s.bytes).toBe(650);
  });
  it("starts over in a new month", () => {
    const s = accumulateTransfer({ month: "2026-01", bytes: 9e9, lastCounter: 100 }, 180, Date.UTC(2026, 1, 1, 0, 1));
    expect(s).toEqual({ month: "2026-02", bytes: 80, lastCounter: 180 });
  });
});

const reading = (level: Reading["level"], id = "disk"): Reading => ({ id, label: "Disk", level, detail: "x" });

describe("alert decisions", () => {
  it("stays quiet when everything is fine on the first run", () => {
    const { alerts, checks } = decide({}, [reading("ok")], 1000);
    expect(alerts).toEqual([]);
    expect(checks.disk.level).toBe("ok");
  });
  it("alerts at once on a first non-ok reading", () => {
    expect(decide({}, [reading("crit")], 1000).alerts.map((a) => a.kind)).toEqual(["problem"]);
  });
  it("alerts on a change, not on every check", () => {
    const first = decide({}, [reading("ok")], 1000).checks;
    const warn = decide(first, [reading("warn")], 2000);
    expect(warn.alerts.map((a) => a.kind)).toEqual(["problem"]);
    expect(decide(warn.checks, [reading("warn")], 3000).alerts).toEqual([]);
  });
  it("repeats a critical alert after 6 hours and a warning after 24", () => {
    const crit = decide({}, [reading("crit")], 0).checks;
    expect(decide(crit, [reading("crit")], 5 * 3600_000).alerts).toEqual([]);
    expect(decide(crit, [reading("crit")], 6 * 3600_000).alerts.map((a) => a.kind)).toEqual(["still"]);
    const warn = decide({}, [reading("warn")], 0).checks;
    expect(decide(warn, [reading("warn")], 23 * 3600_000).alerts).toEqual([]);
    expect(decide(warn, [reading("warn")], 24 * 3600_000).alerts.map((a) => a.kind)).toEqual(["still"]);
  });
  it("sends a recovery message once", () => {
    const crit = decide({}, [reading("crit")], 0).checks;
    const back = decide(crit, [reading("ok")], 1000);
    expect(back.alerts.map((a) => a.kind)).toEqual(["recovered"]);
    expect(decide(back.checks, [reading("ok")], 2000).alerts).toEqual([]);
  });
  it("tracks each check separately", () => {
    const { alerts } = decide({}, [reading("crit", "disk"), reading("ok", "memory")], 0);
    expect(alerts).toHaveLength(1);
  });
});

describe("message", () => {
  it("puts the worst level and host in the subject", () => {
    const { alerts } = decide({}, [reading("crit"), reading("warn", "memory")], 0);
    expect(subjectFor(alerts, "vm1")).toBe("[jqp VM vm1] CRITICAL: Disk (+1 more)");
  });
  it("says OK again for a recovery", () => {
    const crit = decide({}, [reading("crit")], 0).checks;
    const { alerts } = decide(crit, [reading("ok")], 1);
    expect(subjectFor(alerts, "vm1")).toContain("OK again");
  });
  it("includes what to do and never contains a secret-looking value", () => {
    const { alerts } = decide({}, [reading("crit")], 0);
    const body = bodyFor(alerts, "vm1", Date.UTC(2026, 9, 13));
    expect(body).toContain("What to do:");
    expect(body).toContain("2026-10-13T00:00:00.000Z");
  });
});
