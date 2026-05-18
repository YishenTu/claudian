/**
 * @jest-environment jsdom
 */

import {
  autoResizeTextarea,
  calculateTextareaMaxHeight,
  calculateTextareaMinHeight,
  TEXTAREA_BASE_MIN_HEIGHT,
  TEXTAREA_MAX_HEIGHT_PERCENT,
  TEXTAREA_MIN_MAX_HEIGHT,
} from '@/features/chat/ui/textareaResize';

describe('textareaResize', () => {
  it('returns the base height when content exactly matches base flex allocation', () => {
    expect(calculateTextareaMinHeight({
      contentHeight: 102,
      flexAllocatedHeight: 102,
    })).toBe(TEXTAREA_BASE_MIN_HEIGHT);
  });

  it('uses the content height when content exceeds flex allocation', () => {
    expect(calculateTextareaMinHeight({
      contentHeight: 128,
      flexAllocatedHeight: 102,
    })).toBe(128);
  });

  it('returns the base height when content fits inside flex allocation', () => {
    expect(calculateTextareaMinHeight({
      contentHeight: 80,
      flexAllocatedHeight: 102,
    })).toBe(TEXTAREA_BASE_MIN_HEIGHT);
  });

  it('measures from base height so previously grown content can shrink', () => {
    const textarea = createResizeTextarea({
      baseOffsetHeight: 102,
      grownOffsetHeight: 116,
      baseScrollHeight: 102,
      grownScrollHeight: 116,
    });

    textarea.style.setProperty('--claudian-textarea-min-height', '116px');

    autoResizeTextarea(textarea);

    expect(textarea.style.getPropertyValue('--claudian-textarea-min-height')).toBe('60px');
  });

  it('measures from base height so long content does not bounce', () => {
    const textarea = createResizeTextarea({
      baseOffsetHeight: 102,
      grownOffsetHeight: 116,
      baseScrollHeight: 116,
      grownScrollHeight: 116,
    });

    textarea.style.setProperty('--claudian-textarea-min-height', '116px');

    autoResizeTextarea(textarea);

    expect(textarea.style.getPropertyValue('--claudian-textarea-min-height')).toBe('116px');
  });

  it('caps max height by viewport percentage with a minimum usable cap', () => {
    expect(calculateTextareaMaxHeight(100)).toBe(TEXTAREA_MIN_MAX_HEIGHT);
    expect(calculateTextareaMaxHeight(1000)).toBe(1000 * TEXTAREA_MAX_HEIGHT_PERCENT);
  });
});

function createResizeTextarea({
  baseOffsetHeight,
  grownOffsetHeight,
  baseScrollHeight,
  grownScrollHeight,
}: {
  baseOffsetHeight: number;
  grownOffsetHeight: number;
  baseScrollHeight: number;
  grownScrollHeight: number;
}): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');

  textarea.setCssProps = (props: Record<string, string>) => {
    Object.entries(props).forEach(([key, value]) => {
      textarea.style.setProperty(key, value);
    });
  };

  const isBaseHeight = () =>
    textarea.style.getPropertyValue('--claudian-textarea-min-height') === `${TEXTAREA_BASE_MIN_HEIGHT}px`;

  Object.defineProperty(textarea, 'offsetHeight', {
    get: () => (isBaseHeight() ? baseOffsetHeight : grownOffsetHeight),
  });
  Object.defineProperty(textarea, 'scrollHeight', {
    get: () => (isBaseHeight() ? baseScrollHeight : grownScrollHeight),
  });

  return textarea;
}
