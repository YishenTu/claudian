import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Collab responsive and accessibility styles', () => {
  const readStyles = () => readFileSync(
    path.resolve('src/style/features/collab-polish.css'),
    'utf8',
  );

  it('registers the final Collab polish layer after the feature styles', () => {
    const index = readFileSync(path.resolve('src/style/index.css'), 'utf8');
    const access = index.indexOf('@import "./features/collab-access.css";');
    const polish = index.indexOf('@import "./features/collab-polish.css";');

    expect(access).toBeGreaterThanOrEqual(0);
    expect(polish).toBeGreaterThan(access);
  });

  it('protects long localized content and keeps the Project name on one line', () => {
    const css = readStyles();

    expect(css).toContain('overflow-wrap: anywhere;');
    expect(css).toContain(
      '.claudian-collab-panel button:not(.claudian-collab-project-picker)',
    );
    const panelCss = readFileSync(
      path.resolve('src/style/features/collab-panel.css'),
      'utf8',
    );
    expect(panelCss).toMatch(
      /\.claudian-collab-project-picker\s*{[^}]*white-space:\s*nowrap;/,
    );
    expect(css.replaceAll('\n', ' ')).toMatch(
      /\.claudian-collab-panel-header,[^}]*flex-wrap:\s*wrap;/,
    );
  });

  it('supports keyboard focus and reduced motion', () => {
    const css = readStyles();

    expect(css).toContain(':focus-visible');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('shows selection backgrounds only on hover', () => {
    const panelCss = readFileSync(
      path.resolve('src/style/features/collab-panel.css'),
      'utf8',
    );
    const requestsCss = readFileSync(
      path.resolve('src/style/features/collab-requests.css'),
      'utf8',
    );

    expect(panelCss).toMatch(
      /\.claudian-collab-panel \.claudian-collab-project-picker\s*{[^}]*background:\s*transparent;/,
    );
    expect(panelCss).toMatch(
      /\.claudian-collab-project-picker:hover\s*{[^}]*background:\s*var\(--background-modifier-hover\);/,
    );
    expect(requestsCss).toMatch(
      /\.claudian-collab-panel \.claudian-collab-team-request\s*{[^}]*background:\s*transparent;/,
    );
    expect(requestsCss).toMatch(
      /\.claudian-collab-team-request:hover\s*{[^}]*background:\s*var\(--background-modifier-hover\);/,
    );
  });

  it('keeps Ticket rows transparent unless the main editor owns that Ticket', () => {
    const ticketsCss = readFileSync(
      path.resolve('src/style/features/collab-tickets.css'),
      'utf8',
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-panel button\.claudian-collab-ticket-list-item:not\(\[aria-current="true"\]\)\s*{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/,
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-panel button\.claudian-collab-ticket-list-item\[aria-current="true"\][^{]*{[^}]*background:\s*var\(--background-modifier-hover\);/,
    );
  });

  it('keeps Ticket title, status, and Edit on one header row', () => {
    const ticketsCss = readFileSync(
      path.resolve('src/style/features/collab-tickets.css'),
      'utf8',
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-ticket-detail-header\s*{[^}]*flex-wrap:\s*nowrap;/,
    );
    expect(ticketsCss).toMatch(
      /button\.claudian-collab-ticket-edit\s*{[^}]*margin-inline-start:\s*auto;/,
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-ticket-number,[^}]*\.claudian-collab-ticket-detail-number\s*{[^}]*color:\s*var\(--text-muted\);[^}]*font-family:\s*var\(--font-monospace\);/,
    );
    expect(ticketsCss).not.toContain('claudian-collab-ticket-assignee-field');
  });

  it('styles the shared Markdown editor as an Obsidian-native Collab surface', () => {
    const index = readFileSync(path.resolve('src/style/index.css'), 'utf8');
    const markdownEditor = index.indexOf(
      '@import "./features/collab-markdown-editor.css";',
    );
    const tickets = index.indexOf('@import "./features/collab-tickets.css";');
    const css = readFileSync(
      path.resolve('src/style/features/collab-markdown-editor.css'),
      'utf8',
    );

    expect(markdownEditor).toBeGreaterThanOrEqual(0);
    expect(tickets).toBeGreaterThan(markdownEditor);
    expect(css).toMatch(
      /\.claudian-collab-markdown-draft \.cm-editor\s*{[^}]*background:\s*transparent;[^}]*border:\s*1px solid var\(--background-modifier-border\);[^}]*box-shadow:\s*none;/,
    );
    expect(css).toMatch(
      /\.claudian-collab-markdown-draft \.cm-content\s*{[^}]*font-family:\s*var\(--font-monospace\);/,
    );
    expect(css).toMatch(
      /\.claudian-collab-markdown-draft \.cm-content\s*{[^}]*caret-color:\s*var\(--text-normal\);/,
    );
    expect(css).toMatch(
      /\.claudian-collab-markdown-draft \.cm-cursor\s*{[^}]*border-left-color:\s*var\(--text-normal\);/,
    );
    expect(css).toMatch(
      /\.claudian-collab-markdown-draft \.cm-editor\.cm-focused > \.cm-scroller > \.cm-selectionLayer \.cm-selectionBackground[^{]*{[^}]*background:\s*var\(--text-selection\) !important;/,
    );
    expect(css).not.toContain('::selection');
    expect(css).toMatch(
      /\.claudian-collab-markdown-draft-preview\s*{[^}]*background:\s*transparent;[^}]*border:\s*1px solid var\(--background-modifier-border\);/,
    );
    const ticketsCss = readFileSync(
      path.resolve('src/style/features/collab-tickets.css'),
      'utf8',
    );
    const commentsCss = readFileSync(
      path.resolve('src/style/features/collab-comments.css'),
      'utf8',
    );
    const reviewCss = readFileSync(
      path.resolve('src/style/features/collab-review.css'),
      'utf8',
    );
    expect(reviewCss).toMatch(
      /\.claudian-collab-review-header > \.claudian-collab-request-description\s*{[^}]*grid-column:\s*1 \/ -1;[^}]*width:\s*100%;/,
    );
    expect(reviewCss).toMatch(
      /\.claudian-collab-review-header\s*{[^}]*border-block-end:\s*1px solid var\(--background-modifier-border\);/,
    );
    expect(reviewCss).toMatch(
      /\.claudian-collab-review-tabs\s*{[^}]*grid-column:\s*1 \/ -1;/,
    );
    expect(reviewCss).toMatch(
      /\.claudian-collab-review-header\.has-primary-action h2\s*{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/,
    );
    expect(reviewCss).toMatch(
      /\.claudian-collab-review-header\.has-primary-action button\.claudian-collab-review-accept\s*{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/,
    );
    expect(reviewCss).toMatch(
      /\.claudian-collab-review-header\.is-request > \.claudian-collab-review-tabs\s*{[^}]*grid-row:\s*2;/,
    );
    expect(reviewCss).toMatch(
      /\.claudian-collab-review \.claudian-collab-review-tabs > button\s*{[^}]*border-bottom:\s*0;/,
    );
    expect(reviewCss).not.toMatch(
      /\.claudian-collab-review \.claudian-collab-review-tabs > button\.is-active\s*{[^}]*border-bottom-color:/,
    );
    expect(reviewCss).toMatch(
      /button\.claudian-collab-review-display-toggle\[hidden\]\s*{[^}]*display:\s*none;/,
    );
    expect(reviewCss).toMatch(
      /\.claudian-collab-review-overview\s*{[^}]*padding:\s*var\(--size-4-2\) 0;/,
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-request-description-modes\s*{[^}]*margin-inline-start:\s*auto;/,
    );
    expect(css).toMatch(
      /\.claudian-collab-markdown-draft-modes\[hidden\]\s*{[^}]*display:\s*none;/,
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-request-description > \[data-collab-description="true"\]\s*{[^}]*width:\s*100%;/,
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-request-description\.is-request:not\(\.is-editing\)[^{]*\.claudian-collab-markdown-draft-preview\s*{[^}]*border:\s*0;[^}]*min-height:\s*0;[^}]*padding:\s*0;/,
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-review \.claudian-collab-markdown-suggestions button\.claudian-collab-markdown-suggestion\s*{[^}]*background:\s*transparent;/,
    );
    expect(ticketsCss).toMatch(
      /button\.claudian-collab-markdown-suggestion\[aria-selected="true"\][^{]*{[^}]*background:\s*var\(--background-modifier-hover\);/,
    );
    expect(commentsCss).toMatch(
      /button\.claudian-collab-comment-submit\s*{[^}]*background:\s*var\(--interactive-normal\);[^}]*border:\s*1px solid var\(--background-modifier-border\);/,
    );
    expect(commentsCss).toMatch(
      /\.claudian-collab-request-comment\s*{[^}]*background:\s*var\(--background-primary\);/,
    );
    expect(commentsCss).not.toMatch(
      /\.claudian-collab-request-comments:not\(\.has-entries\)\s*{[^}]*border-top:\s*0;/,
    );
    expect(commentsCss).toMatch(
      /\.claudian-collab-request-comments:not\(\.has-entries\) > \.claudian-collab-comment-composer\s*{[^}]*border-top:\s*0;/,
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-ticket-activity-item\.is-comment\s*{[^}]*background:\s*var\(--background-primary\);/,
    );
    expect(ticketsCss).not.toMatch(
      /\.claudian-collab-ticket-activity:not\(\.has-entries\)\s*{[^}]*border-top:\s*0;/,
    );
    expect(ticketsCss).toMatch(
      /\.claudian-collab-ticket-activity:not\(\.has-entries\) > \.claudian-collab-comment-composer\s*{[^}]*border-top:\s*0;/,
    );
    expect(css).toMatch(
      /button\.claudian-collab-markdown-ticket-reference\s*{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text-accent\);/,
    );
    expect(css).toContain('.claudian-collab-markdown-draft-preview[hidden]');
  });
});
