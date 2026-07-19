import { buildKimiPromptBlocks } from '@/providers/kimi/runtime/buildKimiPrompt';

describe('buildKimiPromptBlocks', () => {
  it('includes image and external context resource_link blocks', () => {
    const blocks = buildKimiPromptBlocks({
      text: 'hello',
      images: [
        { data: 'base64data', mediaType: 'image/png' } as any,
      ],
      externalContextPaths: ['/vault/note.md'],
    } as any);

    expect(blocks[0]).toEqual({ type: 'text', text: 'hello' });
    expect(blocks).toEqual(expect.arrayContaining([
      {
        type: 'image',
        data: 'base64data',
        mimeType: 'image/png',
      },
      {
        type: 'resource_link',
        name: 'note.md',
        uri: 'file:///vault/note.md',
      },
    ]));
  });
});
