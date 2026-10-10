import '@/providers';

import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationNamingAPIHost } from '@/app/integration/ConversationNamingAPIHost';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { Conversation } from '@/core/types';
import { ConversationNamingService } from '@/features/conversation-naming/ConversationNamingService';
import { parseNamingResponse } from '@/features/conversation-naming/NamingResponse';

function fixture(task: () => Promise<string> = async () => '{"longTitle":"Repair labels","shortTitle":"Label repair"}') {
  const now = testDate().getTime();
  const record: Conversation = { id: 'one', providerId: 'claude', title: 'Before', createdAt: now, lastActivityAt: now, sessionId: null, messages: [] };
  const repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => ({}), getVaultPath: () => '/vault',
    persistence: { saveMetadata: jest.fn().mockResolvedValue(undefined), metadataReader: { revalidate: async () => [] } } as unknown as ConversationPersistence,
    onConversationDeleted: async () => undefined,
  });
  repository.replaceAll([record]);
  const api = new ConversationNamingAPIHost({
    getActiveConversationId: () => 'one', getSnapshot: id => repository.getNamingSnapshot(id),
    listSnapshots: () => repository.list().map(value => ({ conversationId: value.id, createdAt: value.createdAt, longTitle: value.title, shortTitle: value.shortTitle ?? null })),
    getFirstUserText: async () => 'Repair labels', runTextTask: task,
    updateTitles: (id, value) => repository.updateNamingTitles(id, value),
    setGenerationStatus: async (id, titleGenerationStatus) => { await repository.update(id, { titleGenerationStatus }); return true; },
  });
  const service = new ConversationNamingService(api, { language: () => 'English', automatic: () => true, onFailure: () => undefined });
  service.enable();
  return { repository, api, service };
}

it.each(['修复标签', 'Label repair', 'étiquettes', 'ラベル修正', '레이블 수정'])('accepts a semantic Unicode label: %s', value => {
  expect(parseNamingResponse(JSON.stringify({ longTitle: 'Repair conversation labels', shortTitle: value }))).toEqual({ longTitle: 'Repair conversation labels', shortTitle: value });
});

it('rejects malformed output instead of replacing the existing title', async () => {
  const { service, repository } = fixture(async () => 'I cannot name this');
  expect(await service.generate('one', 'Fix labels', 'both')).toBe('failed');
  expect(repository.getSummary('one')?.title).toBe('Before');
  service.disable();
});

it('persists long and short titles through the real repository', async () => {
  const { service, repository } = fixture();
  expect(await service.generate('one', 'Fix labels', 'both')).toBe('updated');
  expect(repository.getNamingSnapshot('one')).toMatchObject({ longTitle: 'Repair labels', shortTitle: 'Label repair' });
  service.disable();
});

it('preserves a manual long-title edit while the model is running', async () => {
  let finish!: (text: string) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const reply = new Promise<string>(resolve => { finish = resolve; });
  const { service, repository } = fixture(() => { started(); return reply; });
  const result = service.generate('one', 'Fix labels', 'both');
  await ready;
  await repository.rename('one', 'User-owned title');
  finish('{"longTitle":"Generated","shortTitle":"Labels"}');
  expect(await result).toBe('updated');
  expect(repository.getNamingSnapshot('one')).toMatchObject({ longTitle: 'User-owned title', shortTitle: 'Labels' });
  service.disable();
});

it('fences late model results after disable', async () => {
  let finish!: (text: string) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const reply = new Promise<string>(resolve => { finish = resolve; });
  const { service, repository } = fixture(() => { started(); return reply; });
  const result = service.generate('one', 'Fix labels', 'both');
  await ready;
  service.disable();
  finish('{"longTitle":"Late","shortTitle":"Late"}');
  expect(await result).toBe('cancelled');
  expect(repository.getNamingSnapshot('one')).toMatchObject({ longTitle: 'Before', shortTitle: null });
});

it('batch fills missing labels without changing a manual label or long title', async () => {
  const { service, repository } = fixture();
  const original = repository.getSync('one')!;
  repository.replaceAll([original, { ...original, id: 'two', shortTitle: 'Manual label' }]);
  expect(await service.batch(null)).toEqual({ updated: 1, failed: 0, skipped: 0 });
  expect(repository.getNamingSnapshot('one')).toMatchObject({ longTitle: 'Before', shortTitle: 'Label repair' });
  expect(repository.getNamingSnapshot('two')?.shortTitle).toBe('Manual label');
  service.disable();
});


it('preserves edits made while the explicit naming source is being read', async () => {
  const { service, repository, api } = fixture();
  const before = api.getConversationSnapshot('one')!;
  await repository.rename('one', 'Edited during source read');
  expect(await service.generate('one', 'Original request', 'both', before)).toBe('updated');
  expect(repository.getNamingSnapshot('one')).toMatchObject({ longTitle: 'Edited during source read', shortTitle: 'Label repair' });
  service.disable();
});
