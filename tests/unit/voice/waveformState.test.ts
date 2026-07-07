import { waveformModeClass, waveformModeForState } from '../../../src/features/voice/waveformState';

describe('waveformModeForState', () => {
  it('maps idle to calm', () => {
    expect(waveformModeForState('idle')).toBe('calm');
  });

  it('maps listening to listening', () => {
    expect(waveformModeForState('listening')).toBe('listening');
  });

  it('reuses the listening motion for thinking', () => {
    expect(waveformModeForState('thinking')).toBe('listening');
  });

  it('maps speaking to speaking', () => {
    expect(waveformModeForState('speaking')).toBe('speaking');
  });
});

describe('waveformModeClass', () => {
  it('builds the CSS modifier class for a mode', () => {
    expect(waveformModeClass('calm')).toBe('claudian-voice-waveform-calm');
    expect(waveformModeClass('listening')).toBe('claudian-voice-waveform-listening');
    expect(waveformModeClass('speaking')).toBe('claudian-voice-waveform-speaking');
  });
});
