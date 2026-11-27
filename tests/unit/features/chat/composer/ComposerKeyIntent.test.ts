// @vitest-environment jsdom
import { Platform } from 'obsidian';

import { composerSteerShortcut, resolveComposerKeyIntent } from '@/features/chat/composer/ComposerKeyIntent';

type Chord = 'Enter' | 'Shift+Enter' | 'Mod+Enter' | 'Mod+Shift+Enter' | 'Alt+Enter' | 'Mod+Alt+Enter' | 'Other+Enter';

function keydown(chord: Chord, mac: boolean, init: KeyboardEventInit = {}): KeyboardEvent {
  const parts = chord.split('+');
  return new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
    metaKey: parts.includes('Mod') ? mac : parts.includes('Other') && !mac,
    ctrlKey: parts.includes('Mod') ? !mac : parts.includes('Other') && mac,
    ...init,
  });
}

const byDefaultSettings = { requireCommandOrControlEnterToSend: false };
const priorPlatform = Platform.isMacOS;
afterEach(() => { Platform.isMacOS = priorPlatform; });

describe.each([true, false])('resolveComposerKeyIntent (macOS=%s)', mac => {
  beforeEach(() => { Platform.isMacOS = mac; });

  it.each<[Chord, 'send' | 'steer' | null, 'send' | 'steer' | null]>([
    // chord,             Enter sends,  Mod+Enter required
    ['Enter',             'send',       null],
    ['Shift+Enter',       null,         null],
    ['Mod+Enter',         'steer',      'send'],
    ['Mod+Shift+Enter',   null,         'steer'],
    ['Alt+Enter',         'send',       null],
    ['Mod+Alt+Enter',     'send',       null],
    ['Other+Enter',       'send',       null],
  ])('%s resolves to %s by default and %s when the modifier is required', (chord, byDefault, whenRequired) => {
    expect(resolveComposerKeyIntent(keydown(chord, mac), byDefaultSettings)).toBe(byDefault);
    expect(resolveComposerKeyIntent(keydown(chord, mac), { requireCommandOrControlEnterToSend: true })).toBe(whenRequired);
  });

  it.each([byDefaultSettings, { requireCommandOrControlEnterToSend: true }])('ignores composition and other keys (%o)', settings => {
    expect(resolveComposerKeyIntent(keydown('Mod+Enter', mac, { isComposing: true }), settings)).toBeNull();
    expect(resolveComposerKeyIntent(keydown('Enter', mac, { isComposing: true }), settings)).toBeNull();
    expect(resolveComposerKeyIntent(new KeyboardEvent('keydown', { key: 'a', metaKey: mac, ctrlKey: !mac }), settings)).toBeNull();
  });

  it('names the steer chord for the active send-key mode', () => {
    const steerByDefault = composerSteerShortcut(byDefaultSettings);
    const steerWhenRequired = composerSteerShortcut({ requireCommandOrControlEnterToSend: true });
    expect([steerByDefault, steerWhenRequired]).toEqual(mac
      ? [{ label: '⌘↵', ariaKeyShortcuts: 'Meta+Enter' }, { label: '⇧⌘↵', ariaKeyShortcuts: 'Meta+Shift+Enter' }]
      : [{ label: 'Ctrl+Enter', ariaKeyShortcuts: 'Control+Enter' }, { label: 'Ctrl+Shift+Enter', ariaKeyShortcuts: 'Control+Shift+Enter' }]);
    // The named chord is the one the resolver steers with.
    expect(resolveComposerKeyIntent(keydown('Mod+Enter', mac), byDefaultSettings)).toBe('steer');
    expect(resolveComposerKeyIntent(keydown('Mod+Shift+Enter', mac), { requireCommandOrControlEnterToSend: true })).toBe('steer');
  });
});
