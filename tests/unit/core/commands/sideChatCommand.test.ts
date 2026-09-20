import {
  detectBuiltInCommand,
  detectSideChatCommand,
  isSideChatCommandSupported,
} from '@/core/commands/builtInCommands';

const forkCapable = { providerId: 'claude' as const, supportsFork: true };
const forkIncapable = { providerId: 'opencode' as const, supportsFork: false };

describe('detectSideChatCommand', () => {
  it.each([
    ['/side', ''],
    ['/btw', ''],
    ['/SIDE', ''],
    ['/side explore an append-only log', 'explore an append-only log'],
    ['/btw   spaced argument  ', 'spaced argument'],
    ['/side line one\nline two', 'line one\nline two'],
    ['  /side leading whitespace', 'leading whitespace'],
  ])('recognizes %j with argument %j', (input, argument) => {
    expect(detectSideChatCommand(input)).toEqual({
      alias: input.trim().slice(1).split(/[\s]/)[0].toLowerCase(),
      argument,
    });
  });

  it.each([
    '/sid',
    '/sideways ask this',
    '/btwx',
    'please use /side later',
    'side',
    '',
  ])('treats %j as ordinary input', (input) => {
    expect(detectSideChatCommand(input)).toBeNull();
  });

  it('stays reserved for providers without fork support so it never reaches provider chat', () => {
    expect(detectSideChatCommand('/side explore', forkIncapable)).toEqual({
      alias: 'side',
      argument: 'explore',
    });
    expect(isSideChatCommandSupported(forkIncapable)).toBe(false);
    expect(isSideChatCommandSupported(forkCapable)).toBe(true);
  });

  it('keeps the built-in matcher single-line so existing commands are unaffected', () => {
    expect(detectBuiltInCommand('/side explore', forkCapable))
      .toMatchObject({ args: 'explore', command: { action: 'side' } });
    expect(detectBuiltInCommand('/side line one\nline two', forkCapable)).toBeNull();
    expect(detectBuiltInCommand('/clear line one\nline two', forkCapable)).toBeNull();
  });
});
