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
  NAME: 'antigravity',
  VERSION: '1.20.5'
};

export const SVG_CONFIG = {
  columnWidth: 110,
  columnPadding: 8,
  barWidth: 76,
  barHeight: 5
};

export const COLOR_THRESHOLDS = {
  high: { value: 65 },
  medium: { value: 25 },
  low: {}
};

export const THEME_COLORS = {
  light: {
    text: '#1f2937',
    barBackground: '#d1d5db',
    cardFill: 'rgba(107, 114, 128, 0.1)',
    cardBorder: 'rgba(107, 114, 128, 0.2)',
    success: '#059669',
    warning: '#d97706',
    error: '#dc2626'
  },
  dark: {
    text: '#e5e7eb',
    barBackground: '#4b5563',
    cardFill: 'rgba(107, 114, 128, 0.1)',
    cardBorder: 'rgba(107, 114, 128, 0.2)',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444'
  }
};

export const CATEGORY_NAMES = {
  GEMINI_PRO: 'Gemini Pro',
  GEMINI_FLASH: 'Gemini Flash',
  CLAUDE_GPT: 'Claude/GPT'
} as const;

export const CATEGORY_ORDER = [CATEGORY_NAMES.GEMINI_PRO, CATEGORY_NAMES.GEMINI_FLASH, CATEGORY_NAMES.CLAUDE_GPT];

export const DISPLAY_MODE_TO_CATEGORY: Record<string, string> = {
  geminiPro: CATEGORY_NAMES.GEMINI_PRO,
  geminiFlash: CATEGORY_NAMES.GEMINI_FLASH,
  claudeGpt: CATEGORY_NAMES.CLAUDE_GPT
};

export const SHORT_NAMES: Record<string, string> = {
  'Gemini Pro': 'Pro',
  'Gemini Flash': 'Flash',
  'Claude/GPT': 'C/G'
};

export const MODEL_KEYWORDS = {
  flash: 'flash',
  gemini: 'gemini'
};
