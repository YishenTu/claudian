/** @jest-environment jsdom */

import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import {
  CollabDiffRenderer,
  type CollabDiffThemeSource,
  type PierreDiffInstance,
  type PierreDiffModule,
  type PierreDiffOptions,
  type PierreDiffRenderInput,
} from '@/features/collab/detail/review/CollabDiffRenderer';

describe('CollabDiffRenderer', () => {
  it('loads Diffs lazily and renders exactly one text file without annotation controls', async () => {
    const harness = diffsHarness();
    const renderer = new CollabDiffRenderer({
      loadDiffs: harness.load,
      themeSource: themeSource('dark'),
    });
    const container = document.createElement('div');

    expect(harness.load).not.toHaveBeenCalled();
    await renderer.render({
      container,
      newText: 'new\n',
      oldText: 'old\n',
      path: 'note.md',
    });

    expect(harness.load).toHaveBeenCalledTimes(1);
    expect(harness.options).toEqual([{
      diffStyle: 'unified',
      disableErrorHandling: true,
      overflow: 'wrap',
      preferredHighlighter: 'shiki-js',
      themeType: 'dark',
      unsafeCSS: expect.stringContaining(
        '--diffs-bg-separator-override: var(--background-primary);',
      ),
    }]);
    expect(harness.instances[0].render).toHaveBeenCalledWith({
      containerWrapper: container,
      newFile: { contents: 'new\n', lang: 'text', name: 'note.md' },
      oldFile: { contents: 'old\n', lang: 'text', name: 'note.md' },
    });
  });

  it('switches an active diff between unified and split layouts without reloading it', async () => {
    const harness = diffsHarness();
    const renderer = new CollabDiffRenderer({
      loadDiffs: harness.load,
      themeSource: themeSource('dark'),
    });

    await renderer.render({ ...input('note.md'), layout: 'split' });
    renderer.setLayout('unified');

    expect(harness.load).toHaveBeenCalledTimes(1);
    expect(harness.instances[0].render).toHaveBeenCalledTimes(1);
    expect(harness.options[0]).toEqual(expect.objectContaining({ diffStyle: 'split' }));
    expect(harness.instances[0].setOptions).toHaveBeenCalledWith(
      expect.objectContaining({ diffStyle: 'unified' }),
    );
    expect(harness.instances[0].rerender).toHaveBeenCalledTimes(1);
  });

  it('renders a file-scoped open action in the Pierre filename header', async () => {
    const harness = diffsHarness();
    const onOpenFile = jest.fn();
    const renderer = new CollabDiffRenderer({
      loadDiffs: harness.load,
      themeSource: themeSource('dark'),
    });

    await renderer.render({ ...input('note.md'), onOpenFile });

    const action = harness.options[0].renderHeaderFilenameSuffix?.();
    expect(action).toBeInstanceOf(HTMLButtonElement);
    expect(action?.getAttribute('data-collab-review-open-file')).toBe('');
    expect(action?.getAttribute('aria-label')).toBe('Open this file');
    expect(action?.querySelector('svg')?.classList.contains('lucide-external-link')).toBe(true);

    action?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it('reuses the active instance and suppresses stale lazy-load completion', async () => {
    let resolveModule: ((module: PierreDiffModule) => void) | undefined;
    const delayed = new Promise<PierreDiffModule>(resolve => { resolveModule = resolve; });
    const harness = diffsHarness();
    const renderer = new CollabDiffRenderer({
      loadDiffs: jest.fn(() => delayed),
      themeSource: themeSource('light'),
    });
    const first = renderer.render(input('first.md'));
    const second = renderer.render(input('second.md'));

    resolveModule?.(harness.module);
    await Promise.all([first, second]);
    expect(harness.instances).toHaveLength(1);
    expect(harness.instances[0].render).toHaveBeenCalledWith(expect.objectContaining({
      newFile: expect.objectContaining({ name: 'second.md' }),
    }));
    await renderer.render(input('third.md'));
    expect(harness.instances).toHaveLength(1);
    expect(harness.instances[0].render).toHaveBeenCalledTimes(2);
    expect(harness.instances[0].cleanUp).not.toHaveBeenCalled();
  });

  it('forces Pierre to reattach an unchanged diff when its wrapper changes', async () => {
    const harness = diffsHarness();
    const renderer = new CollabDiffRenderer({
      loadDiffs: harness.load,
      themeSource: themeSource('light'),
    });
    const first = input('note.md');
    const second = { ...input('note.md'), container: document.createElement('div') };

    await renderer.render(first);
    await renderer.render(second);

    expect(harness.instances[0].render).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ forceRender: true }),
    );
    expect(harness.instances[0].render).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ containerWrapper: second.container, forceRender: true }),
    );
  });

  it('updates the active instance when the Obsidian theme changes', async () => {
    const themes = themeSource('light');
    const harness = diffsHarness();
    const renderer = new CollabDiffRenderer({
      loadDiffs: harness.load,
      themeSource: themes,
    });
    await renderer.render(input('note.md'));

    themes.set('dark');
    expect(harness.instances[0].setThemeType).toHaveBeenCalledWith('dark');
    expect(harness.instances[0].onThemeChange).toHaveBeenCalledTimes(1);
  });

  it('forces every filename to plain text', async () => {
    const harness = diffsHarness();
    const renderer = new CollabDiffRenderer({
      loadDiffs: harness.load,
      themeSource: themeSource('light'),
    });
    const container = document.createElement('div');

    await renderer.render({
      container,
      newText: 'fn main() {}\n',
      oldText: '# Before\n',
      path: 'src/main.rs',
      previousPath: 'notes/before.md',
    });

    expect(harness.instances[0].render).toHaveBeenCalledWith({
      containerWrapper: container,
      newFile: { contents: 'fn main() {}\n', lang: 'text', name: 'src/main.rs' },
      oldFile: { contents: '# Before\n', lang: 'text', name: 'notes/before.md' },
    });
  });

  it('rejects malformed or over-limit text before loading Diffs', async () => {
    const harness = diffsHarness();
    const renderer = new CollabDiffRenderer({
      loadDiffs: harness.load,
      themeSource: themeSource('light'),
    });

    await expect(renderer.render({
      container: document.createElement('div'),
      newText: null,
      oldText: null,
      path: 'note.md',
    })).rejects.toMatchObject({ code: 'operation-failed' });
    await expect(renderer.render({
      ...input('large.md'),
      newText: 'x'.repeat(CLAUDIAN_COLLAB_LIMITS.maxTextDiffBytes + 1),
    })).rejects.toMatchObject({ code: 'quota-exceeded' });
    expect(harness.load).not.toHaveBeenCalled();
  });

  it('disposes the instance and theme listener even while a load is pending', async () => {
    let resolveModule: ((module: PierreDiffModule) => void) | undefined;
    const delayed = new Promise<PierreDiffModule>(resolve => { resolveModule = resolve; });
    const themes = themeSource('light');
    const harness = diffsHarness();
    const renderer = new CollabDiffRenderer({
      loadDiffs: jest.fn(() => delayed),
      themeSource: themes,
    });
    const pending = renderer.render(input('note.md'));

    renderer.destroy();
    resolveModule?.(harness.module);
    await pending;
    themes.set('dark');

    expect(harness.instances).toHaveLength(0);
    expect(themes.dispose).toHaveBeenCalledTimes(1);
  });

  it('retains exactly one Diffs instance across a 100-file review', async () => {
    const themes = themeSource('light');
    const harness = diffsHarness();
    const renderer = new CollabDiffRenderer({
      loadDiffs: harness.load,
      themeSource: themes,
    });

    for (let index = 0; index < 100; index += 1) {
      await renderer.render(input(`notes/note-${index}.md`));
    }

    expect(harness.load).toHaveBeenCalledTimes(1);
    expect(harness.instances).toHaveLength(1);
    expect(harness.instances[0].render).toHaveBeenCalledTimes(100);
    expect(harness.instances[0].cleanUp).not.toHaveBeenCalled();

    renderer.destroy();

    expect(harness.instances[0].cleanUp).toHaveBeenCalledTimes(1);
    expect(themes.dispose).toHaveBeenCalledTimes(1);
  });
});

