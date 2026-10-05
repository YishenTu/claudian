import { parseApplyPatchDiffs, parseFileUpdateChangeDiffs } from '@/core/tools/toolDiff';
import type { ToolCallInfo } from '@/core/types';
import type { DiffStats } from '@/core/types/diff';
import { renderDiffContent, renderDiffStats } from '@/features/chat/rendering/tools/DiffRenderer';
import { fileNameOnly, renderEmptyResult, renderLinesExpanded } from '@/features/chat/rendering/tools/toolContentPrimitives';
import { setToolStatus } from '@/features/chat/rendering/tools/toolStatus';

type ApplyPatchFileDiffs = ReturnType<typeof parseApplyPatchDiffs>;

export function getApplyPatchSummary(input: Record<string, unknown>): string {
  // Extract file paths from patch text markers
  const patchText = typeof input.patch === 'string' ? input.patch : '';
  const patchFiles = [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map(m => m[1]?.trim() ?? '');

  // Also check changes array
  const changes = input.changes;
  const changeFiles = Array.isArray(changes)
    ? (changes as Array<{ path?: string }>)
        .map(c => c.path)
        .filter((p): p is string => !!p)
    : [];

  const files = [...new Set([...patchFiles, ...changeFiles])];
  if (files.length === 0) return patchText ? 'patch' : '';
  if (files.length === 1) return fileNameOnly(files[0]);
  return `${files.length} files`;
}

function getApplyPatchFileDiffs(input: Record<string, unknown>): ApplyPatchFileDiffs {
  const patchText = typeof input.patch === 'string' ? input.patch : '';
  const parsedDiffs = patchText ? parseApplyPatchDiffs(patchText) : [];
  return parsedDiffs.length > 0 ? parsedDiffs : parseFileUpdateChangeDiffs(input.changes);
}

function getApplyPatchDiffStats(input: Record<string, unknown>): DiffStats | undefined {
  const fileDiffs = getApplyPatchFileDiffs(input);
  if (fileDiffs.length === 0) return undefined;

  const stats = fileDiffs.reduce<DiffStats>(
    (acc, fileDiff) => ({
      added: acc.added + fileDiff.stats.added,
      removed: acc.removed + fileDiff.stats.removed,
    }),
    { added: 0, removed: 0 }
  );

  return stats.added > 0 || stats.removed > 0 ? stats : undefined;
}

/** Successful patches show their diff stats in place of the status icon. */
export function setApplyPatchStatus(statusEl: HTMLElement, toolCall: ToolCallInfo): void {
  const isError = toolCall.status === 'error' || toolCall.status === 'blocked';
  const stats = isError ? undefined : getApplyPatchDiffStats(toolCall.input);
  if (!stats) {
    setToolStatus(statusEl, toolCall.status, 'claudian-tool-status');
    return;
  }

  statusEl.className = 'claudian-tool-status claudian-write-edit-stats';
  statusEl.empty();
  statusEl.setAttribute('aria-label', `Changes: +${stats.added} -${stats.removed}`);
  renderDiffStats(statusEl, stats);
}

function readMoveTarget(kind: unknown): string | undefined {
  if (!kind || typeof kind !== 'object' || Array.isArray(kind)) {
    return undefined;
  }
  const record = kind as Record<string, unknown>;
  return typeof record.move_path === 'string' ? record.move_path : undefined;
}

function renderApplyPatchDiffSections(container: HTMLElement, fileDiffs: ApplyPatchFileDiffs): void {
  for (const fileDiff of fileDiffs) {
    const sectionEl = container.createDiv({ cls: 'claudian-tool-patch-section' });

    if (fileDiff.operation === 'delete' && fileDiff.diffLines.length === 0) {
      renderEmptyResult(sectionEl, 'File deleted');
      continue;
    }

    if (fileDiff.diffLines.length === 0) {
      renderEmptyResult(sectionEl, 'No textual diff available');
      continue;
    }

    const diffRow = sectionEl.createDiv({ cls: 'claudian-write-edit-diff-row' });
    const diffEl = diffRow.createDiv({ cls: 'claudian-write-edit-diff' });
    renderDiffContent(diffEl, fileDiff.diffLines);
  }
}

export function renderApplyPatchExpanded(
  container: HTMLElement,
  input: Record<string, unknown>,
  result: string | undefined,
): void {
  const patchText = typeof input.patch === 'string' ? input.patch : '';
  const parsedDiffs = getApplyPatchFileDiffs(input);

  if (result && /verification failed|^[Ee]rror:/.test(result.trim())) {
    renderLinesExpanded(container, result, 20);
  }

  if (parsedDiffs.length > 0) {
    renderApplyPatchDiffSections(container, parsedDiffs);
    return;
  }

  const changes = Array.isArray(input.changes) ? input.changes : [];
  if (changes.length > 0) {
    const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
    for (const change of changes as unknown[]) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) continue;
      const changeRecord = change as Record<string, unknown>;
      const path = typeof changeRecord.path === 'string' ? changeRecord.path : '';
      if (!path) continue;
      const movedTo = readMoveTarget(changeRecord.kind);
      const pathText = movedTo ? `${path} -> ${movedTo}` : path;
      linesEl.createDiv({ cls: 'claudian-tool-line', text: pathText });
    }
    return;
  }

  if (patchText) {
    renderLinesExpanded(container, patchText, 80);
    return;
  }

  if (result) {
    const fileMatches = [...result.matchAll(/(?:update|add|delete|create|modify|Applied:\s*)(?:\w+:\s*)?([^\n,]+)/gi)];
    if (fileMatches.length > 0) {
      const linesEl = container.createDiv({ cls: 'claudian-tool-lines' });
      for (const match of fileMatches) {
        const filePath = match[1]?.trim();
        if (filePath) {
          const lineEl = linesEl.createDiv({ cls: 'claudian-tool-line' });
          lineEl.setText(filePath);
        }
      }
      return;
    }
    renderLinesExpanded(container, result, 20);
    return;
  }

  renderEmptyResult(container);
}
