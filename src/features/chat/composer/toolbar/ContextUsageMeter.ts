import type { UsageInfo } from '@/core/types';

export class ContextUsageMeter {
  private container: HTMLElement;
  private fillPath: SVGPathElement | null = null;
  private percentEl: HTMLElement | null = null;
  private circumference: number = 0;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'claudian-context-meter' });
    this.container.setAttribute('role', 'progressbar');
    this.container.setAttribute('aria-label', 'Context usage');
    this.container.setAttribute('aria-valuemin', '0');
    this.container.setAttribute('aria-valuemax', '100');
    this.render();
    // Initially hidden
    this.container.addClass('claudian-hidden');
  }

  setVisible(visible: boolean): void {
    this.container.toggleClass('claudian-hidden', !visible);
  }

  private render() {
    const size = 16;
    const strokeWidth = 2;
    const radius = (size - strokeWidth) / 2;
    const cx = size / 2;
    const cy = size / 2;

    // 240° arc: from 150° to 390° (upper-left through bottom to upper-right)
    const startAngle = 150;
    const endAngle = 390;
    const arcDegrees = endAngle - startAngle;
    const arcRadians = (arcDegrees * Math.PI) / 180;
    this.circumference = radius * arcRadians;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(startRad);
    const y1 = cy + radius * Math.sin(startRad);
    const x2 = cx + radius * Math.cos(endRad);
    const y2 = cy + radius * Math.sin(endRad);

    const gaugeEl = this.container.createDiv({ cls: 'claudian-context-meter-gauge' });
    const svg = gaugeEl.createSvg('svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

    const pathData = `M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}`;
    const backgroundPath = svg.createSvg('path');
    backgroundPath.classList.add('claudian-meter-bg');
    backgroundPath.setAttribute('d', pathData);
    backgroundPath.setAttribute('fill', 'none');
    backgroundPath.setAttribute('stroke-width', String(strokeWidth));
    backgroundPath.setAttribute('stroke-linecap', 'round');

    const fillPath = svg.createSvg('path');
    fillPath.classList.add('claudian-meter-fill');
    fillPath.setAttribute('d', pathData);
    fillPath.setAttribute('fill', 'none');
    fillPath.setAttribute('stroke-width', String(strokeWidth));
    fillPath.setAttribute('stroke-linecap', 'round');
    fillPath.setAttribute('stroke-dasharray', String(this.circumference));
    fillPath.setAttribute('stroke-dashoffset', String(this.circumference));

    svg.appendChild(backgroundPath);
    svg.appendChild(fillPath);
    gaugeEl.appendChild(svg);
    this.fillPath = fillPath;

    this.percentEl = this.container.createSpan({ cls: 'claudian-context-meter-percent' });
  }

  update(usage: UsageInfo | null): void {
    if (!usage || usage.contextTokens <= 0) {
      this.container.addClass('claudian-hidden');
      return;
    }
    this.container.removeClass('claudian-hidden');
    const fillLength = (usage.percentage / 100) * this.circumference;
    if (this.fillPath) {
      this.fillPath.setAttribute('stroke-dashoffset', String(this.circumference - fillLength));
    }

    if (this.percentEl) {
      this.percentEl.setText(`${usage.percentage}%`);
    }

    this.container.toggleClass('warning', usage.percentage > 80);

    // Set tooltip with detailed usage
    const usageText = `${this.#formatTokens(usage.contextTokens)} / ${this.#formatTokens(usage.contextWindow)}`;
    // The percentage leads because zen shows the gauge without its number.
    let tooltip = `${usage.percentage}% · ${usageText}`;
    if (usage.percentage > 80) {
      tooltip += ' (Approaching limit, run `/compact` to continue)';
    }
    this.container.setAttribute('aria-label', `Context usage: ${tooltip}`);
    this.container.setAttribute('aria-valuenow', String(usage.percentage));
    this.container.setAttribute('aria-valuetext', usageText);
  }

  #formatTokens(tokens: number): string {
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}k`;
    }
    return String(tokens);
  }
}
