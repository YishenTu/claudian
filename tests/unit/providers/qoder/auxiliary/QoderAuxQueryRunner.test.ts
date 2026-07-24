import { extractQoderStreamDeltaText } from '@/providers/qoder/auxiliary/QoderAuxQueryRunner';

describe('extractQoderStreamDeltaText', () => {
  it('returns only user-visible text deltas', () => {
    expect(extractQoderStreamDeltaText({
      delta: { text: 'answer', type: 'text_delta' },
    })).toBe('answer');
    expect(extractQoderStreamDeltaText({
      delta: { thinking: 'private reasoning', type: 'thinking_delta' },
    })).toBe('');
    expect(extractQoderStreamDeltaText({
      delta: { partial_json: '{"path":', type: 'input_json_delta' },
    })).toBe('');
  });
});
