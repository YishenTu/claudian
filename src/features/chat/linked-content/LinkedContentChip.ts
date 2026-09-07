import type { ComposerContextTray } from '@/features/chat/ui/ComposerContextTray';

import type { LinkedContentPresentation } from './LinkedContentPresentation';

export class LinkedContentChip {
  constructor(
    private readonly contextTray: ComposerContextTray,
    private readonly onActivate: () => void,
    private readonly onRemove: () => void,
  ) {}

  render(content: LinkedContentPresentation | null, removable: boolean): void {
    if (!content) {
      this.contextTray.clearItems('linked-content');
      return;
    }
    const missingLabel = content.missing ? `${content.label} · Missing content` : content.label;
    this.contextTray.setItems('linked-content', [{
      id: content.path,
      kind: 'content',
      label: missingLabel,
      icon: content.icon,
      ariaLabel: content.missing
        ? `Linked content: ${content.path}. Missing content`
        : `Linked content: ${content.path}`,
      ...(content.missing ? { status: 'missing' as const } : {}),
      onActivate: this.onActivate,
      ...(removable ? { onRemove: this.onRemove } : {}),
    }]);
  }

  destroy(): void {
    this.contextTray.clearItems('linked-content');
  }
}