function input(path: string) {
  return {
    container: document.createElement('div'),
    newText: 'new\n',
    oldText: 'old\n',
    path,
  };
}

function themeSource(initial: 'dark' | 'light') {
  let current = initial;
  const listeners = new Set<(theme: 'dark' | 'light') => void>();
  const dispose = jest.fn();
  const source: CollabDiffThemeSource & {
    dispose: jest.Mock;
    set(theme: 'dark' | 'light'): void;
  } = {
    current: () => current,
    dispose,
    set(theme) {
      current = theme;
      for (const listener of listeners) listener(theme);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        dispose();
      };
    },
  };
  return source;
}

function diffsHarness() {
  const instances: Array<PierreDiffInstance & {
    cleanUp: jest.Mock;
    onThemeChange: jest.Mock;
    render: jest.Mock;
    rerender: jest.Mock;
    setOptions: jest.Mock;
    setThemeType: jest.Mock;
  }> = [];
  const options: PierreDiffOptions[] = [];
  class FakeFileDiff implements PierreDiffInstance {
    readonly cleanUp = jest.fn();
    readonly onThemeChange = jest.fn();
    readonly render = jest.fn((_input: PierreDiffRenderInput) => true);
    readonly rerender = jest.fn();
    readonly setOptions = jest.fn();
    readonly setThemeType = jest.fn();

    constructor(value: PierreDiffOptions) {
      options.push(value);
      instances.push(this);
    }
  }
  const module: PierreDiffModule = { FileDiff: FakeFileDiff };
  return {
    instances,
    load: jest.fn(async () => module),
    module,
    options,
  };
}
