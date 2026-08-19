import type { CollabProjectId } from '@claudian/collab-protocol';

export interface CollabProjectSelectionItem {
  readonly id: CollabProjectId;
  readonly name: string;
}

export interface CollabProjectSelectionProjection {
  readonly projects: readonly CollabProjectSelectionItem[];
  readonly selectedProjectId: CollabProjectId | null;
}

export function resolveEffectiveCollabProjectId(
  projects: readonly { readonly id: CollabProjectId }[],
  selectedProjectId: CollabProjectId | null,
): CollabProjectId | null {
  if (selectedProjectId && projects.some(project => project.id === selectedProjectId)) {
    return selectedProjectId;
  }
  return projects[0]?.id ?? null;
}
