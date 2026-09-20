/** @jest-environment jsdom */
import { FakeAuxiliaryBackend } from '@test/unit/core/auxiliary/AuxiliaryExecutionTestHarness';
import { fireEvent, screen, waitFor } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { InstructionRefineService } from '@/core/auxiliary/InstructionRefineService';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  Modal: class {
    contentEl = document.createElement('div');
    constructor() { this.contentEl.setAttribute('role', 'dialog'); }
    setTitle(title: string) { this.contentEl.setAttribute('aria-label', title); }
    open() { document.body.appendChild(this.contentEl); this.onOpen(); }
    close() { this.onClose(); this.contentEl.remove(); }
    onOpen() {}
    onClose() {}
  },
}));

Object.assign(HTMLElement.prototype, {
  toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
  empty(this: HTMLElement) { this.replaceChildren(); },
  addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
  removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
});

function createHarness() {
  const backend = new FakeAuxiliaryBackend();
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  const service = new InstructionRefineService({
    backend,
    lifecycleRegistry: lifecycle,
    nativePersistence: 'disabled-if-supported',
    vaultWorkingDirectory: '/vault',
    interactionPort: {
      askUserQuestion: jest.fn(),
      dismissInteraction: jest.fn(),
      requestApproval: jest.fn(),
    },
  });
  const settings = { systemPrompt: '' };
  const controller = new InputController({
    plugin: {
      app: {},
      settings,
      mutateSettings: async (mutate: (draft: typeof settings) => void) => { mutate(settings); },
    },
    getInstructionRefineService: () => service,
    getInstructionModeManager: () => null,
  } as unknown as InputControllerDeps);
  return {
    backend, controller, settings,
    async dispose() {
      service.cancel();
      await lifecycle.dispose();
      document.body.replaceChildren();
    },
  };
}

it('releases the instruction session when its refinement is accepted', async () => {
  const { backend, controller, settings, dispose } = createHarness();
  try {
    const refinement = controller.handleInstructionSubmit('Be concise');
    await waitFor(() => expect(backend.sessions[0]?.requests).toHaveLength(1));
    backend.sessions[0].emitText('<instruction>Use concise prose.</instruction>');
    backend.sessions[0].complete();
    await refinement;
    const accept = screen.getByRole('button', { name: 'Accept instruction' });
    expect(await axe(accept.parentElement!)).toHaveNoViolations();
    fireEvent.click(accept);
    await waitFor(() => expect(settings.systemPrompt).toBe('Use concise prose.'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(backend.sessions[0].getStatus()).toBe('disposed'));
  } finally {
    await dispose();
  }
});


it.each(['', '<instruction></instruction>'])(
  'releases the instruction session when response %j closes the dialog with an error',
  async (response) => {
    const { backend, controller, settings, dispose } = createHarness();
    try {
      const refinement = controller.handleInstructionSubmit('Be concise');
      await waitFor(() => expect(backend.sessions[0]?.requests).toHaveLength(1));
      backend.sessions[0].emitText(response);
      backend.sessions[0].complete();
      await refinement;
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(settings.systemPrompt).toBe('');
      await waitFor(() => expect(backend.sessions[0].getStatus()).toBe('disposed'));
    } finally {
      await dispose();
    }
  },
);
