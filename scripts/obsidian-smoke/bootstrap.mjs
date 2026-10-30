import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { until } from './cdp.mjs';

const PLUGINS = ['realclaudian', 'claudian-smoke-probe'];
const TRUST_BUTTON = 'Trust author and enable plugins';

// Obsidian 1.13.7 initializes plugins only after checking localStorage enable-plugin-<appId>.
// With no manifests it returns before displaying the first-vault trust dialog. Bootstrap without
// manifests, seed that origin's localStorage via CDP, then expose plugins and reload the same process.
export function stagePluginBootstrap(vault, tempRoot) {
  const staged = path.join(tempRoot, 'plugins-ready');
  renameSync(path.join(vault, '.obsidian/plugins'), staged);
  writeFileSync(path.join(vault, '.obsidian/community-plugins.json'), JSON.stringify(PLUGINS));
  return staged;
}

async function readState(cdp, page) {
  try {
    return await cdp.evaluate(page, `window.app?.vault?.adapter?.basePath ? ({vault:app.vault.adapter.basePath,id:app.appId,enabled:app.plugins?.isEnabled(),loaded:!!app.plugins?.plugins.realclaudian && !!app.plugins?.plugins['claudian-smoke-probe']}) : null`);
  } catch (error) {
    if (/context.*(destroyed|not found)|Cannot find context/i.test(error.message)) return null;
    throw error;
  }
}

export async function enableTemporaryPlugins(cdp, { vault, staged, signal }) {
  const main = await until(async () => {
    for (const page of cdp.pages.values()) {
      if (page.url !== 'app://obsidian.md/index.html') continue;
      const state = await readState(cdp, page);
      if (state?.id) { assert.equal(state.vault, vault); return page; }
    }
  }, 'empty temporary vault bootstrap (no human action required)', signal);
  assert.equal(await cdp.locate('button', TRUST_BUTTON, false), null, 'Empty bootstrap must not show a trust prompt');
  const { id } = await readState(cdp, main);
  assert.match(id, /^[a-f0-9]{16}$/i, 'Expected the temporary profile vault ID');
  const key = `enable-plugin-${id}`;
  await cdp.send('DOMStorage.setDOMStorageItem', {
    storageId: { securityOrigin: 'app://obsidian.md', isLocalStorage: true }, key, value: 'true',
  }, main.sessionId);
  assert.equal(await cdp.evaluate(main, `localStorage.getItem(${JSON.stringify(key)})`), 'true');
  renameSync(staged, path.join(vault, '.obsidian/plugins'));
  await cdp.send('Page.reload', {}, main.sessionId);
  let fallbackHandled = false;
  await until(async () => {
    const state = await readState(cdp, main);
    if (!state) return false;
    assert.equal(state.vault, vault, 'Refusing another vault during startup');
    const trust = await cdp.locate('button', TRUST_BUTTON, false);
    if (trust) {
      if (fallbackHandled) throw new Error('Obsidian trust prompt persisted after automatic approval; no human action should be needed');
      await cdp.click('button', TRUST_BUTTON);
      fallbackHandled = true;
    }
    return state.enabled && state.loaded;
  }, 'automatic plugin enablement; refusing to wait for human approval', signal, 15_000);
  assert.equal(await cdp.locate('button', TRUST_BUTTON, false), null, 'No trust/enable dialog may remain');
  // The trust fallback opens Settings; close it before running smoke actions.
  if (fallbackHandled) await cdp.evaluate(main, 'app.setting.close();true');
  return { key, enabled: true, fallbackHandled, bootstrapHadNoPrompt: true };
}
