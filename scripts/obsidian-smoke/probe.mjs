/* global window, AbortController, setTimeout */
// Installed only in the temporary smoke vault, never bundled with Claudian.
import { apiVersion, Component, ItemView, Plugin } from 'obsidian';
import { chooseForkTarget } from '../../src/features/chat/tabs/forking/ForkTargetModal';
import { ObsidianPiExtensionUIRenderer } from '../../src/providers/pi/ui/ObsidianPiExtensionUIRenderer';

export default class SmokeProbe extends Plugin {
  onload() {
    this.aborters = [];
    const renderer = new ObsidianPiExtensionUIRenderer(this.app);
    window.__claudianSmokeProbe = {
      hostVersion: apiVersion,
      result: undefined,
      fork: () => {
        window.__claudianSmokeProbe.pending = chooseForkTarget(this.app).then(result => { window.__claudianSmokeProbe.result = result; });
      },
      pi: method => {
        const controller = new AbortController(); this.aborters.push(controller);
        window.__claudianSmokeProbe.pending = renderer[method]({
          id: `smoke-${method}`, title: `Pi smoke ${method}`, options: ['First', 'Second'], defaultValue: 'Smoke text', prefill: 'Smoke editor',
        }, controller.signal).then(result => { window.__claudianSmokeProbe.result = result; });
      },
      lifecycle: async () => {
        const component = new Component();
        let release; let started = false; let settled = false;
        component.addChild(new Component()).onload = () => { started = true; return new Promise(resolve => { release = resolve; }); };
        const completion = component.load();
        Promise.resolve(completion).then(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        const result = { componentChildStarted: started, componentReturnsPromise: !!completion?.then, componentWaitsForChild: !settled };
        release(); await completion; component.unload();
        const leaf = this.app.workspace.getLeaf('tab');
        class SmokeView extends ItemView { getViewType() { return 'claudian-smoke-view'; } getDisplayText() { return 'Smoke view'; } }
        const view = new SmokeView(leaf);
        let releaseView; let viewStarted = false; let unloaded = false;
        const child = view.addChild(new Component());
        child.onload = () => { viewStarted = true; return new Promise(resolve => { releaseView = resolve; }); };
        child.onunload = () => { unloaded = true; };
        result.itemViewReturnsUndefined = view.load() === undefined;
        result.itemViewStartsChild = viewStarted;
        releaseView(); await new Promise(resolve => setTimeout(resolve, 0));
        view.unload(); result.itemViewUnloadsChild = unloaded; leaf.detach();
        return result;
      },
    };
  }
  onunload() {
    for (const controller of this.aborters) controller.abort();
    delete window.__claudianSmokeProbe;
  }
}
