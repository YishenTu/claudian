import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
/** @vitest-environment jsdom */
import { Component, MarkdownRenderer } from 'obsidian';
import type { Mock } from 'vitest';

import { MarkdownContentRenderer } from '@/features/chat/rendering/markdown/MarkdownContentRenderer';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

let renderer: MessageRenderer;
let owner: Component;
let host: HTMLElement;
let activeEmbeds: Set<Component>;
let cleanups: Mock;

function addEmbed(scope: Component): Component {
  const embed = new Component();
  embed.onload = () => {
    activeEmbeds.add(embed);
    embed.register(() => {
      activeEmbeds.delete(embed);
      cleanups();
    });
  };
  return scope.addChild(embed);
}

beforeEach(async () => {
  document.body.replaceChildren();
  host = document.body.createDiv();
  owner = new Component();
  owner.load();
  activeEmbeds = new Set();
  cleanups = vi.fn();
  renderer = new MessageRenderer(
    await createChatFeatureHost({ settings: { mediaFolder: '' } }), owner, host,
  );
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el, _path, scope) => {
    el.textContent = markdown;
    if (markdown === 'embed') addEmbed(scope);
  });
});

afterEach(() => {
  renderer.dispose();
  owner.unload();
});

it('releases replaced embeds while keeping other messages alive', async () => {
  const first = host.createDiv();
  const second = host.createDiv();
  await renderer.renderContent(second, 'embed');
  for (let index = 0; index < 20; index++) await renderer.renderContent(first, 'embed');
  expect(activeEmbeds.size).toBe(2);
  expect(cleanups).toHaveBeenCalledTimes(19);
  await renderer.renderContent(first, 'plain');
  expect(activeEmbeds.size).toBe(1);
  expect(second.textContent).toBe('embed');
  renderer.dispose();
  renderer.dispose();
  expect(activeEmbeds.size).toBe(0);
  expect(cleanups).toHaveBeenCalledTimes(21);
});

it.each(['message', 'external clear', 'history replacement', 'owner unload'])(
  'releases embeds after %s', async action => {
    const message = host.createDiv({ attr: { 'data-message-id': 'test-message' } });
    await renderer.renderContent(message.createDiv(), 'embed');
    if (action === 'message') renderer.removeMessage('test-message');
    if (action === 'external clear') host.empty();
    if (action === 'history replacement') renderer.renderMessages([], () => 'Hello');
    if (action === 'owner unload') owner.unload();
    await Promise.resolve(); // MutationObserver delivery for externally removed DOM.
    expect(activeEmbeds.size).toBe(0);
    expect(cleanups).toHaveBeenCalledTimes(1);
  },
);

it('preserves embeds when their message is moved within the container', async () => {
  const message = host.createDiv();
  const destination = host.createDiv();
  await renderer.renderContent(message, 'embed');
  destination.append(message);
  await Promise.resolve();
  expect(activeEmbeds.size).toBe(1);
});

it.each(['replacement', 'disposal', 'owner unload'])(
  'cleans late registrations after %s', async action => {
    let finish!: () => void;
    const lateCleanup = vi.fn();
    vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, _el, _path, scope) => {
      addEmbed(scope);
      await new Promise<void>(resolve => { finish = resolve; });
      addEmbed(scope);
      scope.register(lateCleanup);
    });
    const target = host.createDiv();
    const pending = renderer.renderContent(target, 'embed');
    if (action === 'replacement') await renderer.renderContent(target, 'plain');
    if (action === 'disposal') renderer.dispose();
    if (action === 'owner unload') owner.unload();
    expect(activeEmbeds.size).toBe(0);
    finish();
    await pending;
    expect(activeEmbeds.size).toBe(0);
    expect(lateCleanup).toHaveBeenCalledTimes(1);
  },
);

it('cleans a failed render and suppresses errors from a superseded render', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, _el, _path, scope) => {
    addEmbed(scope);
    await new Promise<void>((_resolve, rejectRender) => { reject = rejectRender; });
  });
  const target = host.createDiv();
  const pending = renderer.renderContent(target, 'embed');
  await renderer.renderContent(target, 'plain');
  reject(new Error('late error'));
  await pending;
  expect(target.textContent).toBe('plain');
  expect(activeEmbeds.size).toBe(0);

  vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, _el, _path, scope) => {
    addEmbed(scope);
    throw new Error('render failure');
  });
  await renderer.renderContent(target, 'embed');
  expect(target.querySelector('.claudian-render-error')).not.toBeNull();
  expect(activeEmbeds.size).toBe(0);
});

it('does not start another render after disposal', async () => {
  renderer.dispose();
  await renderer.renderContent(host, 'embed');
  expect(activeEmbeds.size).toBe(0);
  expect(host.textContent).toBe('');
});

it.each(['user scroll', 'history replacement', 'disposal', 'following growth'])('fences deferred tail scrolling across %s', action => {
  let pending!: FrameRequestCallback;
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { pending = callback; return 91; });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  let height = 1000;
  Object.defineProperties(host, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: 100 },
  });
  host.scrollTop = 850;
  try {
    renderer.scrollToBottomIfNeeded();
    expect(request).toHaveBeenCalledTimes(1);
    if (action === 'user scroll') {
      host.scrollTop = 100;
      host.dispatchEvent(new Event('scroll'));
    }
    if (action === 'history replacement') {
      renderer.renderMessages([], () => 'Empty');
      host.scrollTop = 30;
    }
    if (action === 'disposal') {
      renderer.dispose();
    }
    if (action === 'following growth') height = 1400;
    pending(0);
    expect(host.scrollTop).toBe(action === 'user scroll' ? 100 : action === 'history replacement' ? 30 : action === 'disposal' ? 850 : 1400);
  } finally {
    request.mockRestore();
    cancel.mockRestore();
  }
});

it('releases a late child even when its onload throws', async () => {
  let finish!: () => void;
  vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, _el, _path, scope) => {
    await new Promise<void>(resolve => { finish = resolve; });
    const child = new Component();
    child.onload = () => {
      activeEmbeds.add(child);
      child.register(() => activeEmbeds.delete(child));
      throw new Error('postprocessor failed after acquiring a resource');
    };
    scope.addChild(child);
  });
  const pending = renderer.renderContent(host, 'embed');
  renderer.dispose();
  finish();
  await pending;
  expect(activeEmbeds.size).toBe(0);
});


it('releases nested render scopes without visiting every highlighted span', async () => {
  const wrapper = host.createDiv();
  for (let index = 0; index < 4; index += 1) {
    const content = wrapper.createDiv();
    await renderer.renderContent(content, 'embed');
    for (let span = 0; span < 100; span += 1) content.createSpan({ text: 'token' });
  }
  await Promise.resolve();
  const release = vi.spyOn(MarkdownContentRenderer.prototype, 'releaseRemoved');
  try {
    const destination = host.createDiv();
    destination.append(wrapper);
    await Promise.resolve();
    expect(activeEmbeds.size).toBe(4);
    expect(release).not.toHaveBeenCalled();
    wrapper.remove();
    await Promise.resolve();
    expect(activeEmbeds.size).toBe(0);
    expect(cleanups).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    release.mockRestore();
  }
});
