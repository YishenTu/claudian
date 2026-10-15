import { decodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';
import { buildOpencodePrompt } from '@/providers/opencode/runtime/buildOpencodePrompt';

describe('buildOpencodePrompt text', () => {
  it('appends Claudian XML context to the user query', () => {
    const result = buildOpencodePrompt({
      browserSelection: {
        selectedText: 'Browser quote',
        source: 'browser:https://example.com',
        title: 'Example',
        url: 'https://example.com',
      },
      linkedContent: { path: 'notes/"today" & draft.md' },
      editorSelection: {
        mode: 'selection',
        notePath: 'notes/"today" & draft.md',
        selectedText: 'Selected text',
        startLine: 4,
        lineCount: 2,
      },
      text: 'Summarize this',
    });

    const [block] = result.blocks;
    const prompt = block.type === 'text' ? block.text : '';
    expect(result.userText).toEqual({ start: 0, end: 'Summarize this'.length });
    expect(prompt).toContain('Summarize this');
    expect(prompt).toContain('<linked_content path="notes/&quot;today&quot; &amp; draft.md" />');
    expect(prompt).not.toMatch(/<(?:linked_note|current_note)\b/);
    expect(prompt).toContain('<editor_selection path="notes/&quot;today&quot; &amp; draft.md" lines="4-5">');
    expect(prompt).toContain('<browser_selection source="browser:https://example.com" title="Example" url="https://example.com">');
  });

  it('encodes Linked content without allowing CDATA to close early', () => {
    const result = buildOpencodePrompt({
      linkedContent: {
        content: 'Before\n]]>\nAfter',
        path: 'notes/"draft".md',
      },
      text: 'Review this',
    });

    const [block] = result.blocks;
    const prompt = block.type === 'text' ? block.text : '';
    expect(result.userText).toEqual({ start: 0, end: 'Review this'.length });
    expect(prompt).toContain(
      '<linked_content path="notes/&quot;draft&quot;.md">\n<![CDATA[Before\n]]]]><![CDATA[>\nAfter]]>\n</linked_content>',
    );
    expect(prompt).not.toMatch(/<(?:linked_note|current_note)\b/);
  });

  it('rebuilds prior conversation context when a native session must be recreated', () => {
    const result = buildOpencodePrompt(
      {
        text: 'Continue with the fix',
      },
      [
        {
          content: 'Inspect the bug',
          id: 'user-1',
          role: 'user',
          timestamp: 1,
        },
        {
          content: 'I found the failing path',
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 2,
        },
      ],
    );

    const [block] = result.blocks;
    const prompt = block.type === 'text' ? block.text : '';
    expect(result.userText).toEqual({ start: prompt.length - 'Continue with the fix'.length, end: prompt.length });
    expect(prompt).toContain('User: Inspect the bug');
    expect(prompt).toContain('Assistant: I found the failing path');
    // History readers strip the replayed history and keep only this turn's input.
    expect(decodeRecoveryPrompt(prompt)).toEqual({ currentInput: 'Continue with the fix' });
  });

  it('replays an unanswered final query without repeating it as current input', () => {
    const result = buildOpencodePrompt(
      { text: 'Retry this' },
      [{ content: 'Retry this', id: 'user-1', role: 'user', timestamp: 1 }],
    );

    const [block] = result.blocks;
    const prompt = block.type === 'text' ? block.text : '';
    expect(result.userText).toBeNull();
    expect(prompt).toContain('User: Retry this');
    expect(decodeRecoveryPrompt(prompt)).toEqual({ currentInput: null });
  });
});

describe('buildOpencodePrompt images', () => {
  it('includes image attachments after the main text block', () => {
    const { blocks } = buildOpencodePrompt({
      images: [{
        data: 'base64-image',
        id: 'img-1',
        mediaType: 'image/png',
        name: 'diagram.png',
        size: 123,
        source: 'file',
      }],
      text: 'Inspect this image',
    });

    expect(blocks).toEqual([
      { type: 'text', text: 'Inspect this image' },
      { type: 'image', mimeType: 'image/png', data: 'base64-image' },
    ]);
  });
});
