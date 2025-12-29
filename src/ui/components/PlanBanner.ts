/**
 * PlanBanner component.
 *
 * A collapsible banner that appears below the header to show the approved plan.
 * Collapsed by default, click to expand and see plan content.
 */

import type { App, Component } from 'obsidian';
import { MarkdownRenderer } from 'obsidian';

/** Options for creating the plan banner. */
export interface PlanBannerOptions {
  /** The Obsidian App instance. */
  app: App;
  /** Component for MarkdownRenderer lifecycle. */
  component: Component;
}

/**
 * PlanBanner - collapsible banner showing approved plan content.
 */
export class PlanBanner {
  private app: App;
  private component: Component;
  private containerEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private isExpanded = false;
  private planContent: string = '';

  constructor(options: PlanBannerOptions) {
    this.app = options.app;
    this.component = options.component;
  }

  /**
   * Mount the banner into the container.
   * Should be called after the container is created, inserts between header and messages.
   */
  mount(containerEl: HTMLElement): void {
    this.containerEl = containerEl;
  }

  /**
   * Show the banner with the given plan content.
   */
  async show(planContent: string): Promise<void> {
    if (!this.containerEl) return;

    // Remove existing banner DOM if any (but don't clear planContent yet)
    if (this.bannerEl) {
      this.bannerEl.remove();
      this.bannerEl = null;
      this.contentEl = null;
    }

    this.planContent = planContent;
    this.isExpanded = false;

    // Create the banner element
    this.bannerEl = document.createElement('div');
    this.bannerEl.className = 'claudian-plan-banner';

    // Header (clickable to toggle)
    const headerEl = document.createElement('div');
    headerEl.className = 'claudian-plan-banner-header';
    headerEl.addEventListener('click', () => this.toggle());

    // Chevron icon
    const chevronEl = document.createElement('span');
    chevronEl.className = 'claudian-plan-banner-chevron';
    chevronEl.textContent = '▶';
    headerEl.appendChild(chevronEl);

    // Title
    const titleEl = document.createElement('span');
    titleEl.className = 'claudian-plan-banner-title';
    titleEl.textContent = 'Approved Plan';
    headerEl.appendChild(titleEl);

    this.bannerEl.appendChild(headerEl);

    // Content area (hidden by default)
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'claudian-plan-banner-content';
    this.contentEl.style.display = 'none';

    // Render plan content as markdown
    await this.renderContent();

    this.bannerEl.appendChild(this.contentEl);

    // Insert after header, before messages
    const messagesEl = this.containerEl.querySelector('.claudian-messages');
    if (messagesEl) {
      this.containerEl.insertBefore(this.bannerEl, messagesEl);
    } else {
      this.containerEl.appendChild(this.bannerEl);
    }
  }

  /**
   * Hide and remove the banner.
   */
  hide(): void {
    if (this.bannerEl) {
      this.bannerEl.remove();
      this.bannerEl = null;
      this.contentEl = null;
    }
    this.isExpanded = false;
    this.planContent = '';
  }

  /**
   * Toggle the banner's expanded/collapsed state.
   */
  private toggle(): void {
    this.isExpanded = !this.isExpanded;
    this.updateDisplay();
  }

  /**
   * Update the display based on expanded state.
   */
  private updateDisplay(): void {
    if (!this.bannerEl || !this.contentEl) return;

    const chevron = this.bannerEl.querySelector('.claudian-plan-banner-chevron');
    if (chevron) {
      chevron.textContent = this.isExpanded ? '▼' : '▶';
    }

    this.contentEl.style.display = this.isExpanded ? 'block' : 'none';
    this.bannerEl.classList.toggle('expanded', this.isExpanded);
  }

  /**
   * Render the plan content as markdown.
   */
  private async renderContent(): Promise<void> {
    if (!this.contentEl) return;

    try {
      await MarkdownRenderer.render(
        this.app,
        this.planContent,
        this.contentEl,
        '',
        this.component
      );
    } catch {
      // Fallback to plain text
      this.contentEl.textContent = this.planContent;
    }
  }

  /**
   * Check if the banner is currently visible.
   */
  isVisible(): boolean {
    return this.bannerEl !== null;
  }

  /**
   * Get the current plan content.
   */
  getPlanContent(): string {
    return this.planContent;
  }
}
