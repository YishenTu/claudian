/** @vitest-environment jsdom */


import { axe } from '@test/helpers/accessibility';
import { fireEvent, within } from '@testing-library/dom';
import { Notice, TFolder } from 'obsidian';
import type { Mock, MockInstance } from 'vitest';

import { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';
import { LinkedContentController } from '@/features/chat/linked-content/LinkedContentController';



const FAILURE_MESSAGE = 'Folder reveal failed';
const EXPECTED_NOTICE = 'Failed to open Linked content: Folder reveal failed';
const FOLDER_BUTTON_NAME = 'Linked content: Projects';
const REMOVE_BUTTON_NAME = 'Remove Linked content: Projects';
const AXE_RULES = [
  'button-name',
  'aria-valid-attr',
  'aria-valid-attr-value',
  'aria-allowed-attr',
  'aria-roles',
  'nested-interactive',
];

type ActivationOutcome = { ok: true } | { ok: false; error: unknown };

interface MountResult {
  controller: LinkedContentController;
  row: ComposerInfoRow;
  rowEl: HTMLElement;
  view: ReturnType<typeof within>;
  activateSpy: MockInstance<(...args: []) => Promise<void>>;
  outstanding: Array<Promise<ActivationOutcome>>;
  clickAndCapture: () => Promise<ActivationOutcome>;
  cleanup: () => Promise<void>;
  folder: TFolder;
}

function noticeMessages(): string[] {
  return vi.mocked(Notice).mock.calls.map(call => String(call[0]));
}

function createFolder(path: string): TFolder {
  const folder = new TFolder();
  Object.assign(folder, { path, name: path.split('/').pop() ?? '' });
  return folder;
}

function mount(
  workspace: Record<string, unknown>,
  folder: TFolder,
): MountResult {
  vi.mocked(Notice).mockClear();
  const app = {
    vault: { getAbstractFileByPath: (path: string) => (path === folder.path ? folder : null) },
    workspace,
    metadataCache: { getFileCache: () => null },
  };
  const controller = new LinkedContentController({
    app: app as never,
    getExcludedTags: () => [],
    getCachedVaultFiles: () => [],
    getCachedVaultFolders: () => [folder],
  });
  const root = document.body.createDiv();
  const rowEl = root.createDiv();
  const row = new ComposerInfoRow(rowEl);
  controller.mountInfoRow(row);
  controller.selectExplicit('Projects');
  const view = within(rowEl);
  const activateSpy = vi.spyOn(controller, 'activateCurrentContent');
  const outstanding: Array<Promise<ActivationOutcome>> = [];

  const clickAndCapture = (): Promise<ActivationOutcome> => {
    const button = view.getByRole('button', { name: FOLDER_BUTTON_NAME });
    expect(button.getAttribute('type')).toBe('button');
    const callsBefore = activateSpy.mock.calls.length;
    fireEvent.click(button);
    expect(activateSpy.mock.calls.length).toBe(callsBefore + 1);
    const result = activateSpy.mock.results[callsBefore];
    expect(result.type).toBe('return');
    const activation = result.value;
    expect(activation).toBeInstanceOf(Promise);
    const outcome = activation.then(
      (): ActivationOutcome => ({ ok: true }),
      (error: unknown): ActivationOutcome => ({ ok: false, error }),
    );
    outstanding.push(outcome);
    return outcome;
  };

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled(outstanding);
    controller.destroy();
    row.destroy();
    root.remove();
    activateSpy.mockRestore();
    vi.mocked(Notice).mockClear();
  };

  return { controller, row, rowEl, view, activateSpy, outstanding, clickAndCapture, cleanup, folder };
}

