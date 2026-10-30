/** @vitest-environment jsdom */
import { App, Component, MarkdownRenderer } from 'obsidian';

it('replaces prior content with literal markdown and keeps authored HTML inert', async () => {
  const target = document.createElement('div');
  target.innerHTML = '<button>Stale</button>';
  await MarkdownRenderer.render(new App(), '**Title** <img src="untrusted">', target, '', new Component());
  expect(target.textContent).toBe('**Title** <img src="untrusted">');
  expect(target.querySelector('button, img')).toBeNull();
});
