import * as https from 'https';
import { REQUEST_TIMEOUT_MS, STATUSGATOR_SERVICE_URL } from './constants';
import { PublicServiceHealthPoint, PublicServiceStatus } from './types';
import { MAX_BUFFER_SIZE } from './utils';

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
    const rawPoints = JSON.parse(dataMatch[1]) as Array<{
      five_min?: string;
      interpolated_sum_value?: number;
      status?: number;
    }>;
    const points = rawPoints
      .map(point => {
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

export function parseStatusGatorResponse(html: string): PublicServiceStatus {
  const text = htmlToText(html);
  const phrase = text.match(/Google Antigravity is ([^.]+?)(?:\.|\s{2,}|$)/i)?.[1]?.trim();
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

export function fetchStatusGatorStatus(): Promise<PublicServiceStatus> {
  return new Promise((resolve, reject) => {
    const request = https.get(STATUSGATOR_SERVICE_URL, {
      headers: {
        'User-Agent': 'AG Usage VS Code Extension',
        'Accept': 'text/html'
      },
      timeout: REQUEST_TIMEOUT_MS
    }, response => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`StatusGator HTTP ${statusCode}`));
        return;
      }

      response.setEncoding('utf8');
      let responseData = '';
      let byteCount = 0;

      response.on('data', chunk => {
        byteCount += Buffer.byteLength(chunk);
        if (byteCount > MAX_BUFFER_SIZE) {
          request.destroy();
          reject(new Error(`StatusGator response exceeded ${MAX_BUFFER_SIZE} bytes`));
          return;
        }
        responseData += chunk;
      });

      response.on('end', () => {
        resolve(parseStatusGatorResponse(responseData));
      });

      response.on('error', reject);
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new Error('StatusGator request timed out'));
    });
    request.on('error', reject);
  });
}
