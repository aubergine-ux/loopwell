// The desktop app (see src-tauri). In a browser tab none of this is used:
// `isDesktop` is false and the Tauri code is never even loaded.

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface DiskSample { path: string; name: string; size: number }

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call<T>(cmd, args);
}

/** Save through the system's "Save as" dialog. Resolves false if the dialog was cancelled. */
export const saveFile = (name: string, data: Uint8Array) => invoke<boolean>('save_file', { name, data: Array.from(data) });

export const sampleFolders = () => invoke<string[]>('sample_folders');
export const addSampleFolder = () => invoke<string | null>('add_sample_folder');
export const removeSampleFolder = (folder: string) => invoke<void>('remove_sample_folder', { folder });
export const listSamples = (folder: string) => invoke<DiskSample[]>('list_samples', { folder });
export const readSample = async (path: string) => new Uint8Array(await invoke<ArrayBuffer>('read_sample', { path }));

/** A line for the terminal (shown when the app was started with LOOPWELL_LOG set). */
export const log = (message: string) => { if (isDesktop) void invoke('log', { message }).catch(() => {}); };

/**
 * Hand over project files the system asked the app to open: the ones it was
 * started with, and any double-clicked while it is running.
 */
export async function onProjectOpened(open: (bytes: Uint8Array, name: string) => void): Promise<void> {
  if (!isDesktop) return;
  const take = async () => {
    for (const path of await invoke<string[]>('take_opened')) {
      try {
        open(new Uint8Array(await invoke<ArrayBuffer>('read_project', { path })), path.split(/[\\/]/).pop() ?? 'project');
      } catch (e) {
        log(`could not open ${path}: ${e}`);
      }
    }
  };
  const { listen } = await import('@tauri-apps/api/event');
  await listen('opened', () => void take());
  await take();
}
