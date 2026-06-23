export interface QuotaGroup {
  quota: number;
  resetTime: number | null;
  buckets?: QuotaBucket[];
}

export interface QuotaBucket {
  window: 'weekly' | '5h' | string;
  displayName: string;
  quota: number;
  resetTime: number | null;
}

export interface CachedConnection {
  port: number;
  csrfToken: string;
  timestamp: number;
}

export interface CreditInfo {
  creditType: string;
  creditAmount: number;
  minimumCreditAmountForUsage: number;
}

export interface UsageStatistics {
  groups: Record<string, QuotaGroup>;
  plan?: string;
  planName?: string;
  credits?: CreditInfo;
}

export interface DailyUsageEntry {
  date: string;
  category: string;
  consumed: number;
}

export type ProcessId = number;

export interface ProcessInfo {
  pid: ProcessId;
  cmd: string;
}

export type StatusBarDisplayMode = 'average' | 'all' | 'gemini' | 'other';

export type StatusBarLimitDisplayMode = 'only5h' | 'both';

export type ResetTimeDisplayMode = 'relative' | 'absolute' | 'both';

export type AbsoluteTimeFormat = '24h' | '12h';

export type ServiceStatus = 'connected' | 'degraded' | 'disconnected' | 'glitch';

export interface QuotaInfo {
  remainingFraction?: number | string;
  resetTime?: string | number;
}

export interface ModelConfig {
  label: string;
  quotaInfo?: QuotaInfo;
}

export interface ServerUserStatusResponse {
  userStatus?: {
    cascadeModelConfigData?: { clientModelConfigs: ModelConfig[] };
    planStatus?: {
      planInfo?: {
        planName?: string;
      };
    };
    userTier?: {
      name: string;
      id: string;
      availableCredits?: {
        creditType?: string;
        creditAmount?: string;
        minimumCreditAmountForUsage?: string;
      }[];
    };
    plan?: string;
    planName?: string;
  };
  plan?: string;
  planName?: string;
}

export interface ServerQuotaSummaryResponse {
  response?: {
    groups?: Array<{
      displayName?: string;
      buckets?: Array<{
        bucketId?: string;
        displayName?: string;
        remainingFraction?: number | string;
        resetTime?: string | number;
        window?: string;
      }>;
    }>;
  };
}
