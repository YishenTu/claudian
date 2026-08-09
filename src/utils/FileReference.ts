export interface FileReference {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export function parseFileReference(value: string): FileReference {
  const normalized = value.trim();
  const match = normalized.match(/^(.*):([0-9]+)(?:[-–—]([0-9]+))?$/u);

  if (!match || !match[1]?.trim()) return { path: normalized };

  const lineStart = Number(match[2]);
  const lineEnd = match[3] ? Number(match[3]) : lineStart;
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)) {
    return { path: normalized };
  }

  return {
    path: match[1].trim(),
    lineStart,
    lineEnd: Math.max(lineStart, lineEnd),
  };
}

export function stripFileLineRange(fileReference: string): string {
  return parseFileReference(fileReference).path;
}
