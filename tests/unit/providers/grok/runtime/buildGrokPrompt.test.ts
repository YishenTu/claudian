import {
  buildGrokPromptBlocks,
  buildGrokPromptText,
} from '@/providers/grok/runtime/buildGrokPrompt';

describe('buildGrokPrompt', () => {
  it('builds the contextual text block followed by every non-empty image', () => {
    const request = {
      currentNotePath: 'notes/current.md',
      images: [
        {
          data: 'aGVsbG8=',
          id: 'image-1',
          mediaType: 'image/png' as const,
          name: 'sample.png',
          size: 5,
          source: 'paste' as const,
        },
        {
          data: '',
          id: 'image-empty',
          mediaType: 'image/webp' as const,
          name: 'empty.webp',
          size: 0,
          source: 'drop' as const,
        },
      ],
      text: 'Describe this image.',
    };

    expect(buildGrokPromptBlocks(request)).toEqual([
      {
        text: buildGrokPromptText(request),
        type: 'text',
      },
      {
        data: 'aGVsbG8=',
        mimeType: 'image/png',
        type: 'image',
      },
    ]);
  });

  it('retains a text block for an image-only turn', () => {
    expect(buildGrokPromptBlocks({
      images: [{
        data: 'aGVsbG8=',
        id: 'image-1',
        mediaType: 'image/jpeg',
        name: 'sample.jpg',
        size: 5,
        source: 'file',
      }],
      text: '',
    })).toEqual([
      { text: '', type: 'text' },
      { data: 'aGVsbG8=', mimeType: 'image/jpeg', type: 'image' },
    ]);
  });
});
