import { getDefaultHitlNotificationSound } from '../../../src/utils/hitlDefaultSound';
import {
  isWaveAudioBuffer,
  MAX_HITL_NOTIFICATION_SOUND_BYTES,
} from '../../../src/utils/hitlNotificationSound';

describe('getDefaultHitlNotificationSound', () => {
  it('returns a non-empty WAV buffer within the size limit', () => {
    const data = getDefaultHitlNotificationSound();
    expect(data.byteLength).toBeGreaterThan(0);
    expect(data.byteLength).toBeLessThanOrEqual(MAX_HITL_NOTIFICATION_SOUND_BYTES);
    expect(isWaveAudioBuffer(data)).toBe(true);
  });

  it('memoizes the decoded buffer', () => {
    expect(getDefaultHitlNotificationSound()).toBe(getDefaultHitlNotificationSound());
  });
});
