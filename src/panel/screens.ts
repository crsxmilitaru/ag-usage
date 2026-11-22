import * as crypto from 'crypto';
import { escapeHtml } from '../utils';

export const CHEVRON_UP_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 4.5l5.5 5.5-.7.7L8 5.9l-4.8 4.8-.7-.7L8 4.5z"/></svg>';
export const CHEVRON_DOWN_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 11.5L2.5 6l.7-.7L8 10.1l4.8-4.8.7.7L8 11.5z"/></svg>';
export const ARROW_RIGHT_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8.2 3.2l5.4 5.4-5.4 5.4-.7-.7 4.2-4.2H2v-1h9.7L7.5 3.9l.7-.7z"/></svg>';
export const ERROR_CIRCLE_PATH = 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.25 4.75h1.5v4.5h-1.5v-4.5zm0 5.5h1.5V12h-1.5v-1.75z';

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
