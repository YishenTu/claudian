import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    state.identify = value => {
      if (!state.ids.has(value)) state.ids.set(value, state.next++);
      return state.ids.get(value);
    };
    state.snapshot = () => {
      const stack = app.keymap.getWindowStack(state.ownerWindow);
      return {
        window: state.identify(state.ownerWindow),
        active: activeWindow === state.ownerWindow,
        current: state.identify(stack.scope),
        previous: stack.prevScopes.map(state.identify),
        events: state.events.slice(state.start),
      };
    };
    window.__claudianSmokeScopes = state;
    for (const method of ['pushScope','popScope']) {
      state.original[method] = app.keymap[method];
      app.keymap[method] = function(scope) {
        const owner = scope.win;
        const result = state.original[method].call(this, scope);
        const win = method === 'pushScope' ? scope.win : owner;
        state.events.push({method, id: state.identify(scope), window: win ? state.identify(win) : null});
        return result;
      };
    }
  })()`);

  const ownerRun = randomUUID();
  let ownerAction = 0;
  const scopeSnapshot = () => evaluate('__claudianSmokeScopes.snapshot()');
  async function assertOwner(node, owner, marker) {
    const snapshot = await scopeSnapshot();
    assert.equal(snapshot.window, owner, 'The registry retains the captured window');
    assert.equal(snapshot.active, true, 'The captured window is the active dispatch window');
    assert.equal(await cdp.onNode(node, `function(){
      return this.ownerDocument.defaultView[${JSON.stringify(marker.key)}] === ${JSON.stringify(marker.token)};
    }`), true, 'Native control belongs to the marked captured window');
  }
  function assertStack(actual, expected, message) {
    assert.equal(actual.active, true, 'Captured owner remains the active dispatch window');
    assert.equal(actual.window, expected.window, 'Scope window identity is retained');
    assert.equal(actual.current, expected.current, message);
    assert.deepEqual(actual.previous, expected.previous, message);
  }

  async function modal(label, open, name, { field, menu, ready } = {}) {
    return check(label, async () => {
      const marker = { key: `__claudianSmokeOwner_${ownerRun}_${++ownerAction}`, token: randomUUID() };
      try {
        const baseline = await evaluate(`(() => {
          const state = __claudianSmokeScopes;
          state.ownerWindow = activeWindow;
          state.start = state.events.length;
          const key = ${JSON.stringify(marker.key)};
          if (key in state.ownerWindow) throw new Error('Scope owner marker already exists');
          Object.defineProperty(state.ownerWindow, key, { value: ${JSON.stringify(marker.token)}, configurable: true });
          return state.snapshot();
        })()`);
        let menuId;
        let menuPage;
        if (menu) {
          const action = await cdp.waitFor('button', 'Actions for Smoke project');
          await assertOwner(action, baseline.window, marker);
          await cdp.click('button', 'Actions for Smoke project');
          const caption = await cdp.waitFor('menuitem', menu);
          menuPage = caption.page;
          assert.equal(menuPage, action.page, 'Launch menu stays on the source button page');
          await assertOwner(caption, baseline.window, marker);
          const acquired = await until(async () => {
            const snapshot = await scopeSnapshot();
            return snapshot.events.length ? snapshot : undefined;
          }, 'launch menu Scope acquisition', signal);
          assert.equal(acquired.events.length, 1, 'Launch menu acquires one Scope');
          const event = acquired.events[0];
          assert.equal(event.method, 'pushScope');
          assert.equal(event.window, baseline.window);
          menuId = event.id;
          assert.notEqual(menuId, baseline.current);
          assert.ok(!baseline.previous.includes(menuId));
          assertStack(acquired, { ...baseline, current: menuId, previous: [...baseline.previous, baseline.current] }, 'Launch menu preserves the underlying stack');
        }
        await open();
        const dialog = await cdp.waitFor('dialog', name);
        await assertOwner(dialog, baseline.window, marker);
        if (menu) assert.equal(dialog.page, menuPage, 'Project modal stays on the launch menu page');
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
        if (menu) await until(async () => {
          const snapshot = await scopeSnapshot();
          return snapshot.events.some(event => event.method === 'popScope' && event.id === menuId)
            && !await cdp.locate('menuitem', menu, false);
        }, 'launch menu closes and releases its Scope', signal);
        const beforeEscape = await scopeSnapshot();
        const modalEvents = beforeEscape.events.filter(event => event.id !== menuId);
        assert.equal(modalEvents.length, 1, 'One modal Scope acquisition before Escape');
        const modalEvent = modalEvents[0];
        assert.equal(modalEvent.method, 'pushScope');
        const modalId = modalEvent.id;
        assert.notEqual(modalId, baseline.current);
        assert.ok(!baseline.previous.includes(modalId));
        const expectedEvents = menu
          ? [{ method: 'pushScope', id: menuId, window: baseline.window }, { method: 'popScope', id: menuId, window: baseline.window }]
          : [];
        const menuEvents = beforeEscape.events.filter(event => event.id === menuId);
        assert.deepEqual(menuEvents, expectedEvents, 'The same owned launch menu Scope is acquired and released once');
        assert.equal(beforeEscape.events[0].method, 'pushScope');
        if (menu) assert.equal(beforeEscape.events[0].id, menuId, 'Menu acquisition precedes modal acquisition');
        assert.equal(modalEvent.window, baseline.window, 'Modal Scope belongs to the captured window');
        assertStack(beforeEscape, { ...baseline, current: modalId, previous: [...baseline.previous, baseline.current] }, 'Only the modal remains above the exact baseline');
        await assertOwner(dialog, baseline.window, marker);
        writeFileSync(path.join(artifactDir, `${label}.scopes-before.json`), JSON.stringify({ baseline, beforeEscape }, null, 2));
        await cdp.escape(dialog.page);
        await until(async () => !await cdp.locate('dialog', name, false), `${name} closes on Escape`, signal);
        const restored = await scopeSnapshot();
        const events = restored.events;
        assert.deepEqual(events.slice(0, -1), beforeEscape.events, 'No unknown Scope transitions during Escape');
        assert.deepEqual(events.at(-1), { method: 'popScope', id: modalId, window: baseline.window }, 'Escape releases the same owned modal Scope exactly once');
        assertStack(restored, baseline, 'Escape restores the exact current and ordered previous Scope identities');
        const fieldEvents = field ? await cdp.evaluate(dialog.page, 'window.__claudianSmokeFieldEvents') : undefined;
        if (field) assert.deepEqual(fieldEvents, [{ key: 'Escape', prevented: true, connected: false, targetSame: true }], 'Host capture must close once before the original event reaches the detached field');
        return { name, baseline, beforeEscape, restored, events, ...(fieldEvents ? { fieldEvents } : {}) };
      } finally {
        await evaluate(`(() => {
          const owner = __claudianSmokeScopes.ownerWindow;
          const key = ${JSON.stringify(marker.key)};
          if (Object.hasOwn(owner, key) && owner[key] === ${JSON.stringify(marker.token)}) delete owner[key];
        })()`);
      }
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

  async function ensureHistoryOpen() {
    if (!await cdp.locate('button', 'New project', false)) {
      await cdp.click('button', 'Chat history');
    }
    await cdp.waitFor('button', 'New project');
  }

  await check('project-fixture', async () => {
    await cdp.click('button', 'New project');
    await cdp.onNode(await cdp.waitFor('textbox', 'Name'), `function(){this.value='Smoke project';this.dispatchEvent(new this.ownerDocument.defaultView.Event('input',{bubbles:true}));this.dispatchEvent(new this.ownerDocument.defaultView.Event('change',{bubbles:true}));}`);
    await cdp.click('button', 'Save');
    await until(async () => !await cdp.locate('dialog', 'New project', false), 'New project closes after Save', signal);
    await ensureHistoryOpen();
    await cdp.waitFor('button', 'Actions for Smoke project');
  });
  await modal('project-memory', () => cdp.click('menuitem', 'Open project memory'), 'Project memory: Smoke project', { menu: 'Open project memory', ready: () => cdp.waitFor('button', 'Edit') });
  await ensureHistoryOpen();
  await modal('confirm-delete-project', () => cdp.click('menuitem', 'Delete project'), 'Confirm', { menu: 'Delete project' });

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
  await modal('skill-sync', () => cdp.click('button', 'Sync'), 'Replace .claude/skills with a link?');
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
