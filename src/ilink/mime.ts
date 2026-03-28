import path from "node:path";

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".zip": "application/zip",
  ".json": "application/json",
  ".wav": "audio/wav",
  ".silk": "audio/silk"
};

const MIME_TO_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_TO_MIME).map(([ext, mime]) => [mime, ext])
);

export function getMimeFromFilename(filePath: string): string {
  return EXT_TO_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function getExtensionFromMimeOrUrl(contentType: string | null, url: string): string {
  if (contentType) {
    const mime = contentType.split(";")[0]?.trim().toLowerCase();
    if (mime && MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  }
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (ext) return ext;
  } catch {
    const ext = path.extname(url).toLowerCase();
    if (ext) return ext;
  }
  return ".bin";
}
