import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getConfigDir } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import { writeProtectedText } from "../security/secure_store.js";
import type {
  CateoAssistInput,
  CateoAttachmentEvidence,
  CateoAttachmentInput,
  CateoDigitalTwinInput,
  CateoDimensionObservation,
  CateoPointObservation,
} from "./types.js";

function getMediaDir(caseId: string): string {
  return path.join(getConfigDir(), "cateo", "media", caseId);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function sanitizeName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-");
  return safe.length > 0 ? safe : "attachment";
}

function sniffMimeType(buffer: Buffer, declared: string | undefined, name: string): string | undefined {
  if (declared?.trim()) return declared.trim();
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 2 && buffer.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (buffer.length >= 8 && buffer.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    default: return undefined;
  }
}

function detectKind(mimeType: string | undefined): CateoAttachmentInput["kind"] {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  return "document";
}

function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseGifDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 10) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function parseBmpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 26) return null;
  return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
}

function parseWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30 || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunkType === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return null;
}

function extractImageDimensions(buffer: Buffer, mimeType: string | undefined): { width: number; height: number } | null {
  switch (mimeType) {
    case "image/png": return parsePngDimensions(buffer);
    case "image/jpeg": return parseJpegDimensions(buffer);
    case "image/gif": return parseGifDimensions(buffer);
    case "image/webp": return parseWebpDimensions(buffer);
    case "image/bmp": return parseBmpDimensions(buffer);
    default: return null;
  }
}

