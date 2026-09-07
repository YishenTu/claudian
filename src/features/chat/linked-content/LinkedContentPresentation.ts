import type { App, TAbstractFile } from 'obsidian';
import { TFile, TFolder } from 'obsidian';

export type LinkedContentKind = 'file' | 'folder' | 'missing';

export interface LinkedContentPresentation {
  readonly path: string;
  readonly kind: LinkedContentKind;
  readonly label: string;
  readonly icon: string;
  readonly missing: boolean;
  readonly target: TAbstractFile | null;
}

function finalPathSegment(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] || path;
}

function fileLabel(file: TFile): string {
  return file.extension.toLocaleLowerCase() === 'md' ? file.basename : file.name;
}

export function deriveLinkedContentPresentation(
  app: App,
  path: string,
): LinkedContentPresentation {
  const target = app.vault.getAbstractFileByPath(path);
  if (target instanceof TFile) {
    return {
      path,
      kind: 'file',
      label: fileLabel(target),
      icon: target.extension.toLocaleLowerCase() === 'md' ? 'file-text' : 'file',
      missing: false,
      target,
    };
  }
  if (target instanceof TFolder) {
    return {
      path,
      kind: 'folder',
      label: target.name,
      icon: 'folder',
      missing: false,
      target,
    };
  }
  return {
    path,
    kind: 'missing',
    label: finalPathSegment(path),
    icon: 'file-question',
    missing: true,
    target: null,
  };
}
