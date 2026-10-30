import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { until } from './cdp.mjs';

export async function checkHost(cdp, { vault, artifactDir, signal, check }) {
  const main = await until(async () => {
    for (const page of cdp.pages.values()) {
      if (page.url !== 'app://obsidian.md/index.html') continue;
      const openedVault = await cdp.evaluate(page, 'window.app?.vault?.adapter?.basePath');
      if (openedVault) { assert.equal(openedVault, vault, 'Refusing a different vault'); return page; }
    }
  }, 'temporary Obsidian vault', signal);
  const evaluate = async expression => {
    assert.equal(await cdp.evaluate(main, 'app.vault.adapter.basePath'), vault, 'Refusing a different vault');
    return cdp.evaluate(main, expression);
  };
  await evaluate(`(() => {
    const state = { events: [], ids: new WeakMap(), next: 1, original: {} };
    window.__claudianSmokeScopes = state;
    for (const method of ['pushScope','popScope']) {
      state.original[method] = app.keymap[method];
      app.keymap[method] = function(scope) {
        if (!state.ids.has(scope)) state.ids.set(scope, state.next++);
        state.events.push({method, id: state.ids.get(scope)});
        return state.original[method].call(this, scope);
      };
    }
  })()`);

  async function modal(label, open, name, { field, menu = false, ready } = {}) {
    return check(label, async () => {
      const start = await evaluate('__claudianSmokeScopes.events.length');
      await open();
      const dialog = await cdp.waitFor('dialog', name);
      assert.equal(await cdp.onNode(dialog, 'function(){return this.getAttribute("aria-modal");}'), 'true');
      writeFileSync(path.join(artifactDir, `${label}.ax.json`), JSON.stringify(await cdp.tree(dialog.page), null, 2));
      if (field) {
        await cdp.onNode(await cdp.waitFor('textbox', field), `function(){
          const win=this.ownerDocument.defaultView;
          win.__claudianSmokeFieldEvents=[];this.focus();
          this.addEventListener('keydown',event=>win.__claudianSmokeFieldEvents.push({key:event.key,prevented:event.defaultPrevented,connected:this.isConnected,targetSame:event.target===this}));
        }`);
      }
      if (ready) await ready();
      await cdp.escape(dialog.page);
      await until(async () => !await cdp.locate('dialog', name, false), `${name} closes on Escape`, signal);
      const events = await evaluate(`__claudianSmokeScopes.events.slice(${start})`);
      assert.deepEqual(events.map(event => event.method), menu ? ['popScope', 'pushScope', 'popScope'] : ['pushScope', 'popScope'], 'One modal scope acquisition/release per Escape, after closing any launch menu');
      assert.equal(events.at(-2).id, events.at(-1).id, 'Escape releases the acquired scope');
      const fieldEvents = field ? await cdp.evaluate(dialog.page, 'window.__claudianSmokeFieldEvents') : undefined;
      if (field) assert.deepEqual(fieldEvents, [{ key: 'Escape', prevented: true, connected: false, targetSame: true }], 'Host capture must close once before the original event reaches the detached field');
      return { name, events, ...(fieldEvents ? { fieldEvents } : {}) };
    });
  }

  await check('plugin-load', async () => {
    // Bootstrap already seeded restricted-mode trust before enabling either plugin.
    assert.equal(await evaluate('app.plugins.isEnabled()'), true);
    await until(() => evaluate('!!app.plugins.plugins.realclaudian && !!window.__claudianSmokeProbe'), 'plugins enabled', signal);
    return evaluate('({hostVersion:__claudianSmokeProbe.hostVersion,pluginVersion:app.plugins.plugins.realclaudian.manifest.version})');
  });
  await check('claudian-view', async () => {
    await evaluate(`app.commands.executeCommandById('realclaudian:open-view')`);
    await cdp.waitFor('textbox', 'Message');
    assert.equal(await evaluate('app.workspace.getLeavesOfType("claudian-view").length'), 1);
  });
  await modal('project-modal', async () => {
    await cdp.click('button', 'Chat history');
    await cdp.click('button', 'New project');
  }, 'New project');

  await check('project-fixture', async () => {
    await cdp.click('button', 'New project');
    await cdp.onNode(await cdp.waitFor('textbox', 'Name'), `function(){this.value='Smoke project';this.dispatchEvent(new this.ownerDocument.defaultView.Event('input',{bubbles:true}));this.dispatchEvent(new this.ownerDocument.defaultView.Event('change',{bubbles:true}));}`);
    await cdp.click('button', 'Save');
    await cdp.waitFor('button', 'Actions for Smoke project');
  });
  await cdp.click('button', 'Actions for Smoke project');
  await modal('project-memory', () => cdp.click('menuitem', 'Open project memory'), 'Project memory: Smoke project', { menu: true, ready: () => cdp.waitFor('button', 'Edit') });
  await cdp.click('button', 'Actions for Smoke project');
  await modal('confirm-delete-project', () => cdp.click('menuitem', 'Delete project'), 'Confirm', { menu: true });

  await check('settings-accessibility', async () => {
    await evaluate(`app.setting.open();app.setting.openTabById('realclaudian');true`);
    const toggle = await cdp.waitFor('switch', 'Enable zen mode');
    const nodes = await cdp.tree(toggle.page);
    const switches = nodes.filter(node => !node.ignored && node.role?.value === 'switch');
    assert.ok(switches.length > 0);
    for (const node of switches) {
      assert.ok(node.name?.value, 'Every visible switch is named');
      assert.ok(node.properties?.some(property => property.name === 'checked'), 'Switch exposes checked state');
    }
    assert.ok(nodes.some(node => node.role?.value === 'heading' && node.name?.value === 'Display'));
    return { switches: switches.map(node => node.name.value) };
  });
  for (const field of ['Name', 'Description']) {
    await modal(`env-snippet-${field.toLowerCase()}`, () => cdp.click('button', 'Save current environment as a snippet'), 'Save snippet', { field });
  }
  await cdp.click('button', 'Skills');
  await cdp.click('button', 'Other providers');
  await modal('skill-create', () => cdp.click('button', 'Add'), 'Add Shared Skill');
  await modal('skill-edit', () => cdp.click('button', 'Edit'), 'Edit Shared Skill');
  await modal('skill-delete', () => cdp.click('button', 'Delete'), 'Delete Shared Skill');
  await modal('skill-sync', () => cdp.click('button', 'Sync'), 'Sync Skills');
  await evaluate('app.setting.close();true');
  await cdp.waitFor('textbox', 'Message');

  await modal('image-preview', async () => {
    await cdp.onNode(await cdp.waitFor('textbox', 'Message'), `async function(){
      this.focus();const win=this.ownerDocument.defaultView;const canvas=this.ownerDocument.createElement('canvas');
      canvas.width=8;canvas.height=8;const context=canvas.getContext('2d');context.fillStyle='#3466bb';context.fillRect(0,0,8,8);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const data=new win.DataTransfer();data.items.add(new win.File([blob],'smoke.png',{type:'image/png'}));
      this.dispatchEvent(new win.ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    }`);
    await cdp.click('button', /^Image attachment: smoke\.png · /);
  }, 'Image preview: smoke.png');

  // These use the exported production modules in the actual host. They do not test provider execution.
  await modal('fork-module', () => evaluate('__claudianSmokeProbe.fork();true'), 'Fork conversation');
  assert.equal(await evaluate('__claudianSmokeProbe.pending.then(()=>__claudianSmokeProbe.result)'), null);
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    await modal(`pi-${method}-module`, () => evaluate(`__claudianSmokeProbe.pi(${JSON.stringify(method)});true`), `Pi smoke ${method}`);
    assert.deepEqual(await evaluate('__claudianSmokeProbe.pending.then(()=>__claudianSmokeProbe.result)'), { cancelled: true });
  }
  await check('host-component-lifecycle', async () => {
    const results = await evaluate('__claudianSmokeProbe.lifecycle()');
    for (const [contract, passed] of Object.entries(results)) assert.equal(passed, true, contract);
    return results;
  });
  await check('view-close-reopen', async () => {
    await evaluate(`window.__claudianSmokeOldView=app.workspace.getLeavesOfType('claudian-view')[0].view;app.workspace.getLeavesOfType('claudian-view')[0].detach();`);
    await until(async () => !await cdp.locate('textbox', 'Message', false), 'view closes', signal);
    assert.equal(await evaluate('app.workspace.getLeavesOfType("claudian-view").length'), 0);
    await evaluate(`app.commands.executeCommandById('realclaudian:open-view')`);
    await cdp.waitFor('textbox', 'Message');
    assert.equal(await evaluate('app.workspace.getLeavesOfType("claudian-view").length'), 1);
    assert.equal(await evaluate('app.workspace.getLeavesOfType("claudian-view")[0].view !== __claudianSmokeOldView'), true);
  });
  await check('inline-editor', async () => {
    await evaluate(`(async()=>{const leaf=app.workspace.getLeaf('tab');await leaf.openFile(app.vault.getAbstractFileByPath('Smoke.md'));app.workspace.setActiveLeaf(leaf,{focus:true});app.commands.executeCommandById('realclaudian:inline-edit');})()`);
    const input = await cdp.waitFor('textbox', 'Insert instructions');
    await cdp.escape(input.page);
    await until(async () => !await cdp.locate('textbox', 'Insert instructions', false), 'inline editor closes', signal);
  });
  await check('plugin-unload', async () => {
    await evaluate(`(async()=>{await app.plugins.disablePlugin('claudian-smoke-probe');await app.plugins.disablePlugin('realclaudian');for(const [method,original] of Object.entries(__claudianSmokeScopes.original))app.keymap[method]=original;})()`);
    assert.equal(await evaluate('!!app.plugins.plugins.realclaudian'), false);
  });
  await check('renderer-errors', () => {
    writeFileSync(path.join(artifactDir, 'renderer-errors.json'), JSON.stringify(cdp.errors, null, 2));
    assert.deepEqual(cdp.errors, [], 'Renderer console errors, exceptions and failed attachments must be empty');
  });
}
