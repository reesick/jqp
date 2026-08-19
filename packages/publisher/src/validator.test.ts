import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { scanPostFolder } from "./scanner.js";
import { validatePost } from "./validator.js";

let dir: string;

async function squareJpeg(size = 200): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: 10, g: 100, b: 200 } } })
    .jpeg()
    .toBuffer();
}

async function squarePng(size = 200): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: 10, g: 100, b: 200 } } })
    .png()
    .toBuffer();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jqp-validator-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedValidPost(count: number) {
  for (let i = 1; i <= count; i++) {
    await writeFile(join(dir, `${i}.jpg`), await squareJpeg());
  }
  await writeFile(join(dir, "caption.md"), "A valid caption.");
}

describe("validatePost", () => {
  it("accepts a 2-image carousel", async () => {
    await seedValidPost(2);
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(true);
    expect(result.images).toHaveLength(2);
  });

  it("accepts a 3-image carousel", async () => {
    await seedValidPost(3);
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(true);
  });

  it("accepts exactly 10 images", async () => {
    await seedValidPost(10);
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(true);
    expect(result.images).toHaveLength(10);
  });

  it("rejects 11 images", async () => {
    await seedValidPost(11);
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("TOO_MANY_IMAGES");
  });

  it("rejects an empty folder (no images)", async () => {
    await writeFile(join(dir, "caption.md"), "hi");
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("NO_IMAGES");
  });

  it("rejects a missing caption.md", async () => {
    await writeFile(join(dir, "1.jpg"), await squareJpeg());
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("MISSING_CAPTION");
  });

  it("rejects an empty caption.md", async () => {
    await writeFile(join(dir, "1.jpg"), await squareJpeg());
    await writeFile(join(dir, "caption.md"), "   \n  ");
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("EMPTY_CAPTION");
  });

  it("rejects a corrupt image", async () => {
    await writeFile(join(dir, "1.jpg"), Buffer.from("this is not a real jpeg"));
    await writeFile(join(dir, "caption.md"), "hi");
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("CORRUPT_IMAGE");
  });

  it("converts PNG input to JPEG output", async () => {
    await writeFile(join(dir, "1.jpg"), await squarePng()); // note: content is PNG bytes despite .jpg scanner match by name only cares about extension pattern for sequence, not real format
    await writeFile(join(dir, "caption.md"), "hi");
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(true);
    // JPEG magic bytes: FF D8 FF
    expect(result.images[0]!.buffer[0]).toBe(0xff);
    expect(result.images[0]!.buffer[1]).toBe(0xd8);
  });

  it("flags an unexpected file in the folder", async () => {
    await seedValidPost(1);
    await writeFile(join(dir, "readme.txt"), "oops");
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("UNEXPECTED_FILE");
  });

  it("flags a duplicate sequence number", async () => {
    await writeFile(join(dir, "1.jpg"), await squareJpeg());
    // Two different filenames that both parse to sequence 1 are not directly
    // constructible with the same extension, so simulate via the scanner's
    // output shape instead of the filesystem for this one case.
    const scanned = await scanPostFolder(dir);
    scanned.images.push({ sequence: 1, filename: "01.jpg", absolutePath: join(dir, "1.jpg") });
    const result = await validatePost(scanned);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("DUPLICATE_SEQUENCE");
  });

  it("preserves sequence order in the returned images array", async () => {
    await seedValidPost(4);
    const result = await validatePost(await scanPostFolder(dir));
    expect(result.images.map((i) => i.sequence)).toEqual([1, 2, 3, 4]);
  });
});
