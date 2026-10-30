import type { KeymapContext } from 'obsidian';

interface HostScope {
  win: Window | null;
  handleKey(event: KeyboardEvent, context: KeymapContext): unknown;
}

const keymaps = new Set<() => void>();

/** Release App-owned capture listeners between tests, including registered popout windows. */
export function resetObsidianKeymaps(): void {
  for (const dispose of keymaps) dispose();
}

// Obsidian 1.13.7 app.js ey/ry/oy: virtual keys use legacy key codes, not event.code.
const virtualKeys: Record<number, string> = {
  3: 'Cancel', 6: 'Help', 8: 'Backspace', 9: 'Tab', 12: 'Clear', 13: 'Enter',
  16: 'Shift', 17: 'Control', 18: 'Alt', 19: 'Pause', 20: 'CapsLock', 27: 'Escape',
  28: 'Convert', 29: 'NonConvert', 30: 'Accept', 31: 'ModeChange', 32: ' ',
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: 'ArrowLeft', 38: 'ArrowUp',
  39: 'ArrowRight', 40: 'ArrowDown', 41: 'Select', 42: 'Print', 43: 'Execute',
  44: 'PrintScreen', 45: 'Insert', 46: 'Delete', 91: 'OS', 93: 'ContextMenu', 95: 'Sleep',
  106: '*', 107: '+', 109: '-', 110: '.', 111: '/', 144: 'NumLock', 145: 'ScrollLock',
  181: 'VolumeMute', 182: 'VolumeDown', 183: 'VolumeUp', 186: ';', 187: '=', 188: ',',
  189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'",
  224: 'Meta', 225: 'AltGraph', 246: 'Attn', 247: 'CrSel', 248: 'ExSel', 249: 'EraseEof',
  250: 'Play', 251: 'ZoomOut',
};
for (let code = 48; code <= 57; code++) virtualKeys[code] = String.fromCharCode(code);
for (let code = 65; code <= 90; code++) virtualKeys[code] = String.fromCharCode(code);
for (let code = 96; code <= 105; code++) virtualKeys[code] = `Numpad${code - 96}`;
for (let number = 1; number <= 24; number++) virtualKeys[111 + number] = `F${number}`;

function keyContext(event: KeyboardEvent): KeymapContext {
  const code = event.which || event.keyCode;
  return {
    modifiers: [
      ...(event.ctrlKey ? ['Ctrl'] : []), ...(event.metaKey ? ['Meta'] : []),
      ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []),
    ].sort().join(','),
    key: event.key || virtualKeys[code] || null,
    vkey: event.which === 54 && event.key === '^' && event.code === 'KeyI'
      ? 'KeyI' : virtualKeys[code] ?? `Key${code}`,
  };
}

/** Models uy's per-window scope stacks and keydown routing; does not simulate native focus trapping. */
export function createObsidianKeymap<S extends HostScope>(rootScope: S, activeWindow: () => Window | null) {
  type WindowStack = { scope: HostScope; prevScopes: HostScope[]; remove?: () => void };
  const windows = new Map<Window, WindowStack>();
  const stackFor = (target: Window): WindowStack => {
    let stack = windows.get(target);
    if (!stack) {
      stack = { scope: rootScope, prevScopes: [] };
      windows.set(target, stack);
    }
    return stack;
  };
  const registerWindow = (target: Window): (() => void) => {
    keymaps.add(dispose);
    const stack = stackFor(target);
    if (stack.remove) return stack.remove;
    const onKeyEvent = (event: KeyboardEvent): void => {
      const context = keyContext(event);
      if (['Control', 'Alt', 'Shift', 'OS', 'Meta'].includes(context.key ?? '')) return;
      if (stack.scope.handleKey(event, context) === false) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const remove = (): void => {
      target.removeEventListener('keydown', onKeyEvent, true);
      if (stack.remove === remove) stack.remove = undefined;
    };
    stack.remove = remove;
    target.addEventListener('keydown', onKeyEvent, true);
    return remove;
  };
  const dispose = (): void => {
    for (const [target, stack] of windows) {
      stack.remove?.();
      for (const scope of [stack.scope, ...stack.prevScopes]) {
        if (scope.win === target) scope.win = null;
      }
    }
    windows.clear();
    keymaps.delete(dispose);
  };
  keymaps.add(dispose);
  // Non-DOM service tests can construct an App without a browser window.
  if (typeof document !== 'undefined' && document.defaultView) registerWindow(document.defaultView);
  return {
    getRootScope: () => rootScope,
    registerWindow,
    setWindowBaseScope: (target: Window, scope: HostScope): void => { stackFor(target).scope = scope; },
    pushScope: vi.fn((scope: HostScope): void => {
      const target = activeWindow();
      if (!target) return;
      registerWindow(target);
      const stack = stackFor(target);
      if (stack.scope !== scope) {
        stack.prevScopes.push(stack.scope);
        stack.scope = scope;
        scope.win = target;
      }
    }),
    popScope: vi.fn((scope: HostScope): void => {
      if (scope === rootScope || !scope.win) return;
      const stack = stackFor(scope.win);
      if (stack.scope === scope) stack.scope = stack.prevScopes.pop() ?? rootScope;
      else stack.prevScopes = stack.prevScopes.filter(previous => previous !== scope);
      scope.win = null;
    }),
    dispose,
  };
}
