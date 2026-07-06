import {
  joinCodexUserTextParts,
  stripCodexImagePlaceholderText,
} from '@/providers/codex/codexUserText';

describe('codexUserText', () => {
  it('strips inline generated image placeholder tags', () => {
    expect(
      stripCodexImagePlaceholderText('<image name=[Image #1] path="/tmp/1-image-1.png"></image>what was in this img?'),
    ).toBe('what was in this img?');
  });

  it('strips generated image placeholder tags split across text parts', () => {
    expect(
      joinCodexUserTextParts([
        '<image name=[Image #1] path="/tmp/1-image-1.png">',
        '</image>',
        'what was in this img?',
      ], '\n\n'),
    ).toBe('what was in this img?');
  });
});
