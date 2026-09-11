/** @jest-environment jsdom */

import { getByRole, queryByRole } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

import type { CollabProjectUpdateInspection, CollabPublicationReview } from '@/core/collab';
import { ProjectUpdatePanel } from '@/features/collab/sidebar/ProjectUpdatePanel';

const axe = configureAxe({ rules: { region: { enabled: false } } });
const review: CollabPublicationReview = {
  intent: 'update', kind: 'publication', projectId: 'project-a', operationId: 'update-a',
  baseMainOid: '1'.repeat(40), currentMainOid: '2'.repeat(40), contributionHeadOid: '3'.repeat(40),
  candidateOid: '4'.repeat(40), comparisonBaseOid: '3'.repeat(40), comparisonTargetOid: '4'.repeat(40), files: [], canConfirm: true,
};

function fixture() {
  const root = document.createElement('div');
  document.body.append(root);
  const updateProject = jest.fn().mockResolvedValue({ status: 'success', value: { projectId: 'project-a', localHeadOid: review.contributionHeadOid, state: 'review-required', review } });
  const onReview = jest.fn();
  const onConflict = jest.fn();
  const refresh = jest.fn();
  const panel = new ProjectUpdatePanel(root, { projectId: 'project-a', port: { updateProject }, onReview, onConflict, refresh });
  return { root, panel, updateProject, onReview, onConflict, refresh };
}

afterEach(() => document.body.replaceChildren());

it('shows the whole Update bar only for a confirmed actionable update', async () => {
  const f = fixture();
  for (const state of [undefined, { state: 'unknown', reason: 'offline' }, { state: 'unknown', reason: 'not-fetched' }, { state: 'current' }] as (CollabProjectUpdateInspection | undefined)[]) {
    f.panel.adopt(state);
    expect(queryByRole(f.root, 'button', { name: 'Update' })).toBeNull();
    expect(f.root.textContent).toBe('');
    expect(f.root.hidden).toBe(true);
  }
  f.panel.adopt({ state: 'available' });
  getByRole(f.root, 'button', { name: 'Update' }).click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.updateProject).toHaveBeenCalledWith('project-a');
  expect(f.onReview).toHaveBeenCalledWith(review);
  expect(await axe(f.root)).toHaveNoViolations();
  f.panel.destroy();
});

it('keeps Update conflict navigation and continuation together', async () => {
  const f = fixture();
  f.panel.adopt({ state: 'conflict', conflictOperationId: 'update-a' });
  getByRole(f.root, 'button', { name: 'View conflicts' }).click();
  expect(f.onConflict).toHaveBeenCalledWith('update-a');
  getByRole(f.root, 'button', { name: 'Continue update' }).click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.updateProject).toHaveBeenCalledTimes(1);
  expect(await axe(f.root)).toHaveNoViolations();
  f.panel.destroy();
});

it('does not navigate when a pending mutation settles after hiding or destruction', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.updateProject.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  f.panel.adopt({ state: 'available' });
  getByRole(f.root, 'button', { name: 'Update' }).click();
  f.panel.setActive(false);
  finish({ status: 'success', value: { projectId: 'project-a', state: 'review-required', review } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.onReview).not.toHaveBeenCalled();
  f.panel.destroy();
});

it.each(['offline', 'not-fetched'] as const)('keeps the bar hidden when an Update result arrives after %s inspection', async reason => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.updateProject.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  f.panel.adopt({ state: 'available' });
  getByRole(f.root, 'button', { name: 'Update' }).click();
  f.panel.adopt({ state: 'unknown', reason });
  finish({ status: 'success', value: { projectId: 'project-a', state: 'review-required', review } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.root.hidden).toBe(true);
  expect(f.root.textContent).toBe('');
  expect(f.onReview).not.toHaveBeenCalled();
  f.panel.destroy();
});
