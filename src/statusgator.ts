import * as https from 'https';
import { REQUEST_TIMEOUT_MS, STATUSGATOR_SERVICE_URL } from './constants';
import { PublicServiceHealthPoint, PublicServiceStatus } from './types';
import { MAX_BUFFER_SIZE } from './utils';

const MAX_REDIRECTS = 3;

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

function parseStatusGatorChartEndsAt(html: string): number | undefined {
	const chartSection = html.match(/id="service_health_chart"[\s\S]*?<\/section>/i)?.[0] ?? html;
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
	const text = htmlToText(html);
	const phrase = text.match(/Google Antigravity is ([^.]+?)(?:\.|$)/i)?.[1]?.trim();
	const reportCount = getStatusGatorReportCount(text);
	const details = reportCount !== undefined ? `${reportCount.toLocaleString()} reports/24h` : undefined;
	const healthPoints = parseStatusGatorChartPoints(html);
	const chartEndsAt = parseStatusGatorChartEndsAt(html);
	const base = { details, checkedAt: Date.now(), url: STATUSGATOR_SERVICE_URL, chartEndsAt, healthPoints };
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
