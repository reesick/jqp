import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { ScannedPost } from "./scanner.js";

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidatedImage {
  sequence: number;
  originalFilename: string;
  /** JPEG-encoded bytes ready to upload. PNGs are converted here (Instagram carousels require JPEG). */
  buffer: Buffer;
  width: number;
  height: number;
}

export interface ValidationOutcome {
  valid: boolean;
  issues: ValidationIssue[];
  images: ValidatedImage[]; // only populated for images that individually passed
  caption: string;
}

const MAX_IMAGES = 10;
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // Meta's documented image size ceiling
// Instagram's accepted aspect ratio range, roughly 4:5 portrait to 1.91:1 landscape.
const MIN_ASPECT_RATIO = 0.79;
const MAX_ASPECT_RATIO = 1.92;

/**
 * Validates a scanned post folder and produces upload-ready image
 * buffers. Every rejection carries a specific machine-readable code
 * and a human-readable reason (plan section 8's requirement: never a
 * bare boolean) so the dashboard can show exactly what's wrong.
 */
export async function validatePost(scanned: ScannedPost): Promise<ValidationOutcome> {
  const issues: ValidationIssue[] = [];
  const images: ValidatedImage[] = [];

  for (const file of scanned.unexpectedFiles) {
    issues.push({
      code: "UNEXPECTED_FILE",
      message: `Unexpected file "${file}" — only N.jpg / N.jpeg / N.png and caption.md are allowed in a post folder`
    });
  }

  if (!scanned.captionPath) {
    issues.push({ code: "MISSING_CAPTION", message: "caption.md is missing from the post folder" });
  } else if (scanned.caption.trim().length === 0) {
    issues.push({ code: "EMPTY_CAPTION", message: "caption.md exists but is empty" });
  }

  if (scanned.images.length === 0) {
    issues.push({ code: "NO_IMAGES", message: "Folder contains no images (expected 1.jpg, 2.jpg, ...)" });
  }
  if (scanned.images.length > MAX_IMAGES) {
    issues.push({
      code: "TOO_MANY_IMAGES",
      message: `Folder has ${scanned.images.length} images; Instagram carousels support at most ${MAX_IMAGES} (plan section 4)`
    });
  }

  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const img of scanned.images) {
    if (seen.has(img.sequence)) duplicates.add(img.sequence);
    seen.add(img.sequence);
  }
  for (const dup of duplicates) {
    issues.push({ code: "DUPLICATE_SEQUENCE", message: `Multiple files resolve to sequence number ${dup}` });
  }

  // Only inspect image bytes if the folder isn't already rejected on count/duplicates —
  // no point decoding images for a folder that can never publish anyway.
  const skipImageInspection = scanned.images.length === 0 || scanned.images.length > MAX_IMAGES || duplicates.size > 0;

  if (!skipImageInspection) {
    for (const img of scanned.images) {
      try {
        const raw = await readFile(img.absolutePath);
        const probe = sharp(raw);
        const metadata = await probe.metadata();

        if (!metadata.width || !metadata.height || !metadata.format) {
          issues.push({ code: "CORRUPT_IMAGE", message: `${img.filename} could not be read as a valid image` });
          continue;
        }

        if (metadata.format !== "jpeg" && metadata.format !== "png") {
          issues.push({
            code: "UNSUPPORTED_FORMAT",
            message: `${img.filename} has format "${metadata.format}" — only JPEG and PNG are accepted`
          });
          continue;
        }

        const aspectRatio = metadata.width / metadata.height;
        if (aspectRatio < MIN_ASPECT_RATIO || aspectRatio > MAX_ASPECT_RATIO) {
          issues.push({
            code: "INVALID_ASPECT_RATIO",
            message: `${img.filename} aspect ratio ${aspectRatio.toFixed(2)} is outside Instagram's accepted range (${MIN_ASPECT_RATIO}-${MAX_ASPECT_RATIO})`
          });
          continue;
        }

        // Normalize to JPEG — PNGs are converted, JPEGs pass through re-encoded
        // to guarantee a clean, non-corrupt byte stream reaches Supabase Storage.
        const outputBuffer = await sharp(raw).jpeg({ quality: 92 }).toBuffer();

        if (outputBuffer.length > MAX_FILE_SIZE_BYTES) {
          issues.push({
            code: "FILE_TOO_LARGE",
            message: `${img.filename} is ${(outputBuffer.length / 1024 / 1024).toFixed(1)}MB after encoding, exceeding the ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB limit`
          });
          continue;
        }

        images.push({
          sequence: img.sequence,
          originalFilename: img.filename,
          buffer: outputBuffer,
          width: metadata.width,
          height: metadata.height
        });
      } catch (err) {
        issues.push({
          code: "CORRUPT_IMAGE",
          message: `${img.filename} could not be processed: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    images: images.sort((a, b) => a.sequence - b.sequence),
    caption: scanned.caption
  };
}
