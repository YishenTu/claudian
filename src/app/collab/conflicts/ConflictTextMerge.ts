import type { CollabConflictTextSegment } from '@/core/collab';

export interface ConflictTextMergeMarkers {
  readonly acceptedLabel: string;
  readonly baseLabel: string;
  readonly markerSize: number;
  readonly personalLabel: string;
}

interface TextLine {
  readonly raw: string;
  readonly value: string;
}

function lines(text: string): readonly TextLine[] {
  const result: TextLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    const raw = text.slice(start, end);
    const withoutNewline = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    result.push({
      raw,
      value: withoutNewline.endsWith('\r')
        ? withoutNewline.slice(0, -1)
        : withoutNewline,
    });
    start = end;
  }
  return result;
}

function collectUntil(
  source: readonly TextLine[],
  start: number,
  marker: string,
): { readonly next: number; readonly text: string } {
  let index = start;
  let text = '';
  while (index < source.length && source[index]?.value !== marker) {
    text += source[index]?.raw ?? '';
    index += 1;
  }
  if (index >= source.length) throw new Error('Malformed Git conflict markers');
  return { next: index + 1, text };
}

export function parseConflictTextMerge(
  text: string,
  markers: ConflictTextMergeMarkers,
): readonly CollabConflictTextSegment[] {
  const startMarker = `${'<'.repeat(markers.markerSize)} ${markers.personalLabel}`;
  const baseMarker = `${'|'.repeat(markers.markerSize)} ${markers.baseLabel}`;
  const separator = '='.repeat(markers.markerSize);
  const endMarker = `${'>'.repeat(markers.markerSize)} ${markers.acceptedLabel}`;
  const source = lines(text);
  const segments: CollabConflictTextSegment[] = [];
  let common = '';
  let conflictIndex = 0;
  let index = 0;

  while (index < source.length) {
    const line = source[index];
    if (line?.value !== startMarker) {
      common += line?.raw ?? '';
      index += 1;
      continue;
    }
    if (common.length > 0) {
      segments.push({ kind: 'common', text: common });
      common = '';
    }
    const personal = collectUntil(source, index + 1, baseMarker);
    const base = collectUntil(source, personal.next, separator);
    const accepted = collectUntil(source, base.next, endMarker);
    conflictIndex += 1;
    segments.push({
      accepted: accepted.text,
      base: base.text,
      id: `hunk-${conflictIndex}`,
      kind: 'conflict',
      personal: personal.text,
    });
    index = accepted.next;
  }
  if (common.length > 0) segments.push({ kind: 'common', text: common });
  if (conflictIndex === 0) throw new Error('Git merge did not produce a conflict hunk');
  return segments;
}
