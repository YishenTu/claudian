# Visible models, order and aliases

Choose which models appear in chat selectors and give them convenient labels.
These settings use the catalog reported by your configured provider.

## Choose visible models

1. Open **Settings → Claudian → Providers** and select the provider.
2. Find **Models → Visible models**, then open **Browse models**.
3. Click **Discover** when no models have been discovered, or **Refresh** when a catalog is already listed.
4. Check or uncheck models to include or remove them from the chat selector.

Use search to filter by model, provider or ID. Use the provider filter where it is offered.
Filtering does not create a native model or enable it in the provider's account.
If a model is absent, follow [A newly released model is missing](troubleshooting.md#a-newly-released-model-is-missing).

## Order the selected list

Drag a selected row outside its controls to move it.
For keyboard ordering, focus its **Reorder** handle and press **Up** or **Down**.
The selected order is saved and used in the chat selector.
The first currently usable selected model receives the **Default** badge.

Missing or unavailable selections remain listed; they do not define that default.
Use a row's **×** control to remove it, or **Clear all** to clear the selected list.
These controls change visible selection, not the provider installation or account.
Keep at least one usable model selected to use the provider.

## Default and chat choices

**Default** identifies the provider-list preference.
Reordering does not retarget existing conversations or force every new chat to the first row.
A conversation's saved model remains its choice, even if that choice becomes unavailable.
New chats may reuse the last selected provider/model, including an unavailable last-selected identity.
If you need a particular model, check the chat's model selector instead of relying on list order alone.

## Give a model an alias

Use **Alias (optional)** on a selected row for a friendly selector label.
The underlying model ID remains visible and unchanged; an alias does not create a native model.

- Leave the field or press **Enter** to save.
- Press **Escape** to restore its last saved field value.
- Clear the field and save to remove the alias.
- During IME composition, Enter and Escape are left to text input.

An alias changes the label, not model availability, permissions or context limits.

## Save and discovery feedback

Discovery errors or stale-catalog messages appear above the picker.
If saving a selection or alias reports an error, inspect the displayed state and retry.
A failed alias draft may remain in its field for retry; an error notice does not confirm that it was saved.
