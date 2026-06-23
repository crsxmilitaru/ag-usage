export const USE_MOCK_DATA = process.env.AG_USAGE_MOCK_DATA === 'true';

export const CONFIG_NAMESPACE = 'ag-usage';
export const REFRESH_COMMAND = 'ag-usage.refresh';
export const EXTENSION_TITLE = 'AG Usage';
export const SETTINGS_COMMAND = 'ag-usage.openSettings';
export const OPEN_PANEL_COMMAND = 'ag-usage.openPanel';
export const EXPORT_HISTORY_COMMAND = 'ag-usage.exportHistory';
export const INITIAL_DELAY_MS = 1500;
export const MIN_DISPLAY_DELAY_MS = 300;
export const STATUS_BAR_PRIORITY = 100;
export const DEFAULT_REFRESH_INTERVAL = 60;
export const SERVER_STARTUP_DELAY = 10;
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60000;
export const MS_PER_HOUR = 3600000;
export const MS_PER_DAY = 86400000;
export const CACHE_TTL_MS = 300000;
export const REQUEST_TIMEOUT_MS = 2500;
export const RETRY_DELAY_MS = 150;
export const MAX_PID_32BIT_SIGNED = 0x7FFFFFFF;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;
export const FAILED_REFRESH_DELAY_MS = 5000;
export const MAX_FAILED_REFRESH_DELAY_MS = 60000;
export const MAX_STATUS_TEXT_LENGTH = 120;
export const MAX_PORT_VALIDATION_ATTEMPTS = 2;
export const HEATMAP_MAX_DAYS = 180;

export const PROCESS_IDENTIFIERS = {
  LANGUAGE_SERVER: 'language_server',
  ANTIGRAVITY: 'antigravity',
  CSRF_TOKEN: '--csrf_token'
};

export const IDE_INFO = {
  NAME: 'antigravity-ide',
  VERSION: '2.0.1'
};

export const SVG_CONFIG = {
  columnWidth: 200,
  columnPadding: 0
};

export const PROGRESS_STOPS = [0, 20, 40, 60, 80, 100] as const;
export const PROGRESS_BUCKET_BOUNDARIES = [10, 30, 50, 70, 90];

export const THEME_COLORS = {
  light: {
    text: '#1f2937',
    barBackground: '#d1d5db',
    cardFill: 'rgba(107, 114, 128, 0.1)',
    cardBorder: 'rgba(107, 114, 128, 0.2)',
    success: '#059669',
    warning: '#d97706',
    error: '#b91c1c',
    progress: ['#7f1d1d', '#b91c1c', '#a16207', '#ca8a04', '#166534', '#15803d']
  },
  dark: {
    text: '#e5e7eb',
    barBackground: '#4b5563',
    cardFill: 'rgba(107, 114, 128, 0.1)',
    cardBorder: 'rgba(107, 114, 128, 0.2)',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    progress: ['#b91c1c', '#ef4444', '#eab308', '#fde047', '#16a34a', '#4ade80']
  }
};

export const CATEGORY_NAMES = {
  GEMINI: 'Gemini',
  OTHER: 'Other'
} as const;

export const CATEGORY_ORDER = [CATEGORY_NAMES.GEMINI, CATEGORY_NAMES.OTHER];

export const DISPLAY_MODE_TO_CATEGORY: Record<string, string> = {
  gemini: CATEGORY_NAMES.GEMINI,
  other: CATEGORY_NAMES.OTHER
};

export const MODEL_KEYWORDS = {
  flash: 'flash',
  gemini: 'gemini'
};
