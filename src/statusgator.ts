import * as https from 'https';
import { MS_PER_MINUTE, REQUEST_TIMEOUT_MS, STATUSGATOR_SERVICE_URL } from './constants';
import { PublicServiceHealthPoint, PublicServiceStatus } from './types';
import { MAX_BUFFER_SIZE } from './utils';

const MAX_REDIRECTS = 3;
const HEALTH_GRAPH_INTERVAL_MS = 15 * MS_PER_MINUTE;

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&nbsp;/g, ' ');
}

function htmlToText(html: string): string {
	return decodeHtmlEntities(html
		.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim());
}

function parseInteger(value: string | undefined): number | undefined {
	if (!value) { return undefined; }
	const parsed = parseInt(value.replace(/,/g, ''), 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStatusGatorChartPoints(html: string): PublicServiceHealthPoint[] | undefined {
	const dataMatch = html.match(/var\s+data\s*=\s*(\[[\s\S]*?\]);/);
	if (!dataMatch?.[1]) { return undefined; }

	try {
		const rawPoints = JSON.parse(dataMatch[1]) as unknown;
		if (!Array.isArray(rawPoints)) { return undefined; }
		const points = rawPoints
			.map((item: unknown) => {
				if (!item || typeof item !== 'object') { return null; }
				const point = item as {
					five_min?: string;
					interpolated_sum_value?: number;
					status?: number;
				};
				const timestamp = point.five_min ? new Date(point.five_min).getTime() : NaN;
				const value = typeof point.interpolated_sum_value === 'number' ? point.interpolated_sum_value : NaN;
				const status = point.status === 1 || point.status === 2 ? point.status : 0;
				return Number.isFinite(timestamp) && Number.isFinite(value)
					? { timestamp, value, status: status as 0 | 1 | 2 }
					: null;
			})
			.filter((point): point is PublicServiceHealthPoint => point !== null)
			.sort((a, b) => a.timestamp - b.timestamp);
		return points.length > 0 ? points : undefined;
	} catch {
		return undefined;
	}
}

function extractFirstJsonObject(source: string): string | undefined {
	const openBraceIndex = source.indexOf('{');
	if (openBraceIndex === -1) { return undefined; }

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = openBraceIndex; i < source.length; i++) {
		const ch = source[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return source.slice(openBraceIndex, i + 1);
			}
		}
	}
	return undefined;
}

function resolveHealthGraphBarStatus(
	rawStatus: unknown,
	inOutageRange: boolean,
	hasMajorSeverity: boolean
): 0 | 1 | 2 {
	const normalized = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : rawStatus;
	if (normalized === 'down' || normalized === 2) {
		return 2;
	}
	if (normalized === 'outage' || normalized === 'warn' || normalized === 'warning' || normalized === 1) {
		return hasMajorSeverity ? 2 : 1;
	}
	if (normalized === 'up' || normalized === 0) {
		return 0;
	}
	return inOutageRange ? (hasMajorSeverity ? 2 : 1) : 0;
}

