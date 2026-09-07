import type { CollabComposerReferencePort } from '@/core/collab';
import type {
  ComposerDropdownFolderItem,
  ComposerDropdownValueItem,
} from '@/shared/composer-dropdown';

export class CollabMemberChangesFolder {
  constructor(private readonly references: CollabComposerReferencePort) {}

  async getRootItems(signal: AbortSignal): Promise<readonly ComposerDropdownFolderItem[]> {
    const selection = await this.references.getSelection(signal);
    if (!selection) return [];
    return [{
      icon: 'git-pull-request',
      id: `collab-members:${selection.projectId}`,
      inputPrefix: "Member's Changes/",
      kind: 'folder',
      label: "Member's Changes",
      load: (query, folderSignal) => this.loadMembers(query, folderSignal),
    }];
  }

  private async loadMembers(
    query: string,
    signal: AbortSignal,
  ): Promise<readonly ComposerDropdownValueItem[]> {
    // Resolve the selection inside every load: a Project switch while the
    // folder is open loads the newly selected Project's Members.
    const selection = await this.references.getSelection(signal);
    if (!selection) return [];
    const collection = await this.references.listMemberChanges(selection.projectId, signal);
    const current = await this.references.getSelection(signal);
    if (current?.projectId !== selection.projectId) {
      throw new DOMException('The selected Collab Project changed.', 'AbortError');
    }
    const normalizedQuery = query.toLocaleLowerCase();
    const nameCounts = new Map<string, number>();
    for (const member of collection.items) {
      const name = member.displayName.toLocaleLowerCase();
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    return collection.items
      .filter(member => (
        member.requestId.length > 0
        && member.displayName.toLocaleLowerCase().includes(normalizedQuery)
      ))
      .map(member => {
        const duplicate = (nameCounts.get(member.displayName.toLocaleLowerCase()) ?? 0) > 1;
        const detail = duplicate
          ? 'Duplicate member name'
          : member.currentMember
            ? 'You'
            : collection.stale
              ? 'Offline cache'
              : undefined;
        return {
          detail,
          disabled: duplicate,
          icon: 'git-branch',
          id: `collab-member:${member.memberId}`,
          kind: 'value',
          label: member.displayName,
          replacement: `@${member.displayName}'s Changes `,
        };
      });
  }
}
