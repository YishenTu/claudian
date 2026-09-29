/** @jest-environment jsdom */

import { Component, MarkdownRenderer } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

let renderer: MessageRenderer;
let owner: Component;
let host: HTMLElement;
let activeEmbeds: Set<Component>;
let cleanups: jest.Mock;

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

beforeEach(() => {
  document.body.replaceChildren();
  host = document.body.createDiv();
  owner = new Component();
  owner.load();
  activeEmbeds = new Set();
  cleanups = jest.fn();
  renderer = new MessageRenderer(
    { app: {}, settings: { mediaFolder: '' } } as any, owner, host,
  );
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el, _path, scope) => {
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
    const lateCleanup = jest.fn();
    jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, _el, _path, scope) => {
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
  jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, _el, _path, scope) => {
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

  jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, _el, _path, scope) => {
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

it('releases a late child even when its onload throws', async () => {
  let finish!: () => void;
  jest.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app, _markdown, _el, _path, scope) => {
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
