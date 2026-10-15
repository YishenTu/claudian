/** @jest-environment jsdom */
import {
  createInlineEditHarness as createHarness,
  disposeInlineEditHarnesses,
  instructionInput as input,
  registerFakeInlineEditProvider,
  showReplacementPreview,
  submitInstruction,
  typeInstruction,
} from '@test/helpers/features/inline-edit/InlineEditDOMHarness';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { MarkdownRenderer, Notice, TFolder } from 'obsidian';

afterEach(async () => {
  await disposeInlineEditHarnesses();
  jest.mocked(MarkdownRenderer.render).mockReset();
  jest.clearAllMocks();
});

describe('editor resolution', () => {
  it('opens on the view editor when the callback editor has no CodeMirror view', async () => {
    const h = createHarness();
    const result = h.createModal({}, h.editor).openAndWait();
    expect(await screen.findByRole('textbox', { name: 'Edit instructions' })).toBeDefined();
    fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
    await expect(result).resolves.toEqual({ decision: 'reject' });
  });

  it('rejects with a notice when neither editor exposes a CodeMirror view', async () => {
    const h = createHarness();
    await expect(h.createModal({}, {}).openAndWait()).resolves.toEqual({ decision: 'reject' });
    expect(Notice).toHaveBeenCalledWith(
      'Inline edit unavailable: could not access the active editor. Try reopening the note.',
    );
    expect(screen.queryByRole('textbox', { name: 'Edit instructions' })).toBeNull();
  });
});

describe('provider and model resolution', () => {
  it.each([
    {
      name: 'uses the enabled settings provider when nothing is selected',
      selection: null,
      settings: { settingsProvider: 'claude', providerConfigs: { claude: { enabled: false } } },
      expectedModel: 'sonnet',
      expectedChip: 'Model: Sonnet, effort High',
    },
    {
      name: 'falls back to the settings provider without the model of a disabled selection',
      selection: { providerId: 'claude', model: 'sonnet' },
      settings: { settingsProvider: 'codex', providerConfigs: { claude: { enabled: false } } },
      expectedModel: 'sonnet',
      expectedChip: 'Model: Sonnet, effort High',
    },
    {
      name: 'uses the selected provider and model',
      selection: { providerId: 'codex', model: 'opus' },
      settings: { settingsProvider: 'claude' },
      expectedModel: 'opus',
      expectedChip: 'Model: Opus, effort High',
    },
  ])('$name', async ({ selection, settings, expectedModel, expectedChip }) => {
    const h = createHarness();
    const codex = registerFakeInlineEditProvider('codex');
    h.plugin.settings = settings;
    h.plugin.getActiveModelSelection = () => selection;
    const result = h.createModal().openAndWait();
    await screen.findByRole('textbox', { name: 'Edit instructions' });
    // Without a saved model the provider's default is resolved once, shown on the chip and sent.
    expect(screen.getByRole('button', { name: expectedChip })).toBeDefined();
    submitInstruction();
    await waitFor(() => expect(codex.sessions[0]?.requests).toHaveLength(1));
    expect(h.backend.sessions).toHaveLength(0);
    expect(codex.sessions[0].requests[0].configuration.model).toBe(expectedModel);
    fireEvent.keyDown(h.editorView.contentDOM, { key: 'Escape' });
    await expect(result).resolves.toEqual({ decision: 'reject' });
  });
});

it('suggests Vault folders for @ mentions', async () => {
  const h = createHarness();
  h.app.vault.getAllLoadedFiles = () => [Object.assign(new TFolder(), { name: 'src', path: 'src' })];
  h.createSession().show();
  typeInstruction('@s');
  expect(await screen.findByRole('option', { name: /src\// })).toBeDefined();
});

it('shows only the newest clarification when an older render finishes last', async () => {
  const h = createHarness();
  const renders: Array<() => void> = [];
  jest.mocked(MarkdownRenderer.render).mockImplementation((_app, markdown, element) => {
    (element as HTMLElement).textContent = markdown;
    return new Promise<void>(resolve => renders.push(resolve));
  });
  h.createSession().show();
  submitInstruction('Improve');
  await waitFor(() => expect(h.backend.sessions[0]?.getStatus()).toBe('executing'));
  h.backend.sessions[0].emitText('First question?');
  h.backend.sessions[0].complete();
  await waitFor(() => expect(renders).toHaveLength(1));
  submitInstruction('Formal');
  await waitFor(() => expect(h.backend.sessions[0].requests).toHaveLength(2));
  h.backend.sessions[0].emitText('Second question?');
  h.backend.sessions[0].complete();
  await waitFor(() => expect(renders).toHaveLength(2));
  expect(MarkdownRenderer.render).toHaveBeenLastCalledWith(
    h.app, 'Second question?', expect.any(HTMLElement), h.notePath, h.plugin,
  );

  const container = input().closest('.claudian-inline-input-container') as HTMLElement;
  renders[1]();
  await within(container).findByText('Second question?');
  renders[0]();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  expect(within(container).getByText('Second question?')).toBeDefined();
  expect(within(container).queryByText('First question?')).toBeNull();
});

it('previews the selected source as deleted and the replacement as inserted Markdown', async () => {
  const h = createHarness();
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, element) => {
    (element as HTMLElement).textContent = markdown;
  });
  h.createSession().show();
  await showReplacementPreview(h, 'Hi');
  const preview = screen.getByRole('toolbar', { name: 'Inline edit actions' }).parentElement!;
  await waitFor(() => expect(Array.from(preview.querySelectorAll('.claudian-diff-block'), block => [
    block.classList.contains('claudian-diff-del') ? 'delete' : block.classList.contains('claudian-diff-ins') ? 'insert' : 'equal',
    block.textContent,
  ])).toEqual([['delete', 'hello'], ['insert', 'Hi']]));
  // The previewed source is hidden from the editor until the edit settles.
  expect(h.editorView.contentDOM.textContent).toBe(`${preview.textContent} world`);
});
