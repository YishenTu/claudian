import { readFileSync } from 'node:fs';
import path from 'node:path';

const FEATURE_STYLES = [
  'collab-access.css',
  'collab-comments.css',
  'collab-panel.css',
  'collab-publish.css',
  'collab-requests.css',
];

function readFeatureStyle(file: string): string {
  return readFileSync(path.resolve('src/style/features', file), 'utf8');
}

describe('Collab changed-file styles', () => {
  it('uses one shared class vocabulary for list and flat surfaces', () => {
    const publishCss = readFeatureStyle('collab-publish.css');
    const requestsCss = readFeatureStyle('collab-requests.css');

    expect(publishCss).toContain('.claudian-collab-file-list');
    expect(publishCss).toContain('.claudian-collab-file-list--list');
    expect(publishCss).toContain('.claudian-collab-file-list--flat');
    expect(publishCss).toContain('button.claudian-collab-file-button');
    expect(publishCss).toContain('.claudian-collab-file-kind[data-kind="added"]');
    expect(publishCss).toContain('.claudian-collab-file-kind[data-kind="deleted"]');
    expect(publishCss).toContain('.claudian-collab-file-path');
    expect(publishCss).toMatch(
      /button\.claudian-collab-file-button:is\(:hover, :focus-visible\)\s*\{[^}]*background:\s*var\(--background-modifier-hover\)/,
    );

    const changedFileCss = publishCss + requestsCss;
    expect(changedFileCss).not.toContain('claudian-collab-publish-files');
    expect(changedFileCss).not.toContain('claudian-collab-publish-file-');
    expect(changedFileCss).not.toContain('claudian-collab-team-request-files');
    expect(changedFileCss).not.toContain('claudian-collab-team-request-file');
  });

  it('removes only the verified static orphans and retains status modifiers', () => {
    const css = FEATURE_STYLES.map(readFeatureStyle).join('\n');

    for (const orphan of [
      'claudian-collab-access-invites',
      'claudian-collab-host-controls',
      'claudian-collab-invitation',
      'claudian-collab-project-details',
      'claudian-collab-publish-sync-action',
      'claudian-collab-publish-update',
      'claudian-collab-request-comments-empty',
    ]) {
      expect(css).not.toContain(orphan);
    }

    expect(css).toContain('.claudian-collab-publish-status--conflict');
    expect(css).toContain('.claudian-collab-publish-status--error');
    expect(css).toContain('.claudian-collab-publish-status--offline');
    expect(css).toContain('.claudian-collab-publish-status--awaiting-request');
    expect(css).toContain('.claudian-collab-publish-status--cancelled');
  });
});
