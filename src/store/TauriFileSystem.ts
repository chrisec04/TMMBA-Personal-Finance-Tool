/**
 * Tauri implementation of {@link FileSystemPort}.
 *
 * A thin translation layer and nothing more. All persistence rules live in `DataStore`
 * against the port, so they are covered by tests that never need a running app.
 */

import { exists, mkdir, readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { FileSystemError, type FileSystemPort } from './FileSystemPort.ts';

function isNotFound(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /no such file|not found|cannot find|os error 2|os error 3/i.test(message);
}

function wrap(cause: unknown, action: string, path: string): FileSystemError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new FileSystemError(
    `Failed to ${action} ${path}: ${message}`,
    isNotFound(cause) ? 'NOT_FOUND' : 'IO',
  );
}

export class TauriFileSystem implements FileSystemPort {
  async readTextFile(path: string): Promise<string> {
    try {
      return await readTextFile(path);
    } catch (cause) {
      throw wrap(cause, 'read', path);
    }
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    try {
      await writeTextFile(path, contents);
    } catch (cause) {
      throw wrap(cause, 'write', path);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      return await exists(path);
    } catch {
      // If Tauri denies the path, the store cannot use it; treating it as absent gives the
      // caller one clear setup path instead of leaking platform-specific permission errors.
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true });
    } catch (cause) {
      if (await this.exists(path)) return;
      throw wrap(cause, 'create directory', path);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (cause) {
      throw wrap(cause, 'rename', `${from} -> ${to}`);
    }
  }
}
