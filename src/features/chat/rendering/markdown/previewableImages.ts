import { t } from '@/i18n/i18n';
import type { ImagePreviewSource } from '@/shared/modals/ImagePreviewModal';

/** Native button wrapping a rendered Markdown image so it opens a full preview. */
export const PREVIEWABLE_IMAGE_BUTTON_CLASS = 'claudian-embedded-image-button';

/**
 * Markdown images: Claudian's `![[...]]` embeds, Obsidian's vault embeds (whose image arrives
 * when the embed loads), and external `![](url)` images. Plugin-rendered diagrams are excluded.
 */
const PREVIEWABLE_IMAGE_SELECTOR = '.claudian-embedded-image > img, .internal-embed img, p > img';

function previewName(image: HTMLImageElement): string {
  return image.alt
    || image.closest('.internal-embed')?.getAttribute('src')
    || t('chat.images.label');
}

/** The preview to open for a previewable image button, or null for any other element. */
export function getImagePreview(trigger: Element): ImagePreviewSource | null {
  const image = trigger.closest(`button.${PREVIEWABLE_IMAGE_BUTTON_CLASS}`)?.querySelector('img');
  return image ? { src: image.currentSrc || image.src, name: previewName(image) } : null;
}

/**
 * Wraps the Markdown images at or inside `root` in native preview buttons. Runs on the rendered
 * DOM, so it neither depends on the host sanitizer keeping `<button>` markup nor misses embeds
 * that load later. Idempotent.
 */
export function makeImagesPreviewable(root: Element): void {
  const images = [...root.querySelectorAll<HTMLImageElement>(PREVIEWABLE_IMAGE_SELECTOR)];
  if (root.localName === 'img' && root.matches(PREVIEWABLE_IMAGE_SELECTOR)) images.push(root as HTMLImageElement);
  for (const image of images) {
    // An authored link keeps its own action, and controls must not nest.
    if (image.closest('a, button')) continue;
    const button = image.parentElement!.createEl('button', {
      cls: PREVIEWABLE_IMAGE_BUTTON_CLASS,
      attr: { type: 'button', 'aria-label': t('chat.images.previewImage', { name: previewName(image) }) },
    });
    // createEl appends; move the button into the image's place, then the image into the button.
    image.replaceWith(button);
    button.appendChild(image);
  }
}