function createExplorerWorkspace(options: {
  revealLeaf: Mock<(...args: [unknown]) => Promise<void>>;
  revealInFolder: Mock<(...args: [TFolder]) => void | Promise<void>>;
}): Record<string, unknown> {
  const explorerLeaf = { view: { revealInFolder: options.revealInFolder } };
  return {
    getActiveFile: () => null,
    getLeavesOfType: vi.fn((type: string) => (type === 'file-explorer' ? [explorerLeaf] : [])),
    getLeftLeaf: vi.fn(() => null),
    getLeaf: vi.fn(() => ({ openFile: vi.fn().mockResolvedValue(undefined) })),
    iterateRootLeaves: vi.fn(() => {}),
    revealLeaf: options.revealLeaf,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

interface FolderFailureCase {
  surface: string;
  makeWorkspace: () => {
    workspace: Record<string, unknown>;
    assertPorts: (folder: TFolder) => void;
  };
}

const FOLDER_FAILURE_CASES: FolderFailureCase[] = [
  {
    surface: 'the existing explorer revealLeaf',
    makeWorkspace: () => {
      const revealLeaf = vi.fn<(...args: [unknown]) => Promise<void>>().mockRejectedValue(new Error(FAILURE_MESSAGE));
      const revealInFolder = vi.fn<(...args: [TFolder]) => void | Promise<void>>().mockResolvedValue(undefined);
      return {
        workspace: createExplorerWorkspace({ revealLeaf, revealInFolder }),
        assertPorts: () => {
          expect(revealLeaf).toHaveBeenCalledTimes(1);
          expect(revealInFolder).not.toHaveBeenCalled();
        },
      };
    },
  },
  {
    surface: 'the explorer revealInFolder',
    makeWorkspace: () => {
      const revealLeaf = vi.fn<(...args: [unknown]) => Promise<void>>().mockResolvedValue(undefined);
      const revealInFolder = vi.fn<(...args: [TFolder]) => void | Promise<void>>().mockRejectedValue(new Error(FAILURE_MESSAGE));
      return {
        workspace: createExplorerWorkspace({ revealLeaf, revealInFolder }),
        assertPorts: (folder: TFolder) => {
          expect(revealLeaf).toHaveBeenCalledTimes(1);
          expect(revealInFolder).toHaveBeenCalledTimes(1);
          expect(revealInFolder).toHaveBeenCalledWith(folder);
        },
      };
    },
  },
  {
    surface: 'the fallback explorer setViewState',
    makeWorkspace: () => {
      const revealLeaf = vi.fn<(...args: [unknown]) => Promise<void>>().mockResolvedValue(undefined);
      const revealInFolder = vi.fn<(...args: [TFolder]) => void | Promise<void>>().mockResolvedValue(undefined);
      const setViewState = vi.fn<(...args: [unknown]) => Promise<void>>().mockRejectedValue(new Error(FAILURE_MESSAGE));
      const workspace = {
        getActiveFile: () => null,
        getLeavesOfType: vi.fn(() => []),
        getLeftLeaf: vi.fn(() => ({ view: { revealInFolder }, setViewState })),
        getLeaf: vi.fn(() => ({ openFile: vi.fn().mockResolvedValue(undefined) })),
        iterateRootLeaves: vi.fn(() => {}),
        revealLeaf,
      };
      return {
        workspace,
        assertPorts: () => {
          expect(setViewState).toHaveBeenCalledTimes(1);
          expect(setViewState).toHaveBeenCalledWith({ type: 'file-explorer', active: true });
          expect(revealLeaf).not.toHaveBeenCalled();
          expect(revealInFolder).not.toHaveBeenCalled();
        },
      };
    },
  },
];

describe.each(FOLDER_FAILURE_CASES)('folder activation failure on $surface', ({ makeWorkspace }) => {
  it('resolves the detached chip action and shows the existing open-failure Notice once', async () => {
    const folder = createFolder('Projects');
    const { workspace, assertPorts } = makeWorkspace();
    const mountResult = mount(workspace, folder);
    const { view, rowEl, clickAndCapture, cleanup } = mountResult;
    try {
      expect(await axe(rowEl, { runOnly: AXE_RULES })).toHaveNoViolations();

      const outcome = clickAndCapture();
      const result = await outcome;

      expect(result).toEqual({ ok: true });
      expect(noticeMessages()).toEqual([EXPECTED_NOTICE]);

      assertPorts(folder);

      expect(mountResult.controller.getSnapshot()).toEqual({ mode: 'explicit-draft', path: 'Projects' });
      const button = view.getByRole('button', { name: FOLDER_BUTTON_NAME });
      expect(button.getAttribute('type')).toBe('button');
      expect(view.queryByRole('button', { name: REMOVE_BUTTON_NAME })).not.toBeNull();
      expect(await axe(rowEl, { runOnly: AXE_RULES })).toHaveNoViolations();
    } finally {
      await cleanup();
    }
  });
});

it('completes a rendered folder reveal without a Notice and keeps a locked row activatable without removal', async () => {
  const folder = createFolder('Projects');
  const revealLeaf = vi.fn<(...args: [unknown]) => Promise<void>>().mockResolvedValue(undefined);
  const revealInFolder = vi.fn<(...args: [TFolder]) => void | Promise<void>>().mockResolvedValue(undefined);
  const mountResult = mount(createExplorerWorkspace({ revealLeaf, revealInFolder }), folder);
  const { controller, rowEl, view, clickAndCapture, cleanup } = mountResult;
  try {
    expect(await axe(rowEl, { runOnly: AXE_RULES })).toHaveNoViolations();

    const result = await clickAndCapture();

    expect(result).toEqual({ ok: true });
    expect(noticeMessages()).toEqual([]);
    expect(revealLeaf).toHaveBeenCalledTimes(1);
    expect(revealInFolder).toHaveBeenCalledTimes(1);
    expect(revealInFolder).toHaveBeenCalledWith(folder);
    expect(controller.getSnapshot()).toEqual({ mode: 'explicit-draft', path: 'Projects' });
    expect(await axe(rowEl, { runOnly: AXE_RULES })).toHaveNoViolations();

    controller.lock('Projects');
    const lockedButton = view.getByRole('button', { name: FOLDER_BUTTON_NAME });
    expect(lockedButton.getAttribute('type')).toBe('button');
    expect(view.queryByRole('button', { name: REMOVE_BUTTON_NAME })).toBeNull();
    expect(await axe(rowEl, { runOnly: AXE_RULES })).toHaveNoViolations();

    const lockedResult = await clickAndCapture();
    expect(lockedResult).toEqual({ ok: true });
    expect(noticeMessages()).toEqual([]);
    expect(revealInFolder).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toEqual({ mode: 'locked', path: 'Projects' });
  } finally {
    await cleanup();
  }
});
