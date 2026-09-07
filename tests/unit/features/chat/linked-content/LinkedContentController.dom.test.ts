import { createMockEl, type MockElement } from '@test/helpers/MockElement';
import { FileView, Notice, TFile, TFolder } from 'obsidian';

import { LinkedContentController } from '@/features/chat/linked-content/LinkedContentController';
import { createWelcomeElement, renderWelcomeContent } from '@/features/chat/rendering/WelcomeRenderer';
import { ComposerContextTray } from '@/features/chat/ui/ComposerContextTray';

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  return { ...actual, Notice: jest.fn(), setIcon: jest.fn() };
});

function createFile(path: string): TFile {
  const file = new TFile();
  Object.assign(file, {
    path,
    name: path.split('/').pop() ?? '',
    basename: (path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''),
    extension: path.split('.').pop() ?? '',
  });
  return file;
}

function createFolder(path: string): TFolder {
  const folder = new TFolder();
  Object.assign(folder, { path, name: path.split('/').pop() ?? '' });
  return folder;
}

function createFileView(file: TFile): FileView {
  const view = Object.create(FileView.prototype) as FileView;
  Object.assign(view, { file });
  return view;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(options: {
  entries?: Array<TFile | TFolder>;
  rootLeaves?: Array<{ view?: unknown }>;
} = {}) {
  const root = createFolder('');
  const entries = new Map((options.entries ?? []).map(entry => [entry.path, entry]));
  const openFile = jest.fn().mockResolvedValue(undefined);
  const revealInFolder = jest.fn().mockResolvedValue(undefined);
  const explorerLeaf = { view: { revealInFolder } };
  const app = {
    vault: {
      getRoot: jest.fn(() => root),
      getAbstractFileByPath: jest.fn((path: string) => entries.get(path) ?? null),
    },
    workspace: {
      getActiveFile: jest.fn(() => null),
      getLeaf: jest.fn(() => ({ openFile })),
      getLeavesOfType: jest.fn(() => [explorerLeaf]),
      getLeftLeaf: jest.fn(() => null),
      iterateRootLeaves: jest.fn((callback: (leaf: { view?: unknown }) => void) => {
        for (const leaf of options.rootLeaves ?? []) callback(leaf);
      }),
      revealLeaf: jest.fn().mockResolvedValue(undefined),
    },
    metadataCache: { getFileCache: jest.fn(() => null) },
  };
  const controller = new LinkedContentController({
    app: app as never,
    getExcludedTags: () => [],
    getCachedVaultFiles: () => [...entries.values()].filter(
      (entry): entry is TFile => entry instanceof TFile,
    ),
    getCachedVaultFolders: () => [...entries.values()].filter(
      (entry): entry is TFolder => entry instanceof TFolder,
    ),
  });
  return { app, controller, entries, explorerLeaf, openFile, revealInFolder };
}

function labels(root: MockElement): string[] {
  return root.querySelectorAll('.claudian-composer-dropdown-label')
    .map(element => element.textContent);
}

describe('LinkedContentController DOM', () => {
  it('mounts the selector below the greeting, selects by keyboard, and returns focus', () => {
    const note = createFile('Notes/Plan.md');
    const folder = createFolder('Projects');
    const harness = createHarness({ entries: [note, folder] });
    const parentEl = createMockEl();
    const welcomeEl = createWelcomeElement(parentEl, 'Good morning') as unknown as MockElement;

    harness.controller.mountWelcome(welcomeEl as unknown as HTMLElement);

    expect(welcomeEl.children[1].hasClass('claudian-welcome-greeting')).toBe(true);
    expect(welcomeEl.children[2].hasClass('claudian-welcome-linked-content')).toBe(true);
    const selectorRow = welcomeEl.querySelector('.claudian-linked-content-selector-row')!;
    const selector = welcomeEl.querySelector('.claudian-linked-content-selector')!;
    expect(welcomeEl.querySelector('.claudian-linked-content-selector-prefix')?.textContent)
      .toBe('Linked content:');
    expect(selector.textContent).toBe('None');
    expect(selector.getAttribute('aria-label')).toBeNull();
    selector.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      width: 38,
      height: 17,
      right: 38,
      bottom: 17,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });
    const focus = jest.spyOn(selector, 'focus');
    selector.click();

    const picker = welcomeEl.querySelector('.claudian-linked-content-picker')!;
    expect(selectorRow.hasClass('is-editing')).toBe(true);
    expect(picker.hasClass('claudian-composer-dropdown')).toBe(true);
    expect(picker.hasClass('is-visible')).toBe(false);
    expect(picker.querySelector('.claudian-linked-content-picker-search')).toBeNull();
    expect(welcomeEl.querySelector('.claudian-linked-content-picker-option')).toBeNull();
    expect(labels(welcomeEl)).toEqual([]);
    const search = welcomeEl.querySelector('.claudian-linked-content-picker-search')!;
    expect(search.getAttribute('aria-label')).toBeNull();
    expect(search.getAttribute('aria-labelledby')).toBe(
      welcomeEl.querySelector('.claudian-linked-content-selector-prefix')?.getAttribute('id'),
    );
    expect(search.style.width).toBe('38px');
    expect(search.style.height).toBe('17px');
    search.value = 'Projects';
    search.dispatchEvent({ type: 'input', target: search });
    expect(search.style.width).toBe('38px');
    expect(picker.hasClass('is-visible')).toBe(true);
    expect(welcomeEl.querySelector('.claudian-linked-content-picker-option')
      ?.hasClass('claudian-composer-dropdown-item')).toBe(true);
    expect(labels(welcomeEl)).toEqual(['Projects']);
    search.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault: jest.fn(),
      target: search,
    });

    expect(harness.controller.getSnapshot()).toMatchObject({
      mode: 'explicit-draft',
      path: 'Projects',
    });
    expect(selector.getAttribute('aria-label')).toBeNull();
    expect(selector.textContent).toBe('Projects');
    expect(selectorRow.hasClass('is-editing')).toBe(false);
    expect(focus).toHaveBeenCalled();
  });

  it('rejects Vault root as an explicit target', () => {
    const harness = createHarness();

    expect(() => harness.controller.selectExplicit('.'))
      .toThrow('Invalid Linked content path');
  });

  it('navigates choices with arrows and closes with Escape', () => {
    const harness = createHarness({ entries: [createFolder('Projects')] });
    const welcome = createWelcomeElement(createMockEl(), 'Hello') as unknown as MockElement;
    harness.controller.mountWelcome(welcome as unknown as HTMLElement);
    const selector = welcome.querySelector('.claudian-linked-content-selector')!;
    const focus = jest.spyOn(selector, 'focus');
    selector.click();
    const search = welcome.querySelector('.claudian-linked-content-picker-search')!;
    search.value = 'Projects';
    search.dispatchEvent({ type: 'input', target: search });

    search.dispatchEvent({
      type: 'keydown',
      key: 'ArrowDown',
      preventDefault: jest.fn(),
      target: search,
    });
    search.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault: jest.fn(),
      target: search,
    });
    expect(harness.controller.getSnapshot().path).toBe('Projects');

    selector.click();
    const searches = welcome.querySelectorAll('.claudian-linked-content-picker-search');
    const reopenedSearch = searches[searches.length - 1];
    reopenedSearch.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      target: reopenedSearch,
    });
    expect(selector.getAttribute('aria-expanded')).toBe('false');
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it('closes the expanded picker with Escape from the picker boundary', () => {
    const harness = createHarness({ entries: [createFolder('Projects')] });
    const welcome = createWelcomeElement(createMockEl(), 'Hello') as unknown as MockElement;
    harness.controller.mountWelcome(welcome as unknown as HTMLElement);
    const selector = welcome.querySelector('.claudian-linked-content-selector')!;
    const focus = jest.spyOn(selector, 'focus');
    selector.click();
    const picker = welcome.querySelector('.claudian-linked-content-picker')!;
    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();

    picker.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      preventDefault,
      stopPropagation,
      target: picker,
    });

    expect(selector.getAttribute('aria-expanded')).toBe('false');
    expect(picker.getEventListenerCount('keydown')).toBe(0);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('captures Escape before Obsidian can intercept the picker event', () => {
    const harness = createHarness({ entries: [createFolder('Projects')] });
    const welcome = createWelcomeElement(createMockEl(), 'Hello') as unknown as MockElement;
    harness.controller.mountWelcome(welcome as unknown as HTMLElement);
    const mount = welcome.querySelector('.claudian-welcome-linked-content')!;
    const selector = welcome.querySelector('.claudian-linked-content-selector')!;
    let capturedKeydown: ((event: KeyboardEvent) => void) | null = null;
    mount.ownerDocument.defaultView.addEventListener = jest.fn((
      type: string,
      listener: (event: KeyboardEvent) => void,
      capture?: boolean,
    ) => {
      if (type === 'keydown' && capture) capturedKeydown = listener;
    });
    mount.ownerDocument.defaultView.removeEventListener = jest.fn();
    selector.click();
    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();

    expect(capturedKeydown).not.toBeNull();
    (capturedKeydown as unknown as (event: KeyboardEvent) => void)({
      key: 'Escape',
      preventDefault,
      stopPropagation,
    } as unknown as KeyboardEvent);

    expect(selector.getAttribute('aria-expanded')).toBe('false');
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(mount.ownerDocument.defaultView.removeEventListener).toHaveBeenCalledWith(
      'keydown',
      capturedKeydown,
      true,
    );
  });

  it('remounts against the current cached list and removes the old selector', () => {
    const stale = createFolder('Stale');
    const harness = createHarness({ entries: [stale] });
    const firstWelcome = createWelcomeElement(createMockEl(), 'First') as unknown as MockElement;
    harness.controller.mountWelcome(firstWelcome as unknown as HTMLElement);
    const firstSelector = firstWelcome.querySelector('.claudian-linked-content-selector')!;
    firstSelector.click();
    const firstSearch = firstWelcome.querySelector('.claudian-linked-content-picker-search')!;
    firstSearch.value = 'Stale';
    firstSearch.dispatchEvent({ type: 'input', target: firstSearch });
    expect(labels(firstWelcome)).toEqual(['Stale']);

    harness.entries.delete(stale.path);
    const fresh = createFolder('Fresh');
    harness.entries.set(fresh.path, fresh);

    const secondWelcome = createWelcomeElement(createMockEl(), 'Second') as unknown as MockElement;
    harness.controller.mountWelcome(secondWelcome as unknown as HTMLElement);
    secondWelcome.querySelector('.claudian-linked-content-selector')?.click();
    const secondSearch = secondWelcome.querySelector('.claudian-linked-content-picker-search')!;
    secondSearch.value = 'Fresh';
    secondSearch.dispatchEvent({ type: 'input', target: secondSearch });

    expect(labels(secondWelcome)).toEqual(['Fresh']);
    expect(labels(firstWelcome)).toEqual([]);
    expect(firstSelector.getEventListenerCount('click')).toBe(0);
  });

  it('selects a cached choice by pointer and keeps empty queries hidden', () => {
    const harness = createHarness({ entries: [createFolder('Projects')] });
    const welcome = createWelcomeElement(createMockEl(), 'Hello') as unknown as MockElement;
    harness.controller.mountWelcome(welcome as unknown as HTMLElement);
    const selector = welcome.querySelector('.claudian-linked-content-selector')!;
    const focus = jest.spyOn(selector, 'focus');
    selector.click();
    const search = welcome.querySelector('.claudian-linked-content-picker-search')!;
    const picker = welcome.querySelector('.claudian-linked-content-picker')!;
    expect(picker.hasClass('is-visible')).toBe(false);

    search.value = 'Projects';
    search.dispatchEvent({ type: 'input', target: search });
    welcome.querySelector('.claudian-linked-content-picker-option')?.click();

    expect(harness.controller.getSnapshot()).toEqual({
      mode: 'explicit-draft',
      path: 'Projects',
    });
    expect(focus).toHaveBeenCalled();
  });

  it('remounts after welcome content recreation and hides the selector once locked', () => {
    const harness = createHarness();
    const welcome = createWelcomeElement(createMockEl(), 'Hello') as unknown as MockElement;
    harness.controller.mountWelcome(welcome as unknown as HTMLElement);
    expect(welcome.querySelector('.claudian-linked-content-selector')).not.toBeNull();

    renderWelcomeContent(welcome as unknown as HTMLElement, 'Welcome back');
    harness.controller.mountWelcome(welcome as unknown as HTMLElement);
    expect(welcome.querySelectorAll('.claudian-linked-content-selector')).toHaveLength(1);

    harness.controller.lock(undefined);
    expect(welcome.querySelector('.claudian-linked-content-selector')).toBeNull();
  });

  it('renders a linked-content chip and dispatches file, folder, and missing actions', async () => {
    const note = createFile('Notes/Plan.md');
    const folder = createFolder('Projects');
    const harness = createHarness({ entries: [note, folder] });
    const trayEl = createMockEl();
    const tray = new ComposerContextTray(trayEl as unknown as HTMLElement);
    harness.controller.mountContextTray(tray);

    harness.controller.selectExplicit(note.path);
    let chip = trayEl.querySelector('.claudian-context-chip--content')!;
    expect(chip.dataset.contextSlot).toBe('linked-content');
    expect(chip.querySelector('.claudian-context-chip-remove')).not.toBeNull();
    const noteChipMain = chip.querySelector('.claudian-context-chip-main');
    expect(noteChipMain?.getAttribute('aria-label')).toBe('Linked content: Notes/Plan.md');
    expect(noteChipMain?.getAttribute('title')).toBeNull();
    noteChipMain?.click();
    await flushPromises();
    expect(harness.app.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(harness.openFile).toHaveBeenCalledWith(note);

    harness.controller.selectExplicit(folder.path);
    chip = trayEl.querySelector('.claudian-context-chip--content')!;
    chip.querySelector('.claudian-context-chip-main')?.click();
    await flushPromises();
    expect(harness.app.workspace.revealLeaf).toHaveBeenCalledWith(harness.explorerLeaf);
    expect(harness.revealInFolder).toHaveBeenCalledWith(folder);

    harness.controller.selectExplicit('Missing/Plan.md');
    chip = trayEl.querySelector('.claudian-context-chip--content')!;
    expect(chip.hasClass('claudian-context-chip--missing')).toBe(true);
    expect(chip.querySelector('.claudian-context-chip-label')?.textContent)
      .toContain('Missing content');
    chip.querySelector('.claudian-context-chip-main')?.click();
    expect(Notice).toHaveBeenCalledWith('Linked content is missing: Missing/Plan.md');
  });

  it('reveals the existing main editor tab showing the linked file', async () => {
    const image = createFile('Images/Diagram.png');
    const existingLeaf = { view: createFileView(image) };
    const harness = createHarness({ entries: [image], rootLeaves: [existingLeaf] });
    harness.controller.selectExplicit(image.path);

    await harness.controller.activateCurrentContent();

    expect(harness.app.workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(harness.app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(harness.openFile).not.toHaveBeenCalled();
  });

  it('reveals a deferred editor tab whose view state identifies the linked file', async () => {
    const note = createFile('Notes/Restored.md');
    const deferredLeaf = {
      getViewState: jest.fn(() => ({
        state: { file: note.path },
        type: 'markdown',
      })),
      isDeferred: true,
      view: {},
    };
    const harness = createHarness({ entries: [note], rootLeaves: [deferredLeaf] });
    harness.controller.selectExplicit(note.path);

    await harness.controller.activateCurrentContent();

    expect(harness.app.workspace.revealLeaf).toHaveBeenCalledWith(deferredLeaf);
    expect(harness.app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(harness.openFile).not.toHaveBeenCalled();
  });

  it('removes editable Linked content from the chip but keeps locked content immutable', () => {
    const note = createFile('Notes/Plan.md');
    const harness = createHarness({ entries: [note] });
    const trayEl = createMockEl();
    const tray = new ComposerContextTray(trayEl as unknown as HTMLElement);
    harness.controller.mountContextTray(tray);

    harness.controller.selectExplicit(note.path);
    trayEl.querySelector('.claudian-context-chip-remove')?.click();

    expect(harness.controller.getSnapshot()).toEqual({
      mode: 'explicit-draft',
      path: null,
    });
    expect(trayEl.querySelector('.claudian-context-chip')).toBeNull();

    harness.controller.selectExplicit(note.path);
    harness.controller.lock(note.path);

    expect(trayEl.querySelector('.claudian-context-chip-remove')).toBeNull();
  });

  it('reconciles locked chip presentation when content disappears and returns', () => {
    const note = createFile('Notes/Plan.md');
    const harness = createHarness({ entries: [note] });
    const trayEl = createMockEl();
    const tray = new ComposerContextTray(trayEl as unknown as HTMLElement);
    harness.controller.mountContextTray(tray);
    harness.controller.lock(note.path);

    expect(trayEl.querySelector('.claudian-context-chip--missing')).toBeNull();

    harness.entries.delete(note.path);
    harness.controller.handleDeleted(note.path);
    expect(trayEl.querySelector('.claudian-context-chip--missing')).not.toBeNull();
    expect(trayEl.querySelector('.claudian-context-chip-label')?.textContent)
      .toContain('Missing content');

    harness.entries.set(note.path, note);
    harness.controller.handleCreated(note.path);
    expect(trayEl.querySelector('.claudian-context-chip--missing')).toBeNull();
  });

  it('opens the Files view before revealing a folder when no explorer leaf exists', async () => {
    const folder = createFolder('Projects');
    const harness = createHarness({ entries: [folder] });
    const setViewState = jest.fn().mockResolvedValue(undefined);
    const revealInFolder = jest.fn().mockResolvedValue(undefined);
    const fallbackLeaf = { setViewState, view: { revealInFolder } };
    harness.app.workspace.getLeavesOfType.mockReturnValue([]);
    (harness.app.workspace.getLeftLeaf as jest.Mock).mockReturnValue(fallbackLeaf);
    harness.controller.selectExplicit(folder.path);

    await harness.controller.activateCurrentContent();

    expect(setViewState).toHaveBeenCalledWith({ type: 'file-explorer', active: true });
    expect(harness.app.workspace.revealLeaf).toHaveBeenCalledWith(fallbackLeaf);
    expect(revealInFolder).toHaveBeenCalledWith(folder);
  });

  it('removes owned DOM and event listeners on destruction', () => {
    const harness = createHarness({ entries: [createFolder('Projects')] });
    const welcome = createWelcomeElement(createMockEl(), 'Hello') as unknown as MockElement;
    harness.controller.mountWelcome(welcome as unknown as HTMLElement);
    const selector = welcome.querySelector('.claudian-linked-content-selector')!;
    selector.click();
    const search = welcome.querySelector('.claudian-linked-content-picker-search')!;
    search.value = 'Projects';
    search.dispatchEvent({ type: 'input', target: search });

    harness.controller.destroy();

    expect(selector.getEventListenerCount('click')).toBe(0);
    expect(welcome.querySelector('.claudian-linked-content-selector')).toBeNull();
    expect(welcome.querySelector('.claudian-linked-content-picker')).toBeNull();
  });
});
