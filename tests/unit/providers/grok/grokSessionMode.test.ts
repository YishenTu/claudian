import { resolveGrokAcpModeId } from '@/providers/grok/runtime/grokSessionMode';

describe('resolveGrokAcpModeId', () => {
  it('maps plan to ACP plan mode', () => {
    expect(resolveGrokAcpModeId('plan')).toBe('plan');
  });

  it('maps normal and yolo to ACP default mode', () => {
    expect(resolveGrokAcpModeId('normal')).toBe('default');
    expect(resolveGrokAcpModeId('yolo')).toBe('default');
    expect(resolveGrokAcpModeId(undefined)).toBe('default');
    expect(resolveGrokAcpModeId('')).toBe('default');
  });
});
