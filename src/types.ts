export interface QuotaGroup {
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

export type StatusBarDisplayMode = 'average' | 'all' | 'geminiPro' | 'geminiFlash' | 'claudeGpt';

export type ResetTimeDisplayMode = 'relative' | 'absolute' | 'both';

export type AbsoluteTimeFormat = '24h' | '12h';

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
