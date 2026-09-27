import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

// Public native SDK surface used by the external Pi peer for metadata anchors.
export class SessionManager {
  static open(file) { return new SessionManager(file); }
  constructor(file) {
    this.file = file;
    this.entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    this.leafId = this.entries.at(-1)?.id;
  }
  getSessionId() { return this.entries[0].id; }
  getEntry(id) { return this.entries.find(entry => entry.id === id); }
  branch(id) { this.leafId = id; }
  appendCustomEntry(customType) {
    const entry = { type: 'custom', id: randomUUID(), parentId: this.leafId, customType };
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    this.leafId = entry.id;
    return entry.id;
  }
}
