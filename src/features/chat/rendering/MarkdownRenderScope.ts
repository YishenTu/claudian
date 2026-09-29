import { Component } from 'obsidian';

/** One Markdown render, including registrations that arrive after it was replaced. */
export class MarkdownRenderScope extends Component {
  isReleased = false;

  override unload(): void {
    if (this.isReleased) return;
    this.isReleased = true;
    super.unload();
  }

  override register(callback: () => void): void {
    if (this.isReleased) callback();
    else super.register(callback);
  }

  override addChild<T extends Component>(child: T): T {
    if (!this.isReleased) return super.addChild(child);
    // Native Component.unload() does nothing until load(). Late embed owners
    // still need their registered resources released, even after our unload.
    try {
      child.load();
    } finally {
      child.unload();
    }
    return child;
  }
}
