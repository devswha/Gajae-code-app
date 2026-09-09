import type { DropEvent } from 'react-dropzone';

import { beginComposerOperation } from '../../../shared/composerFreeze';

/** Keep the native input itself alive until its actual change/cancel event,
 * even when React unmounts the composer. No focus timer guesses cancellation. */
export function chooseComposerAttachments(onFiles: (files: File[]) => void | Promise<void>, onError: (error: Error) => void) {
  const finish = beginComposerOperation('attachment');
  if (!finish) return;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.hidden = true;
  input.dataset.composerAttachmentPicker = 'true';
  let settling = false;
  const cleanup = () => { input.remove(); finish(); };
  input.addEventListener('cancel', () => {
    if (settling) return;
    settling = true;
    cleanup();
  });
  input.addEventListener('change', () => {
    if (settling) return;
    settling = true;
    const files = Array.from(input.files ?? []);
    void Promise.resolve().then(() => onFiles(files)).catch((error: unknown) => {
      onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(cleanup);
  });
  try { document.body.append(input); input.click(); } catch (error) {
    cleanup();
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Materialize selected/dropped Files while the caller holds admission. Hover
 * only returns item metadata; it is not an accepted attachment operation. */
export async function composerFilesFromEvent(event: DropEvent): Promise<Array<File | DataTransferItem>> {
  if (Array.isArray(event)) return Promise.all(event.map((handle) => handle.getFile()));
  if (!('dataTransfer' in event) || !event.dataTransfer) {
    return Array.from((event.target as HTMLInputElement | null)?.files ?? []);
  }
  const items = Array.from(event.dataTransfer.items ?? []).filter((item) => item.kind === 'file');
  if (event.type !== 'drop') return items;
  if (!items.length) return Array.from(event.dataTransfer.files);
  const files: File[] = [];
  const visit = async (entry: FileSystemEntry) => {
    if (entry.isFile) {
      files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child);
      }
    }
  };
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) await visit(entry);
    else { const file = item.getAsFile(); if (file) files.push(file); }
  }
  return files;
}