function parseHealthGraphPoints(
	html: string,
	checkedAt: number
): { points: PublicServiceHealthPoint[]; chartEndsAt: number } | undefined {
	const match = html.match(/x-data=(?:"HealthGraph\(([^"]*)\)"|'HealthGraph\(([^']*)\)')/i);
	const rawArgs = match?.[1] ?? match?.[2];
	if (!rawArgs) { return undefined; }

	const jsonObject = extractFirstJsonObject(decodeHtmlEntities(rawArgs));
	if (!jsonObject) { return undefined; }

	try {
		const payload = JSON.parse(jsonObject) as {
			bars?: unknown;
			outages?: unknown;
			events?: unknown;
			timeline?: unknown;
		};
		if (!Array.isArray(payload.bars) || payload.bars.length === 0) { return undefined; }

		const barCount = payload.bars.length;
		const timelineItems = Array.isArray(payload.timeline) ? payload.timeline : [];
		const hasTimelineMajor = timelineItems.some(item => {
			if (!item || typeof item !== 'object') { return false; }
			const severity = (item as { severity?: unknown }).severity;
			return typeof severity === 'string' && /^(?:down|major)$/i.test(severity);
		});

		const validEvents: Array<{ index: number; isAlert: boolean; timestamp: number }> = [];
		if (Array.isArray(payload.events)) {
			for (const rawEvent of payload.events) {
				if (!rawEvent || typeof rawEvent !== 'object') { continue; }
				const event = rawEvent as { index?: unknown; type?: unknown; time?: unknown };
				const index = typeof event.index === 'number' && Number.isInteger(event.index)
					? event.index
					: -1;
				const isAlert = typeof event.type === 'string' && event.type.toLowerCase() === 'alert';
				const timestamp = typeof event.time === 'string' ? new Date(event.time).getTime() : NaN;
				if (index >= 0 && index < barCount) {
					validEvents.push({ index, isAlert, timestamp });
				}
			}
		}

		const hasAnyAlertEvent = validEvents.some(event => event.isAlert);

		const outageRanges: Array<{ startIndex: number; endIndex: number; isMajor: boolean }> = [];
		if (Array.isArray(payload.outages)) {
			for (const rawOutage of payload.outages) {
				if (!rawOutage || typeof rawOutage !== 'object') { continue; }
				const outage = rawOutage as { startIndex?: unknown; endIndex?: unknown };
				if (typeof outage.startIndex !== 'number' || typeof outage.endIndex !== 'number') { continue; }
				if (!Number.isInteger(outage.startIndex) || !Number.isInteger(outage.endIndex)) { continue; }
				const startIndex = Math.max(0, outage.startIndex);
				const endIndex = Math.min(barCount - 1, outage.endIndex);
				if (startIndex > endIndex) { continue; }
				const isMajor = hasTimelineMajor || validEvents.some(
					event => event.isAlert && event.index >= startIndex && event.index <= endIndex
				);
				outageRanges.push({ startIndex, endIndex, isMajor });
			}
		}

		let latestEvent: { index: number; timestamp: number } | undefined;
		for (const event of validEvents) {
			if (!Number.isFinite(event.timestamp)) { continue; }
			if (!latestEvent || event.timestamp > latestEvent.timestamp ||
				(event.timestamp === latestEvent.timestamp && event.index > latestEvent.index)) {
				latestEvent = { index: event.index, timestamp: event.timestamp };
			}
		}

		const chartEndsAt = latestEvent
			? Math.floor(latestEvent.timestamp / HEALTH_GRAPH_INTERVAL_MS) * HEALTH_GRAPH_INTERVAL_MS +
				(barCount - 1 - latestEvent.index) * HEALTH_GRAPH_INTERVAL_MS
			: Math.floor(checkedAt / HEALTH_GRAPH_INTERVAL_MS) * HEALTH_GRAPH_INTERVAL_MS;

		const points: PublicServiceHealthPoint[] = [];
		for (let i = 0; i < barCount; i++) {
			const rawBar = payload.bars[i];
			if (!rawBar || typeof rawBar !== 'object') { continue; }
			const bar = rawBar as { v?: unknown; status?: unknown };
			if (typeof bar.v !== 'number' || !Number.isFinite(bar.v)) { continue; }

			const matchingRanges = outageRanges.filter(range => i >= range.startIndex && i <= range.endIndex);
			const inOutageRange = matchingRanges.length > 0;
			const isMajor = inOutageRange
				? matchingRanges.some(range => range.isMajor)
				: (hasTimelineMajor || hasAnyAlertEvent);

			points.push({
				timestamp: chartEndsAt - (barCount - 1 - i) * HEALTH_GRAPH_INTERVAL_MS,
				value: bar.v,
				status: resolveHealthGraphBarStatus(bar.status, inOutageRange, isMajor)
			});
		}

		return points.length > 0 ? { points, chartEndsAt } : undefined;
	} catch {
		return undefined;
	}
}

function parseStatusGatorChartEndsAt(html: string): number | undefined {
	const chartSection = html.match(/id="service_health_chart"[\s\S]*?<\/section>/i)?.[0];
	if (!chartSection) { return undefined; }
	const datetime = chartSection.match(/<time[^>]+datetime="([^"]+)"/i)?.[1];
	if (!datetime) { return undefined; }
	const timestamp = new Date(datetime).getTime();
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function getStatusGatorReportCount(text: string): number | undefined {
	return parseInteger(
		text.match(/There have been ([\d,]+) user-submitted reports of outages in the past 24 hours/i)?.[1] ??
		text.match(/([\d,]+) outage reports in the last 24 hours/i)?.[1]
	);
}

