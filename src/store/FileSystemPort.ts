/**
 * Filesystem port.
 *
 * The store is written against this narrow interface rather than Tauri directly, so the
 * JSON migration and atomic-write behaviour can be tested in plain Node against an in-memory
 * filesystem. There is only one data file, so the port stays deliberately small.
 */

export class FileSystemError extends Error {
  override readonly name = 'FileSystemError';
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'IO' = 'IO',
  ) {
    super(message);
  }
}

export interface FileSystemPort {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Creates a directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Required for atomic writes: the completed temp file replaces the old one in one step. */
  rename(from: string, to: string): Promise<void>;
}

/** Joins path segments with forward slashes, which every target platform accepts. */
export function joinPath(...segments: string[]): string {
  return segments
    .filter((segment) => segment !== '')
    .map((segment, index) => (index === 0 ? segment.replace(/[/\\]+$/, '') : segment.replace(/^[/\\]+|[/\\]+$/g, '')))
    .join('/');
}

export function parentPath(path: string): string {
  const normalised = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalised.lastIndexOf('/');
  return index <= 0 ? '' : normalised.slice(0, index);
}

/** In-memory filesystem used by the store's tests. */
export class MemoryFileSystem implements FileSystemPort {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();

  /** Records final write and rename targets so tests can assert the safe ordering. */
  readonly writeLog: string[] = [];

  private normalise(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  async readTextFile(path: string): Promise<string> {
    const key = this.normalise(path);
    const contents = this.files.get(key);
    if (contents === undefined) {
      throw new FileSystemError(`No such file: ${path}`, 'NOT_FOUND');
    }
    return contents;
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    const key = this.normalise(path);
    const parent = parentPath(key);
    if (parent !== '' && !this.directories.has(parent)) {
      throw new FileSystemError(`Directory does not exist: ${parent}`, 'NOT_FOUND');
    }
    this.files.set(key, contents);
    this.writeLog.push(key);
  }

  async exists(path: string): Promise<boolean> {
    const key = this.normalise(path);
    return this.files.has(key) || this.directories.has(key);
  }

  async mkdir(path: string): Promise<void> {
    const key = this.normalise(path);
    if (key === '') return;

    const segments = key.split('/');
    let current = '';
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] ?? '';
      if (index === 0 && segment === '') {
        current = '/';
        this.directories.add(current);
        continue;
      }
      current = current === '' ? segment : current === '/' ? `/${segment}` : `${current}/${segment}`;
      this.directories.add(current);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const fromKey = this.normalise(from);
    const toKey = this.normalise(to);
    const contents = this.files.get(fromKey);
    if (contents === undefined) {
      throw new FileSystemError(`No such file: ${from}`, 'NOT_FOUND');
    }

    const parent = parentPath(toKey);
    if (parent !== '' && !this.directories.has(parent)) {
      throw new FileSystemError(`Directory does not exist: ${parent}`, 'NOT_FOUND');
    }

    this.files.set(toKey, contents);
    this.files.delete(fromKey);
    this.writeLog.push(toKey);
  }

  /** Test helper: current contents of every file. */
  snapshotFiles(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort());
  }
}
