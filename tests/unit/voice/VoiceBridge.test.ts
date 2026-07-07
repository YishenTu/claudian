import { parseVoiceEvent, type VoiceEvent } from '../../../src/features/voice/VoiceBridge';

describe('parseVoiceEvent', () => {
  it('parses the ready handshake event', () => {
    expect(parseVoiceEvent('{"type":"ready"}')).toEqual({ type: 'ready' });
  });

  it('parses the initialized handshake event', () => {
    expect(parseVoiceEvent('{"type":"initialized"}')).toEqual({ type: 'initialized' });
  });

  it('parses a transcript event with text', () => {
    expect(parseVoiceEvent('{"type":"transcript","text":"hello world"}')).toEqual({
      type: 'transcript',
      text: 'hello world',
    });
  });

  it('parses speak-done and interrupted events', () => {
    expect(parseVoiceEvent('{"type":"speak-done"}')).toEqual({ type: 'speak-done' });
    expect(parseVoiceEvent('{"type":"interrupted"}')).toEqual({ type: 'interrupted' });
  });

  it('parses an error event with a message', () => {
    expect(parseVoiceEvent('{"type":"error","message":"boom"}')).toEqual({
      type: 'error',
      message: 'boom',
    });
  });

  it('parses a status event with backend fields', () => {
    expect(
      parseVoiceEvent('{"type":"status","status":"ready","stt":"groq","tts":"elevenlabs"}'),
    ).toEqual({ type: 'status', status: 'ready', stt: 'groq', tts: 'elevenlabs' });
  });

  it('tolerates surrounding whitespace on a line', () => {
    expect(parseVoiceEvent('  {"type":"ready"}  ')).toEqual({ type: 'ready' });
  });

  it('returns null for a blank line', () => {
    expect(parseVoiceEvent('')).toBeNull();
    expect(parseVoiceEvent('   ')).toBeNull();
  });

  it('turns a malformed JSON line into an error event instead of throwing', () => {
    const event = parseVoiceEvent('not json at all');
    expect(event?.type).toBe('error');
    expect(event?.message).toContain('unmarshal event');
  });

  it('turns valid JSON without a type field into an error event', () => {
    const event = parseVoiceEvent('{"foo":"bar"}');
    expect(event?.type).toBe('error');
    expect(event?.message).toContain('malformed event');
  });

  it('turns a JSON array into an error event (not an object with a type)', () => {
    const event = parseVoiceEvent('[1,2,3]');
    expect(event?.type).toBe('error');
  });

  it('parses a full handshake sequence line-by-line (reader loop semantics)', () => {
    const feed = '{"type":"ready"}\n{"type":"initialized"}\n{"type":"transcript","text":"hi"}\n';
    const events = feed
      .split('\n')
      .map(parseVoiceEvent)
      .filter((e): e is VoiceEvent => e !== null);
    expect(events.map((e) => e.type)).toEqual(['ready', 'initialized', 'transcript']);
    expect(events[2].text).toBe('hi');
  });
});
