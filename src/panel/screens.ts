import * as crypto from 'crypto';
import { escapeHtml } from '../utils';

export const CHEVRON_UP_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 4.5l5.5 5.5-.7.7L8 5.9l-4.8 4.8-.7-.7L8 4.5z"/></svg>';
export const CHEVRON_DOWN_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 11.5L2.5 6l.7-.7L8 10.1l4.8-4.8.7.7L8 11.5z"/></svg>';
export const ARROW_RIGHT_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8.2 3.2l5.4 5.4-5.4 5.4-.7-.7 4.2-4.2H2v-1h9.7L7.5 3.9l.7-.7z"/></svg>';
export const ERROR_CIRCLE_PATH = 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.25 4.75h1.5v4.5h-1.5v-4.5zm0 5.5h1.5V12h-1.5v-1.75z';
const STAR_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.3l2.06 4.18 4.61.67-3.34 3.25.79 4.6L8 11.83 3.88 14l.79-4.6L1.33 6.15l4.61-.67L8 1.3z"/></svg>';
const GITHUB_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
const CLOSE_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>';

export function buildSupportBanner(): string {
	return `<div class="support-banner" role="region" aria-label="Support AG Usage"><div class="support-banner-header"><div class="support-banner-copy"><div class="support-banner-title">Enjoying AG Usage?</div><div class="support-banner-subtitle">Support the extension with a quick review or GitHub star.</div></div><button type="button" class="panel-section-btn support-banner-dismiss" data-action="dismiss-support" aria-label="Dismiss">${CLOSE_ICON_SVG}</button></div><div class="support-banner-actions"><button type="button" class="support-banner-action" data-action="open-review">${STAR_ICON_SVG}<span>Review</span></button><button type="button" class="support-banner-action" data-action="open-github">${GITHUB_ICON_SVG}<span>Star on GitHub</span></button></div></div>`;
}

export interface CustomTooltipOptions {
	title?: string;
	badge?: string;
	badgeClass?: string;
	content?: string;
	color?: string;
}

export function buildTooltipAttrs(options: CustomTooltipOptions): string {
	const attrs: string[] = ['data-custom-tooltip'];
	if (options.title) {
		attrs.push(`data-tooltip-title="${escapeHtml(options.title)}"`);
	}
	if (options.badge) {
		attrs.push(`data-tooltip-badge="${escapeHtml(options.badge)}"`);
	}
	if (options.badgeClass) {
		attrs.push(`data-tooltip-badge-class="${escapeHtml(options.badgeClass)}"`);
	}
	if (options.content) {
		attrs.push(`data-tooltip-content="${escapeHtml(options.content)}"`);
	}
	if (options.color) {
		attrs.push(`data-tooltip-color="${escapeHtml(options.color)}"`);
	}
	return attrs.join(' ');
}

export function buildCustomTooltipElement(): string {
	return '<div id="custom-tooltip" class="custom-tooltip" role="tooltip" aria-hidden="true"></div>';
}

export function buildInitialLoadingScreen(): string {
	return '<div class="panel-loading-screen" role="status" aria-live="polite"><div class="panel-loading-spinner" aria-hidden="true"></div><div><div class="panel-loading-title">Connecting to Antigravity</div><div class="panel-loading-subtitle">Finding the local usage API and loading quota data.</div></div></div>';
}

export function buildNotFoundScreen(): string {
	return '<div class="panel-loading-screen" role="status" aria-live="polite"><svg class="panel-notfound-icon" width="34" height="34" viewBox="0 0 16 16" fill="var(--text-muted)" aria-hidden="true"><path d="M9.1 1.5H6.9l-.3 1.4-1.2-.7-1.5 1.5.7 1.2-1.4.3v2.2l1.4.3-.7 1.2 1.5 1.5 1.2-.7.3 1.4h2.2l.3-1.4 1.2.7 1.5-1.5-.7-1.2 1.4-.3V5.2l-1.4-.3.7-1.2-1.5-1.5-1.2.7-.3-1.4zM8 9.2a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6z"/></svg><div><div class="panel-loading-title">Extension Not Found</div><div class="panel-loading-subtitle">The Antigravity extension is not started or initialized. Start it, then click the status bar item to retry.</div></div></div>';
}

