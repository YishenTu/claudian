import { appendFileSync } from 'node:fs';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

export async function until(check, description, signal, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await check();
    if (value) return value;
    await delay(100, undefined, { signal });
  }
  throw new Error(`Timed out: ${description}`);
}

/** One connection to the owned browser, including settings/popout page targets. */
export class CDP {
  constructor(url, { signal, eventLog }) {
    this.socket = new WebSocket(url);
    this.signal = signal;
    this.eventLog = eventLog;
    this.pending = new Map();
    this.pages = new Map();
    this.errors = [];
    this.nextId = 0;
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('message', data => this.receive(JSON.parse(String(data))));
    this.socket.on('close', () => this.rejectPending(new Error('CDP connection closed')));
    this.onAbort = () => { this.rejectPending(signal.reason); this.socket.terminate(); };
    signal.addEventListener('abort', this.onAbort, { once: true });
  }

  rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }

  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = message.params;
      if (targetInfo.type === 'page') {
        const page = { ...targetInfo, sessionId };
        this.pages.set(targetInfo.targetId, page);
        page.ready = this.prepare(page).catch(error => { this.errors.push({ kind: 'attach', message: String(error) }); });
      } else {
        void this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      }
    }
    if (message.method === 'Target.detachedFromTarget') {
      for (const [id, page] of this.pages) if (page.sessionId === message.params.sessionId) this.pages.delete(id);
    }
    if (['Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Log.entryAdded'].includes(message.method)) {
      appendFileSync(this.eventLog, JSON.stringify({ at: new Date().toISOString(), ...message }) + '\n');
      if (message.method === 'Runtime.exceptionThrown'
        || (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
        || (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')) this.errors.push(message);
    }
  }

  async prepare(page) {
    // Keep owned windows away from the user's working area; never request OS foreground focus.
    try {
      const { windowId } = await this.send('Browser.getWindowForTarget', { targetId: page.targetId });
      await this.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000, width: 1024, height: 800 } });
    } catch (error) {
      appendFileSync(this.eventLog, JSON.stringify({ windowPlacementWarning: String(error) }) + '\n');
    }
    await this.send('Runtime.enable', {}, page.sessionId);
    await this.send('Log.enable', {}, page.sessionId);
    await this.send('Page.enable', {}, page.sessionId);
    await this.send('Runtime.runIfWaitingForDebugger', {}, page.sessionId);
  }

  async start() {
    await this.ready;
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetInfos } = await this.send('Target.getTargets');
    for (const target of targetInfos.filter(item => item.type === 'page')) {
      if (!this.pages.has(target.targetId)) await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    }
  }

  send(method, params = {}, sessionId) {
    this.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(page, expression) {
    await page.ready;
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }

  async tree(page) {
    await page.ready;
    return (await this.send('Accessibility.getFullAXTree', {}, page.sessionId)).nodes;
  }

  async locate(role, name, required = true) {
    const trees = [];
    for (const page of this.pages.values()) {
      const nodes = await this.tree(page);
      trees.push({ page, nodes });
      const node = nodes.find(node => !node.ignored && node.role?.value === role && (name instanceof RegExp ? name.test(node.name?.value ?? '') : node.name?.value === name));
      if (node?.backendDOMNodeId) return { page, node };
    }
    // Some host HTML menus expose their captions as StaticText rather than menuitem.
    if (role === 'menuitem' && typeof name === 'string') {
      for (const { page, nodes } of trees) {
        for (const node of nodes.filter(node => !node.ignored && node.role?.value === 'StaticText' && node.name?.value === name && node.backendDOMNodeId)) {
          const target = { page, node, menuCaption: name };
          if (await this.menuCaptionPoint(target)) return target;
        }
      }
    }
    if (required) throw new Error(`No accessible ${role} named ${JSON.stringify(name)}`);
    return null;
  }

  waitFor(role, name) { return until(() => this.locate(role, name, false), `${role} ${name}`, this.signal); }

  async onNode({ page, node }, functionDeclaration) {
    const { object } = await this.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }, page.sessionId);
    try {
      const result = await this.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, awaitPromise: true, returnByValue: true }, page.sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    } finally { await this.send('Runtime.releaseObject', { objectId: object.objectId }, page.sessionId); }
  }

  async menuCaptionPoint(target, scroll = false) {
    return this.onNode(target, `function(){
      const element=this.nodeType===3?this.parentElement:this;
      const title=element?.closest('.menu-item-title');
      const item=title?.closest('.menu-item');
      const menu=item?.closest('.menu');
      if(!title||!item||!menu||title.textContent!==${JSON.stringify(target.menuCaption)})return null;
      const win=title.ownerDocument.defaultView;
      for(const el of [title,item,menu]){
        const style=win.getComputedStyle(el);const rect=el.getBoundingClientRect();
        if(!el.isConnected||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0||rect.width<=0||rect.height<=0)return null;
      }
      if(${scroll})item.scrollIntoView({block:'center'});
      const rect=item.getBoundingClientRect();
      const point={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      const hit=title.ownerDocument.elementFromPoint(point.x,point.y);
      return hit&&item.contains(hit)?point:null;
    }`);
  }

  async click(role, name) {
    const target = await this.waitFor(role, name);
    const point = target.menuCaption === undefined
      ? await this.onNode(target, 'function(){this.scrollIntoView({block:"center"});const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}')
      : await this.menuCaptionPoint(target, true);
    if (!point) throw new Error(`Host menu caption is no longer visible: ${name}`);
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }, target.page.sessionId);
    return target;
  }

  async escape(page) {
    for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', {
      type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 53,
    }, page.sessionId);
  }

  close() {
    this.signal.removeEventListener('abort', this.onAbort);
    this.rejectPending(new Error('CDP disposed'));
    this.socket.terminate();
  }
}
