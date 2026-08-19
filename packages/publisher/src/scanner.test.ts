import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { scanPostFolder } from "./scanner.js";

let dir: string;

async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .jpeg()
    .toBuffer();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jqp-scanner-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scanPostFolder", () => {
  it("sorts images NUMERICALLY, not lexicographically (1,2,3,10 not 1,10,2,3)", async () => {
    const img = await tinyJpeg();
    for (const n of [1, 2, 3, 10]) {
      await writeFile(join(dir, `${n}.jpg`), img);
    }
    await writeFile(join(dir, "caption.md"), "hello");

    const scanned = await scanPostFolder(dir);
    expect(scanned.images.map((i) => i.sequence)).toEqual([1, 2, 3, 10]);
    expect(scanned.images.map((i) => i.filename)).toEqual(["1.jpg", "2.jpg", "3.jpg", "10.jpg"]);
  });

  it("reads caption.md verbatim without modification", async () => {
    const caption = "Line one.\n\nHashtags: #a #b #c\n";
    await writeFile(join(dir, "1.jpg"), await tinyJpeg());
    await writeFile(join(dir, "caption.md"), caption);

    const scanned = await scanPostFolder(dir);
    expect(scanned.caption).toBe(caption);
  });

  it("reports missing caption as captionPath: null", async () => {
    await writeFile(join(dir, "1.jpg"), await tinyJpeg());
    const scanned = await scanPostFolder(dir);
    expect(scanned.captionPath).toBeNull();
    expect(scanned.caption).toBe("");
  });

  it("flags files that don't match the N.jpg/N.png pattern as unexpected", async () => {
    await writeFile(join(dir, "1.jpg"), await tinyJpeg());
    await writeFile(join(dir, "notes.txt"), "scratch notes");
    await writeFile(join(dir, "cover.jpg"), await tinyJpeg());
    await writeFile(join(dir, "caption.md"), "hi");

    const scanned = await scanPostFolder(dir);
    expect(scanned.unexpectedFiles.sort()).toEqual(["cover.jpg", "notes.txt"]);
    expect(scanned.images).toHaveLength(1);
  });

  it("accepts N-description.jpg naming (real-world content batches), sorted numerically", async () => {
    const img = await tinyJpeg();
    await writeFile(join(dir, "01-direct-flash-macro-lip-application.jpg"), img);
    await writeFile(join(dir, "02-apple-still-life-hero.jpg"), img);
    await writeFile(join(dir, "10-pink-bubble-pouch-multiples.jpg"), img);
    await writeFile(join(dir, "caption.md"), "hi");

    const scanned = await scanPostFolder(dir);
    expect(scanned.unexpectedFiles).toEqual([]);
    expect(scanned.images.map((i) => i.sequence)).toEqual([1, 2, 10]);
    expect(scanned.images.map((i) => i.filename)).toEqual([
      "01-direct-flash-macro-lip-application.jpg",
      "02-apple-still-life-hero.jpg",
      "10-pink-bubble-pouch-multiples.jpg"
    ]);
  });

  it("uses the folder name as campaignId", async () => {
    await writeFile(join(dir, "1.jpg"), await tinyJpeg());
    const scanned = await scanPostFolder(dir);
    expect(scanned.campaignId).toBe(dir.split(/[/\\]/).pop());
  });
});
