import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { waitFor } from '@testing-library/dom';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderCapabilities, ProviderConversationHistoryService, ProviderRegistration } from '@/core/providers/types';
import { WarmExecutionPool } from '@/features/chat/execution/WarmExecutionPool';
import { SideChatController } from '@/features/chat/side-chat/SideChatController';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

Object.assign(HTMLElement.prototype, {
  appendText(this: HTMLElement, text: string) { this.appendChild(this.ownerDocument.createTextNode(text)); },
  addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
  createDiv(this: HTMLElement, options?: Record<string, unknown>) { return createChild(this, 'div', options); },
  createEl(this: HTMLElement, tag: string, options?: Record<string, unknown>) { return createChild(this, tag, options); },
  createSpan(this: HTMLElement, options?: Record<string, unknown>) { return createChild(this, 'span', options); },
  empty(this: HTMLElement) { this.replaceChildren(); },
  hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
  removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
  setCssProps(this: HTMLElement, props: Record<string, string>) {
    for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
  },
  setText(this: HTMLElement, text: string) { this.textContent = text; },
  scrollIntoView() {},
  toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
});

function createChild(parent: HTMLElement, tag: string, options?: Record<string, unknown>): HTMLElement {
  const el = parent.ownerDocument.createElement(tag);
  const cls = options?.cls;
  if (typeof cls === 'string') el.className = cls;
  const text = options?.text;
  if (typeof text === 'string') el.textContent = text;
  const attrs = options?.attr as Record<string, string> | undefined;
  for (const [key, value] of Object.entries(attrs ?? {})) el.setAttribute(key, value);
  parent.appendChild(el);
  return el;
}

const cleanups: Array<() => Promise<void>> = [];

export async function releaseSideChatHarnesses(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  jest.clearAllMocks();
}

export function createHarness(options: {
  subagentAdapter?: ProviderRegistration['subagentAdapter'];
  taskResultInterpreter?: ProviderRegistration['taskResultInterpreter'];
  supportsFork?: boolean;
  checkpoint?: string | null;
  settings?: Record<string, unknown>;
  supportsEphemeralFork?: boolean;
  forkMode?: ProviderCapabilities['forkMode'];
  buildForkProviderState?: ProviderConversationHistoryService['buildForkProviderState'];
  getMainAgentDynamicSystemPromptSections?: () => Promise<string[]>;
} = {}) {
  const backend = new FakeSideBackend();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const forkState = { forkSource: { resumeAt: 'checkpoint-1', sessionId: 'main-session' } };
  ProviderRegistry.register('claude', {
    capabilities: { providerId: 'claude', supportsFork: options.supportsFork ?? true, supportsEphemeralSessions: true, supportsEphemeralFork: options.supportsEphemeralFork, forkMode: options.forkMode },
    modelPolicy: ProviderRegistry.getModelPolicy('claude'),
    chatUIConfig: ProviderRegistry.getChatUIConfig('claude'),
    createExecutionBackend: () => backend,
    subagentAdapter: options.subagentAdapter,
    taskResultInterpreter: options.taskResultInterpreter,
    historyService: {
      buildForkProviderState: options.buildForkProviderState ?? (() => forkState),
      hydrateConversationHistory: async () => undefined,
      isPendingForkConversation: () => false,
      resolveSessionIdForConversation: () => 'main-session',
    },
    isEnabled: () => true,
  } as unknown as ProviderRegistration);

  const composerEl = document.body.appendChild(document.createElement('div'));
  composerEl.className = 'claudian-input-composer';
  const inputContainerEl = composerEl.appendChild(document.createElement('div'));
  inputContainerEl.className = 'claudian-input-container';
  const inputWrapperEl = inputContainerEl.appendChild(document.createElement('div'));
  inputWrapperEl.className = 'claudian-input-wrapper';
  const inputEl = inputWrapperEl.appendChild(document.createElement('textarea'));
  inputEl.placeholder = 'Ask to make changes';

  let images: unknown[] = [];
  const imageContextManager = {
    clearImages: () => { images = []; },
    getAttachedImages: () => images,
    hasImages: () => images.length > 0,
    setImages: (next: unknown[]) => { images = next; },
  };

  const checkpoint = options.checkpoint === undefined ? 'checkpoint-1' : options.checkpoint;
  const messages = [
    { content: 'Remember A', id: 'u1', role: 'user', timestamp: 1 },
    {
      ...(checkpoint ? { assistantMessageId: checkpoint } : {}),
      content: 'Noted A', id: 'a1', role: 'assistant', timestamp: 2,
    },
  ];
  const tab = {
    conversationId: 'conversation-1',
    controllers: {},
    executionCoordinator: { resolveForkSource: async () => ({ resumeAt: checkpoint, sessionId: 'main-session' }) },
    id: 'tab-1',
    providerId: 'claude',
    state: { isRewinding: false, isStreaming: false, messages },
  } as unknown as AssembledTabRuntime;

  const app = { vault: { adapter: { basePath: '/vault' }, getFiles: () => [] } };
  const settings = options.settings ?? {};
  const plugin = {
    app,
    getConversationSummary(id: string) { return (this as unknown as { getConversationSync: (id: string) => any }).getConversationSync(id); },
    getConversationSync: () => null,
    getMainAgentDynamicSystemPromptSections: options.getMainAgentDynamicSystemPromptSections,
    providerHost: { app, settings, executionLifecycleRegistry: lifecycleRegistry },
    settings,
    warmExecutionPool: new WarmExecutionPool(() => 5),
  } as never;

  const destinationChanges: string[] = [];
  const controller = new SideChatController({
    component: { register: () => undefined } as never,
    composerEl,
    getImageContextManager: () => imageContextManager as never,
    getInputEl: () => inputEl as never,
    getTab: () => tab,
    inputWrapperEl,
    isRuntimeLive: () => true,
    onDestinationChanged: () => { destinationChanges.push(controller.destination); },
    plugin,
  });
  cleanups.push(async () => {
    await controller.dispose();
    await lifecycleRegistry.dispose();
  });
  return {
    backend, composerEl, controller, destinationChanges, imageContextManager,
    inputContainerEl, inputEl, inputWrapperEl, lifecycleRegistry, plugin, tab,
  };
}

/** Returns a holder so the pending submission is not unwrapped by `await`. */
export async function startSideChat(
  harness: SideChatDOMHarness,
  prompt = 'Explore B',
): Promise<{ started: Promise<boolean> }> {
  const started = harness.controller.handleCommandSubmission(prompt, []);
  await waitFor(() => expect(harness.backend.sessions.some(
    session => session.requests[0]?.toolPolicy.kind === 'provider-default',
  )).toBe(true));
  return { started };
}

export type SideChatDOMHarness = ReturnType<typeof createHarness>;
