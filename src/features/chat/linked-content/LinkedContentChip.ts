import type { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';
import type { LinkedContentPresentation } from '@/features/chat/linked-content/LinkedContentPresentation';
import { t } from '@/i18n/i18n';

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
      label: content.missing ? `${content.label} · ${t('chat.linkedContent.missing')}` : content.label,
      icon: content.icon,
      ariaLabel: content.missing
        ? t('chat.linkedContent.missingPath', { path: content.path })
        : t('chat.linkedContent.path', { path: content.path }),
      missing: content.missing,
      onActivate: this.onActivate,
      ...(removable ? { onRemove: this.onRemove } : {}),
    });
  }

  destroy(): void {
    this.infoRow.setLinkedContent(null);
  }
}