function formatPanelErrorMessage(message: string): string {
	return message
		.replace(/^Connection failed:\s*/i, '')
		.replace(/\s*Click to retry\.?$/i, '')
		.trim();
}

function buildErrorIcon(size = 34): string {
	return `<svg class="panel-error-icon" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"><path fill="var(--error)" d="${ERROR_CIRCLE_PATH}"/></svg>`;
}

const ERROR_ACTIONS_HTML = '<div class="panel-error-actions"><div class="panel-error-actions-row"><button type="button" class="panel-error-action" data-action="retry">Retry</button><button type="button" class="panel-error-action" data-action="copy-error" data-copy-label="Copy error">Copy error</button></div><button type="button" class="panel-error-action" data-action="open-issues">GitHub Issues</button></div>';

export function buildErrorScreen(message: string): string {
	const detail = formatPanelErrorMessage(message) || message;
	return `<div class="panel-loading-screen panel-error-screen" role="alert">${buildErrorIcon()}<div class="panel-error-copy"><div class="panel-error-title">Connection failed</div><div class="panel-error-message">${escapeHtml(detail)}</div></div>${ERROR_ACTIONS_HTML}</div>`;
}

export function buildErrorBanner(message: string): string {
	const detail = formatPanelErrorMessage(message) || message;
	return `<div class="panel-error-banner" role="alert"><div class="panel-error-banner-header">${buildErrorIcon(18)}<div class="panel-error-banner-text"><div class="panel-error-banner-title">Connection failed</div><div class="panel-error-message">${escapeHtml(detail)}</div></div></div>${ERROR_ACTIONS_HTML}</div>`;
}

export function buildFallbackErrorHtml(message: string): string {
	const nonce = crypto.randomBytes(16).toString('base64');
	const detail = escapeHtml(formatPanelErrorMessage(message) || message);
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}.panel-error-fallback{width:min(420px,calc(100% - 32px));padding:28px 8px;text-align:center}h1{margin:0 0 10px;font-size:15px;color:#ef4444}p{margin:0 0 16px;font-size:13px;line-height:1.5;word-break:break-word;white-space:pre-wrap;user-select:text}.panel-error-actions{display:flex;flex-direction:column;align-items:center;gap:8px}.panel-error-actions-row{display:flex;gap:8px}.panel-error-actions-row .panel-error-action{width:104px}.panel-error-action{font:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:6px;border:1px solid var(--vscode-editorWidget-border,#333);background:var(--vscode-editor-background);color:var(--vscode-foreground);cursor:pointer}</style></head><body><div class="panel-error-fallback" role="alert"><h1>Couldn't display usage</h1><p>${detail}</p><div class="panel-error-actions"><div class="panel-error-actions-row"><button type="button" class="panel-error-action" id="retry">Retry</button><button type="button" class="panel-error-action" id="copy-error">Copy error</button></div><button type="button" class="panel-error-action" id="open-issues">GitHub Issues</button></div></div><script nonce="${nonce}">const v=acquireVsCodeApi(),c=document.getElementById('copy-error');let t=null;document.getElementById('retry').onclick=()=>v.postMessage({command:'retry'});c.onclick=()=>v.postMessage({command:'copyError',text:document.querySelector('p')?.textContent||''});document.getElementById('open-issues').onclick=()=>v.postMessage({command:'openIssues'});window.addEventListener('message',e=>{if(e.data?.command!=='copyErrorResult')return;clearTimeout(t);c.textContent=e.data.success?'Copied':'Copy failed';t=setTimeout(()=>{c.textContent='Copy error'},1800)});</script></body></html>`;
}
