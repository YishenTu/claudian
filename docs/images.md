# Image attachments

Paste or drop images into the message composer to include them with your prompt.
Check the attached images before sending, especially after changing the destination.

## Attach and send

1. Paste an image from the clipboard into the composer, or drop supported image files onto it.
2. Wait for an **Image** chip, or numbered **Image 1**, **Image 2**, and so on when several are attached.
3. Activate a chip to inspect that image in a preview.
4. Close the preview, add any instructions, then send with your configured controls or shortcut.

The visible chips use short labels; their accessible names include the image filename and size.
A chip confirms a local attachment, not successful provider ingestion or model understanding.

## Preview and remove

Close a preview with its **×** button, **Escape**, or the dimmed background outside the image dialog.
Closing the preview leaves the image attached to the draft.
Use the chip's separate **Remove** control to remove an unintended draft attachment.
Removing it does not delete the original image file.

## Formats and size

Supported formats are **JPEG** (`.jpg`, `.jpeg`), **PNG**, **GIF** and **WebP**.
Each image may be at most **5 MiB** (5 × 1024 × 1024 bytes), displayed as **5.0 MB** in the UI.
This is a per-image limit, not a total prompt-size or image-count allowance.

## If an image does not appear

- A supported image that is too large can produce an image-limit notice.
- An unsupported clipboard image type can produce an unsupported-type notice.
- A read failure can produce an attach-failed notice, sometimes with file-not-found or permission details.
- Dropped files with unsupported names or MIME types may be ignored without a notice.

If no image chip appears, the attachment is not confirmed.
Check the format and size, then try adding the image again.

## Destination and model limits

Image availability follows the destination's provider capabilities.
If attachments become disabled, the current draft images are cleared.
Check the chips again after changing destinations; do not rely on cleared images returning automatically.
Provider attachment support does not guarantee that every model or endpoint can understand images or accepts the same limits.

These controls attach image bytes. `@` file/folder references and Linked content supply path context through separate controls.
A path reference is not confirmation that image bytes have been attached.