function parseStatusGatorResponse(html: string): PublicServiceStatus {
	const checkedAt = Date.now();
	const bodyHtml = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
	const text = htmlToText(bodyHtml);
	const rawPhrase = bodyHtml.match(/Google Antigravity is ([^<.!?]+)/i)?.[1];
	const phrase = rawPhrase ? decodeHtmlEntities(rawPhrase).replace(/\s+/g, ' ').trim() : undefined;
	const reportCount = getStatusGatorReportCount(text);
	const details = reportCount !== undefined ? `${reportCount.toLocaleString()} reports/24h` : undefined;
	const legacyPoints = parseStatusGatorChartPoints(html);
	const healthGraph = legacyPoints ? undefined : parseHealthGraphPoints(html, checkedAt);
	const healthPoints = legacyPoints ?? healthGraph?.points;
	const chartEndsAt = parseStatusGatorChartEndsAt(html) ?? healthGraph?.chartEndsAt;
	const base = { details, checkedAt, url: STATUSGATOR_SERVICE_URL, chartEndsAt, healthPoints };
	const latestPoint = healthPoints?.[healthPoints.length - 1];

	if (latestPoint?.status === 2) {
		return { ...base, state: 'down', label: 'Likely Outage' };
	}

	if (latestPoint?.status === 1) {
		return { ...base, state: 'warn', label: 'Possible Outage' };
	}

	if (phrase && /down|outage|problem|degraded|disruption|maintenance/i.test(phrase)) {
		return { ...base, state: 'down', label: 'Public Issue' };
	}

	if (reportCount !== undefined && reportCount > 0) {
		return { ...base, state: 'warn', label: 'Public Reports' };
	}

	if (phrase && /up|operational/i.test(phrase)) {
		return { ...base, state: 'up', label: 'Public Up' };
	}

	return { ...base, state: 'unknown', label: 'Public Unknown' };
}

type HttpsTextResponse = { body: string } | { redirectLocation: string };

function fetchHttpsOnce(url: string): Promise<HttpsTextResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) { return; }
			settled = true;
			fn();
		};

		const request = https.get(url, {
			headers: {
				'User-Agent': 'AG Usage VS Code Extension',
				'Accept': 'text/html'
			},
			timeout: REQUEST_TIMEOUT_MS
		}, response => {
			const statusCode = response.statusCode ?? 0;

			if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
				response.resume();
				const location = response.headers.location;
				settle(() => resolve({ redirectLocation: location }));
				return;
			}

			if (statusCode < 200 || statusCode >= 300) {
				response.resume();
				settle(() => reject(new Error(`StatusGator HTTP ${statusCode}`)));
				return;
			}

			response.setEncoding('utf8');
			let responseData = '';
			let byteCount = 0;

			response.on('data', chunk => {
				if (settled) { return; }
				byteCount += Buffer.byteLength(chunk);
				if (byteCount > MAX_BUFFER_SIZE) {
					request.destroy();
					settle(() => reject(new Error(`StatusGator response exceeded ${MAX_BUFFER_SIZE} bytes`)));
					return;
				}
				responseData += chunk;
			});

			response.on('end', () => settle(() => resolve({ body: responseData })));
			response.on('error', err => settle(() => reject(err)));
		});

		request.on('timeout', () => {
			request.destroy();
			settle(() => reject(new Error('StatusGator request timed out')));
		});
		request.on('error', err => settle(() => reject(err)));
	});
}

async function fetchHttpsText(initialUrl: string, maxRedirects: number): Promise<string> {
	let currentUrl = initialUrl;

	for (let redirects = 0; ; redirects++) {
		const result = await fetchHttpsOnce(currentUrl);
		if ('body' in result) {
			return result.body;
		}
		if (redirects >= maxRedirects) {
			throw new Error('StatusGator returned too many redirects');
		}
		let nextUrl: URL;
		try {
			nextUrl = new URL(result.redirectLocation, currentUrl);
		} catch {
			throw new Error(`Invalid StatusGator redirect URL: ${result.redirectLocation}`);
		}
		if (nextUrl.protocol !== 'https:') {
			throw new Error('Refusing non-HTTPS StatusGator redirect');
		}
		currentUrl = nextUrl.toString();
	}
}

export async function fetchStatusGatorStatus(): Promise<PublicServiceStatus> {
	const html = await fetchHttpsText(STATUSGATOR_SERVICE_URL, MAX_REDIRECTS);
	return parseStatusGatorResponse(html);
}