function distance(left: number[], right: number[]): number {
  const width = Math.max(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < width; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function deriveObservations(attachment: CateoAttachmentInput): { dimensions: CateoDimensionObservation[]; points: CateoPointObservation[]; referenceModelId?: string; expectedStateLabel?: string; notes: string[] } {
  const annotations = attachment.annotations;
  if (!annotations) {
    return { dimensions: [], points: [], notes: [] };
  }

  const calibration = annotations.calibration;
  const scale = calibration && calibration.pixels > 0 ? calibration.actualLength / calibration.pixels : undefined;
  const dimensions = (annotations.dimensions ?? []).flatMap((entry) => {
    const observedPixels = entry.observedPixels ?? (entry.startPx && entry.endPx ? distance(entry.startPx, entry.endPx) : undefined);
    if (observedPixels === undefined) {
      return [];
    }
    return [{
      name: entry.name,
      expected: entry.expected,
      observed: round(scale ? observedPixels * scale : observedPixels),
      unit: scale ? calibration?.unit ?? entry.unit : entry.unit,
      tolerancePct: entry.tolerancePct,
      toleranceAbs: entry.toleranceAbs,
    }];
  });
  const points = (annotations.points ?? []).map((entry) => ({
    name: entry.name,
    expected: entry.expected,
    observed: entry.observed,
    unit: entry.unit,
    toleranceAbs: entry.toleranceAbs,
  }));
  const notes = scale
    ? [`Applied calibration ${calibration?.referenceName ?? "reference"}: ${round(scale)} ${calibration?.unit ?? "units"}/px.`]
    : [];

  return {
    dimensions,
    points,
    referenceModelId: annotations.referenceModelId,
    expectedStateLabel: annotations.expectedStateLabel,
    notes,
  };
}

function tryProbeVideo(buffer: Buffer, mimeType: string | undefined): { width?: number; height?: number; durationSeconds?: number; codec?: string } | null {
  if (!mimeType?.startsWith("video/")) return null;
  const tempPath = path.join(os.tmpdir(), `cateo-media-${crypto.randomUUID()}.bin`);
  try {
    fs.writeFileSync(tempPath, buffer);
    const result = spawnSync("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      tempPath,
    ], { encoding: "utf-8", windowsHide: true });
    if (result.status !== 0 || !result.stdout) return null;
    const parsed = JSON.parse(result.stdout);
    const videoStream = Array.isArray(parsed.streams) ? parsed.streams.find((entry: { codec_type?: string }) => entry.codec_type === "video") : undefined;
    return {
      width: typeof videoStream?.width === "number" ? videoStream.width : undefined,
      height: typeof videoStream?.height === "number" ? videoStream.height : undefined,
      durationSeconds: parsed.format?.duration ? Number(parsed.format.duration) : undefined,
      codec: typeof videoStream?.codec_name === "string" ? videoStream.codec_name : undefined,
    };
  } catch {
    return null;
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

export function sanitizeAssistInputForPersistence(input: CateoAssistInput): CateoAssistInput {
  return {
    ...input,
    attachments: input.attachments?.map((attachment) => ({
      ...attachment,
      contentBase64: undefined,
    })),
  };
}

export function buildDerivedDigitalTwinInput(attachments: CateoAttachmentEvidence[]): CateoDigitalTwinInput | undefined {
  const dimensions = attachments.flatMap((attachment) => attachment.derivedDimensions);
  const points = attachments.flatMap((attachment) => attachment.derivedPoints);
  if (dimensions.length === 0 && points.length === 0) {
    return undefined;
  }

  const referenceAttachment = attachments.find((attachment) => attachment.referenceModelId || attachment.expectedStateLabel);
  return {
    referenceModelId: referenceAttachment?.referenceModelId,
    expectedStateLabel: referenceAttachment?.expectedStateLabel,
    dimensions,
    points,
  };
}

export function ingestMediaAttachments(caseId: string, attachments: CateoAttachmentInput[] | undefined, requestId?: string): CateoAttachmentEvidence[] {
  if (!attachments || attachments.length === 0) return [];
  const mediaDir = getMediaDir(caseId);
  ensureDir(mediaDir);

  return attachments.map((attachment) => {
    const buffer = attachment.contentBase64 ? Buffer.from(attachment.contentBase64, "base64") : Buffer.alloc(0);
    const mimeType = sniffMimeType(buffer, attachment.mimeType, attachment.name);
    const kind = detectKind(mimeType ?? attachment.mimeType);
    const attachmentId = crypto.randomUUID();
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const storedName = `${attachmentId}-${sanitizeName(attachment.name)}.enc`;
    const storedPath = path.join(mediaDir, storedName);
    if (buffer.length > 0) {
      writeProtectedText(storedPath, buffer.toString("base64"));
    }

    const dimensions = kind === "image" ? extractImageDimensions(buffer, mimeType) : null;
    const videoInfo = kind === "video" ? tryProbeVideo(buffer, mimeType) : null;
    const derived = deriveObservations(attachment);
    const notes = [
      ...derived.notes,
      buffer.length > 0 ? "Encrypted media payload stored locally." : "Attachment metadata captured without inline payload.",
      dimensions ? `Image geometry extracted at ${dimensions.width}x${dimensions.height}.` : "",
      videoInfo?.durationSeconds ? `Video duration extracted at ${round(videoInfo.durationSeconds)} seconds.` : kind === "video" ? "Detailed video probing unavailable on this machine." : "",
    ].filter(Boolean);

    appendAuditEvent({
      actor: "runtime",
      category: "cateo_media",
      action: "ingest",
      outcome: "success",
      message: `Ingested ${kind} attachment ${attachment.name}`,
      requestId,
      metadata: { caseId, mimeType, sizeBytes: buffer.length || attachment.sizeBytes || 0, sha256 },
    });

    return {
      attachmentId,
      kind,
      name: attachment.name,
      mimeType,
      sizeBytes: buffer.length || attachment.sizeBytes || 0,
      sha256,
      storageRef: path.posix.join("cateo", "media", caseId, storedName),
      width: dimensions?.width ?? videoInfo?.width,
      height: dimensions?.height ?? videoInfo?.height,
      durationSeconds: videoInfo?.durationSeconds,
      codec: videoInfo?.codec,
      referenceModelId: derived.referenceModelId,
      expectedStateLabel: derived.expectedStateLabel,
      derivedDimensions: derived.dimensions,
      derivedPoints: derived.points,
      notes,
    };
  });
}
