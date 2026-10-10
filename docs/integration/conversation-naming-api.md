# Conversation naming extension API v1

Feature-detect `app.plugins.getPlugin('realclaudian')?.namingApi?.version === 1`. The contract lives in `src/core/naming/ConversationNamingAPI.ts`.

The host owns persistence, provider selection and lifecycle. An extension owns prompts, validation, optional automation and user controls. No credentials, repositories, views or mutable provider sessions cross the boundary. The API accepts one first-turn subscriber and one regeneration subscriber, preventing duplicate naming providers.

## Events and lifetime

`subscribeFirstTurn` receives the first accepted visible user input, limited to 4,000 Unicode code points. It is not emitted for pre-handoff failure, transcript rendering or tab navigation. Duplicate acceptance signals in the same runtime are coalesced. With no subscriber, the existing built-in title behavior is unchanged. An extension must unsubscribe on unload and fence its queued/in-flight results; plugin unload aborts auxiliary work and invalidates all API calls.

`subscribeRegeneration` handles explicit regeneration. Return values from `requestRegeneration` indicate that an extension accepted the event, not that model generation succeeded.

## Reads and writes

Snapshots contain detached metadata only. Listing does not hydrate native transcripts. `getFirstUserText` is an explicit on-demand operation and **may hydrate native history** for old conversations; extensions must not call it from rendering, tab switching or eager background scans. No duplicate permanent input ledger is added.

`updateTitles` supports independent optimistic checks for long and short titles, evaluated inside the repository persistence queue. A conflicting field is left intact while another unchanged field may update. Memory publication follows durable persistence. Native transcript files are never modified. The optional `shortTitle` metadata is additive; absent values preserve existing behavior.

`runAuxiliaryTextTask` uses the available global title-model selection, independently of the active chat model. Explicit null reasoning follows the provider's selected-model policy; the API does not select cheaper reasoning, guess model IDs or switch providers. Tasks are passive, independently cancellable and bounded to at most 120 seconds including provider initialization. Cleanup cannot extend the caller deadline.

## Minimal extension

```ts
const api = app.plugins.getPlugin('realclaudian')?.namingApi;
if (api?.version === 1) {
  const unsubscribe = api.subscribeFirstTurn(async event => {
    const before = api.getConversationSnapshot(event.conversationId);
    if (!before) return;
    const response = await api.runAuxiliaryTextTask({
      prompt: event.visibleUserText,
      systemPrompt: 'Return a concise conversation title as plain text.',
    });
    await api.updateTitles(event.conversationId, {
      expectedLongTitle: before.longTitle,
      longTitle: response.trim(),
    });
  });
  // Call unsubscribe during extension unload; fence late results separately.
}
```

Existing v1 local prototype extensions that depended on private provider/model overrides or a duplicated input ledger must update their assumptions; these are not part of this upstream contract.
