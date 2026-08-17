/**
 * Node implementation of {@link FileSystemPort}.
 *
 * Used by tests or scripts that exercise the store against a real filesystem rather than the
 * in-memory double.
 */

import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { FileSystemError, type FileSystemPort } from './FileSystemPort.ts';

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: string }).code === 'ENOENT'
  );
}

function wrap(cause: unknown, action: string, path: string): FileSystemError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new FileSystemError(
    `Failed to ${action} ${path}: ${message}`,
    isNotFound(cause) ? 'NOT_FOUND' : 'IO',
  );
}

export class NodeFileSystem implements FileSystemPort {
  async readTextFile(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch (cause) {
      throw wrap(cause, 'read', path);
    }
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    try {
      await writeFile(path, contents, 'utf8');
    } catch (cause) {
      throw wrap(cause, 'write', path);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true });
    } catch (cause) {
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
