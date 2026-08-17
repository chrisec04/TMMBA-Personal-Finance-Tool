/**
 * App settings.
 *
 * Only non-secret preferences live here. The Claude API key is deliberately excluded because
 * settings may be inspected during support, copied between machines, or exported for backup.
 */

const SETTINGS_KEY = 'personal-finance-tool-settings';

export interface AppSettings {
  readonly dataFolderPath?: string;
  readonly claudeModelId?: string;
  readonly demoDataLoaded: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  demoDataLoaded: false,
};

export function loadSettings(): AppSettings {
  const storage = browserStorage();
  if (storage === undefined) return DEFAULT_SETTINGS;

  const raw = storage.getItem(SETTINGS_KEY);
  if (raw === null) return DEFAULT_SETTINGS;

  try {
    return normaliseSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  const storage = browserStorage();
  if (storage === undefined) return;
  storage.setItem(SETTINGS_KEY, JSON.stringify(normaliseSettings(settings)));
}

export function setDataFolderPath(path: string | undefined): void {
  const current = loadSettings();
  if (path === undefined) {
    saveSettings({
      ...(current.claudeModelId === undefined ? {} : { claudeModelId: current.claudeModelId }),
      demoDataLoaded: current.demoDataLoaded,
    });
    return;
  }
  saveSettings({ ...current, dataFolderPath: path });
}

export function setClaudeModelId(modelId: string | undefined): void {
  const current = loadSettings();
  if (modelId === undefined) {
    saveSettings({
      ...(current.dataFolderPath === undefined ? {} : { dataFolderPath: current.dataFolderPath }),
      demoDataLoaded: current.demoDataLoaded,
    });
    return;
  }
  saveSettings({ ...current, claudeModelId: modelId });
}

export function setDemoDataLoaded(loaded: boolean): void {
  saveSettings({ ...loadSettings(), demoDataLoaded: loaded });
}

function normaliseSettings(value: unknown): AppSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_SETTINGS;
  }

  const record = value as Record<string, unknown>;
  const dataFolderPath = typeof record.dataFolderPath === 'string' ? record.dataFolderPath : undefined;
  const claudeModelId = typeof record.claudeModelId === 'string' ? record.claudeModelId : undefined;
  const demoDataLoaded =
    typeof record.demoDataLoaded === 'boolean' ? record.demoDataLoaded : DEFAULT_SETTINGS.demoDataLoaded;

  return {
    ...(dataFolderPath === undefined ? {} : { dataFolderPath }),
    ...(claudeModelId === undefined ? {} : { claudeModelId }),
    demoDataLoaded,
  };
}

function browserStorage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}
