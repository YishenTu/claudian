import {
  applyToolResultPresentation,
  mergeToolResultDetails,
  normalizeToolResultDetails,
} from '@/core/tools/toolResultDetails';
import type { ToolCallInfo, ToolResultDetails } from '@/core/types';

describe('normalizeToolResultDetails', () => {
  it('keeps valid fields and drops malformed entries', () => {
    const malformed = {
      resultFormat: 'plain',
      webSearchResults: [
        { title: '', url: 'https://example.com/a', snippet: '' },
        { title: 'No URL', url: '' },
      ],
      webSearchSummary: 'Summary',
      resultImages: [
        { kind: 'file', path: '/tmp/a.png' },
        { kind: 'data', mediaType: 'text/plain', data: 'eA==' },
      ],
      scriptToolCalls: [
        { name: 'Write', status: 'completed', durationMs: Number.NaN },
        { name: 'Read', status: 'unknown' },
      ],
      resolvedAnswers: { 'Color?': ['Blue'], 'Empty?': '' },
    } as unknown as ToolResultDetails;

    expect(normalizeToolResultDetails(malformed)).toEqual({
      resultFormat: 'plain',
      webSearchResults: [{ title: 'https://example.com/a', url: 'https://example.com/a' }],
      webSearchSummary: 'Summary',
      resultImages: [{ kind: 'file', path: '/tmp/a.png' }],
      scriptToolCalls: [{ name: 'Write', status: 'completed' }],
      resolvedAnswers: { 'Color?': 'Blue' },
    });
  });

  it('returns undefined when nothing usable remains', () => {
    expect(normalizeToolResultDetails({ webSearchResults: [], webSearchSummary: '  ' })).toBeUndefined();
  });
});

describe('tool result presentation', () => {
  it('lets later fields override earlier ones without clearing absent fields', () => {
    const merged = mergeToolResultDetails(
      { resultFormat: 'plain', webSearchSummary: 'Native' },
      { webSearchSummary: 'Provider' },
    );
    const toolCall: ToolCallInfo = {
      id: 'tool', name: 'WebSearch', input: {}, status: 'completed',
      resultImages: [{ kind: 'file', path: '/tmp/earlier.png' }],
    };

    applyToolResultPresentation(toolCall, merged);

    expect(toolCall).toMatchObject({
      resultFormat: 'plain',
      webSearchSummary: 'Provider',
      resultImages: [{ kind: 'file', path: '/tmp/earlier.png' }],
    });
  });
});
