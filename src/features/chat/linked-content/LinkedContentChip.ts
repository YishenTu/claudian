import type { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';
import type { LinkedContentPresentation } from '@/features/chat/linked-content/LinkedContentPresentation';

/** Presents Linked content in the composer info row, under the input box. */
export class LinkedContentChip {
  constructor(
    private readonly infoRow: ComposerInfoRow,
    private readonly onActivate: () => void,
    private readonly onRemove: () => void,
  ) {}

  render(content: LinkedContentPresentation | null, removable: boolean): void {
    if (!content) {
      this.infoRow.setLinkedContent(null);
      return;
    }
    this.infoRow.setLinkedContent({
      label: content.missing ? `${content.label} · Missing content` : content.label,
      icon: content.icon,
      ariaLabel: content.missing
        ? `Linked content: ${content.path}. Missing content`
        : `Linked content: ${content.path}`,
      missing: content.missing,
      onActivate: this.onActivate,
      ...(removable ? { onRemove: this.onRemove } : {}),
    });
  }

  destroy(): void {
    this.infoRow.setLinkedContent(null);
  }
}
