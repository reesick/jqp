import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface ScannedImage {
  sequence: number;
  filename: string;
  absolutePath: string;
}

export interface ScannedPost {
  campaignId: string; // the folder name, e.g. POST_001 — this becomes posts.campaign_id
  folderPath: string;
  images: ScannedImage[]; // sorted NUMERICALLY ascending (1,2,3,10 — not 1,10,2,3)
  caption: string;
  captionPath: string | null;
  /** Files present in the folder that are neither N.jpg/N.jpeg/N.png nor caption.md — the validator rejects these. */
  unexpectedFiles: string[];
}

// Matches a leading number that determines carousel order, optionally
// followed by a "-"/"_" separated description before the extension —
// "1.jpg" and "01-direct-flash-macro-lip-application.jpg" both match,
// with the description part ignored for sorting purposes. Real content
// batches (e.g. AI image generation output) commonly use the latter
// naming convention; requiring bare "N.jpg" was unnecessarily strict.
const IMAGE_FILENAME_PATTERN = /^(\d+)(?:[-_].*)?\.(jpe?g|png)$/i;

/**
 * Reads a POST_xxx folder and extracts its images in the correct
 * numeric order. Filenames are matched by extracting the leading
 * integer and sorting on that integer — never on the raw string —
 * per plan section 4 ("1.jpg, 2.jpg, 3.jpg, 10.jpg" NOT lexicographic
 * order). caption.md is read verbatim; nothing here rewrites it.
 */
export async function scanPostFolder(folderPath: string): Promise<ScannedPost> {
  const campaignId = basename(folderPath);
  const entries = await readdir(folderPath, { withFileTypes: true });

  const images: ScannedImage[] = [];
  const unexpectedFiles: string[] = [];
  let captionPath: string | null = null;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;

    if (name.toLowerCase() === "caption.md") {
      captionPath = join(folderPath, name);
      continue;
    }

    const match = name.match(IMAGE_FILENAME_PATTERN);
    if (match && match[1]) {
      images.push({
        sequence: Number.parseInt(match[1], 10),
        filename: name,
        absolutePath: join(folderPath, name)
      });
    } else {
      unexpectedFiles.push(name);
    }
  }

  images.sort((a, b) => a.sequence - b.sequence);

  const caption = captionPath ? await readFile(captionPath, "utf-8") : "";

  return { campaignId, folderPath, images, caption, captionPath, unexpectedFiles };
}
