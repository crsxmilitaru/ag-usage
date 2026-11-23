export const USE_MOCK_DATA = process.env.AG_USAGE_MOCK_DATA === 'true';

export const CONFIG_NAMESPACE = 'ag-usage';
export const EXTENSION_TITLE = 'AG Usage';
export const GOOGLE_ANTIGRAVITY_EXTENSION_ID = 'google.google-antigravity';

export const REFRESH_COMMAND = 'ag-usage.refresh';
export const SETTINGS_COMMAND = 'ag-usage.openSettings';
export const OPEN_PANEL_COMMAND = 'ag-usage.openPanel';
export const OPEN_MODELS_SETTINGS_COMMAND = 'ag-usage.openModelsSettings';
export const EXPORT_HISTORY_COMMAND = 'ag-usage.exportHistory';
export const OPEN_PANEL_SETTINGS_COMMAND = 'ag-usage.openPanelSettings';
export const CLOSE_PANEL_SETTINGS_COMMAND = 'ag-usage.closePanelSettings';
export const PANEL_SETTINGS_OPEN_CONTEXT = 'ag-usage.panelSettingsOpen';

export const GLOBAL_STATE_KEYS = {
	QUOTA_HISTORY: 'quotaHistory',
	DAILY_USAGE: 'quotaDailyUsage',
	SUPPORT_BANNER: 'supportBanner'
} as const;

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60000;
export const MS_PER_HOUR = 3600000;
export const MS_PER_DAY = 86400000;

export const STATUS_BAR_PRIORITY = 100;
export const DEFAULT_LIVE_SYNC = true;
export const DEFAULT_REFRESH_INTERVAL = 60;
export const MIN_REFRESH_INTERVAL_SECONDS = 10;
export const MAX_REFRESH_INTERVAL_SECONDS = 3600;
export const DEFAULT_MAX_HISTORY_ITEMS = 50;
export const MIN_MAX_HISTORY_ITEMS = 1;
export const MAX_MAX_HISTORY_ITEMS = 200;

export const INITIAL_DELAY_MS = 1500;
export const MIN_DISPLAY_DELAY_MS = 300;
export const SERVER_STARTUP_TOLERANCE_MINUTES = 10;
export const CACHE_TTL_MS = 300000;
export const REQUEST_TIMEOUT_MS = 5000;
export const RETRY_DELAY_MS = 150;
export const HISTORY_MERGE_WINDOW_MS = 5 * MS_PER_MINUTE;
export const CONVERSATION_WATCH_DEBOUNCE_MS = 2000;
export const CONVERSATION_WATCH_MAX_WAIT_MS = 15000;
export const FOCUS_REFRESH_COOLDOWN_MS = 5000;
export const RESET_TIMER_BUFFER_MS = 3000;
export const RESET_TIMER_RETRY_DELAY_MS = 15000;
export const MAX_RESET_TIMER_RETRIES = 3;
export const RESET_TIMER_MAX_DELAY_MS = MS_PER_DAY;
export const DISPLAY_TICK_INTERVAL_MS = MS_PER_MINUTE;
export const FAILED_REFRESH_DELAY_MS = 5000;
export const MAX_FAILED_REFRESH_DELAY_MS = 60000;
export const PUBLIC_STATUS_REFRESH_INTERVAL_MS = 5 * MS_PER_MINUTE;
export const MODEL_USAGE_REFRESH_INTERVAL_MS = 5 * MS_PER_MINUTE;

export const MAX_PID_32BIT_SIGNED = 0x7FFFFFFF;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;
export const MAX_PORT_VALIDATION_ATTEMPTS = 2;
export const HEATMAP_MAX_DAYS = 180;
export const MODEL_USAGE_COLLAPSED_ROWS = 3;
export const LOW_QUOTA_REARM_MARGIN_PERCENT = 10;
export const SUPPORT_BANNER_MIN_PANEL_OPENS = 3;

export const STATUSGATOR_SERVICE_URL = 'https://statusgator.com/services/google-antigravity';
export const GITHUB_REPO_URL = 'https://github.com/crsxmilitaru/ag-usage';
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
export const VSCODE_MARKETPLACE_REVIEW_URL = 'https://marketplace.visualstudio.com/items?itemName=crsx.ag-usage&ssr=false#review-details';
export const OPENVSX_REVIEW_URL = 'https://open-vsx.org/extension/crsx/ag-usage/reviews';
export const ANTIGRAVITY_PLANS_URL = 'https://antigravity.google/docs/plans';

export const MODEL_USAGE_CONVERSATION_DIRS = [
	'antigravity-ide',
	'antigravity-cli',
	'antigravity'
] as const;

export const PROCESS_IDENTIFIERS = {
	LANGUAGE_SERVER: 'language_server',
	ANTIGRAVITY: 'antigravity',
	CSRF_TOKEN: '--csrf_token',
	HUB_PORT: '--hub-port',
	HUB_PORT_UNDERSCORE: '--hub_port',
	GEMINI_DIR: '.gemini'
} as const;

export const IDE_INFO = {
	NAME: 'antigravity-ide',
	VERSION: '2.1.1'
} as const;

export const SVG_CONFIG = {
	columnWidth: 200,
	columnPadding: 0
} as const;

export const PROGRESS_STOPS = [0, 20, 40, 60, 80, 100] as const;
export const PROGRESS_BUCKET_BOUNDARIES = [10, 30, 50, 70, 90] as const;

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

export const MODELS_COLORS = {
	light: {
		gemini: '#0d6e96',
		other: '#0d9488'
	},
	dark: {
		gemini: '#1d8aad',
		other: '#1d998a'
	}
} as const;

export const CATEGORY_NAMES = {
	GEMINI: 'Gemini',
	OTHER: 'Other'
} as const;

export const CATEGORY_ORDER = [CATEGORY_NAMES.GEMINI, CATEGORY_NAMES.OTHER] as const;

export const STATUS_BAR_DISPLAY_ITEMS = ['gemini', 'other', 'average', 'total'] as const;
export const DEFAULT_STATUS_BAR_DISPLAY = ['gemini', 'other'] as const;

export const DISPLAY_MODE_TO_CATEGORY: Record<string, string> = {
	gemini: CATEGORY_NAMES.GEMINI,
	other: CATEGORY_NAMES.OTHER,
	average: 'Average',
	total: 'Total'
};

export const MODEL_KEYWORDS = {
	flash: 'flash',
	gemini: 'gemini'
} as const;

export const BUCKET_OPACITY = {
	defaultBg: 0.04,
	weeklyBg: 0.015,
	defaultBorder: 1.0,
	weeklyBorder: 0.4
} as const;

export const PANEL_SECTION_IDS = ['plan', 'health', 'quotas', 'resets', 'models', 'activity'] as const;
export type PanelSectionId = typeof PANEL_SECTION_IDS[number];
export const PANEL_SECTION_LABELS: Record<PanelSectionId, string> = {
	plan: 'Plan and credits',
	health: 'Service health',
	quotas: 'Quota cards',
	resets: 'Reset timeline',
	models: 'Most used models',
	activity: 'Usage activity'
};
