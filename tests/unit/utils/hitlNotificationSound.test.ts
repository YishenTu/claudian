import {
  isWaveAudioBuffer,
  normalizeHitlNotificationSoundPath,
} from '../../../src/utils/hitlNotificationSound';

describe('normalizeHitlNotificationSoundPath', () => {
  it('accepts a WAV file inside .claudian/sounds/', () => {
    expect(normalizeHitlNotificationSoundPath('.claudian/sounds/approval.wav'))
      .toBe('.claudian/sounds/approval.wav');
  });

  it('normalizes backslashes and leading slashes', () => {
    expect(normalizeHitlNotificationSoundPath('/.claudian\\sounds\\approval.wav'))
      .toBe('.claudian/sounds/approval.wav');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeHitlNotificationSoundPath('  .claudian/sounds/approval.wav  '))
      .toBe('.claudian/sounds/approval.wav');
  });

  it('accepts uppercase WAV extensions', () => {
    expect(normalizeHitlNotificationSoundPath('.claudian/sounds/APPROVAL.WAV'))
      .toBe('.claudian/sounds/APPROVAL.WAV');
  });

  it('rejects paths outside .claudian/sounds/', () => {
    expect(normalizeHitlNotificationSoundPath('sounds/approval.wav')).toBeNull();
    expect(normalizeHitlNotificationSoundPath('.claudian/approval.wav')).toBeNull();
  });

  it('rejects path traversal', () => {
    expect(normalizeHitlNotificationSoundPath('.claudian/sounds/../../secret.wav')).toBeNull();
    expect(normalizeHitlNotificationSoundPath('.claudian/sounds/./approval.wav')).toBeNull();
  });

  it('rejects non-WAV extensions', () => {
    expect(normalizeHitlNotificationSoundPath('.claudian/sounds/approval.mp3')).toBeNull();
    expect(normalizeHitlNotificationSoundPath('.claudian/sounds/approval')).toBeNull();
  });

  it('rejects non-string values', () => {
    expect(normalizeHitlNotificationSoundPath(undefined)).toBeNull();
    expect(normalizeHitlNotificationSoundPath(null)).toBeNull();
    expect(normalizeHitlNotificationSoundPath(42)).toBeNull();
    expect(normalizeHitlNotificationSoundPath('')).toBeNull();
  });
});

describe('isWaveAudioBuffer', () => {
  function waveBytes(): Uint8Array {
    const bytes = new Uint8Array(16);
    const magic = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45];
    magic.forEach((value, index) => {
      bytes[index] = value;
    });
    return bytes;
  }

  it('accepts a RIFF/WAVE header as Uint8Array', () => {
    expect(isWaveAudioBuffer(waveBytes())).toBe(true);
  });

  it('accepts a RIFF/WAVE header as ArrayBuffer', () => {
    const source = waveBytes();
    const buffer = new ArrayBuffer(source.byteLength);
    new Uint8Array(buffer).set(source);
    expect(isWaveAudioBuffer(buffer)).toBe(true);
  });

  it('rejects buffers shorter than a WAV header', () => {
    expect(isWaveAudioBuffer(new Uint8Array(8))).toBe(false);
    expect(isWaveAudioBuffer(new Uint8Array(0))).toBe(false);
  });

  it('rejects non-WAV magic bytes', () => {
    const bytes = waveBytes();
    bytes[0] = 0x4f; // corrupt "RIFF"
    expect(isWaveAudioBuffer(bytes)).toBe(false);

    const wrongFormat = waveBytes();
    wrongFormat[8] = 0x41; // corrupt "WAVE"
    expect(isWaveAudioBuffer(wrongFormat)).toBe(false);
  });
});
