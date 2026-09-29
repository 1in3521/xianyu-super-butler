import type { Card } from '../types';

type ApiConfig = NonNullable<Card['api_config']>;
type JsonObject = Record<string, unknown>;

export const MAX_DELIVERY_MINUTES = 525600;
export const INTERNAL_DELIVERY_URL = 'http://delivery-gateway:8081/api/delivery/codes';

function parseObject(value: unknown): JsonObject | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : null;
  } catch {
    return null;
  }
}

export function readAccountDeliveryCard(card: Card): { poolId: string; durationMinutes: number } | null {
  const config = card.api_config;
  if (card.type !== 'api' || !config || config.method?.toUpperCase() !== 'POST') return null;

  try {
    if (new URL(config.url).pathname !== '/api/delivery/codes') return null;
  } catch {
    return null;
  }

  const headers = parseObject(config.headers);
  const params = parseObject(config.params);
  if (!headers || !params) return null;
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || authorization.length <= 7) {
    return null;
  }
  if (
    params.shopId !== '{cookie_id}' ||
    params.orderId !== '{order_id}' ||
    params.itemId !== '{item_id}' ||
    params.deliveryIndex !== '{delivery_index}' ||
    typeof params.poolId !== 'string' ||
    !params.poolId.trim()
  ) return null;

  const durationMinutes = Number(params.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_DELIVERY_MINUTES) {
    return null;
  }
  return { poolId: params.poolId, durationMinutes };
}

export function isInternalAccountDeliveryCard(card: Card): boolean {
  return card.api_config?.url === INTERNAL_DELIVERY_URL && readAccountDeliveryCard(card) !== null;
}

export function buildAccountDeliveryConfig(template: Card, poolId: string, durationMinutes: number): ApiConfig {
  if (!readAccountDeliveryCard(template)) throw new Error('请选择已配置的账号系统提取码卡密');
  if (!poolId.trim()) throw new Error('请选择账号系统中的账号池');
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_DELIVERY_MINUTES) {
    throw new Error('有效时长需为 1 到 525600 分钟');
  }
  const config = template.api_config!;
  const params = { ...parseObject(config.params)!, poolId, durationMinutes };
  return {
    ...config,
    params: typeof config.params === 'string' ? JSON.stringify(params) : params,
  };
}

export type DurationUnit = 'minutes' | 'hours' | 'days';

export function displayDuration(minutes: number): { amount: string; unit: DurationUnit } {
  if (minutes % 1440 === 0) return { amount: String(minutes / 1440), unit: 'days' };
  if (minutes % 60 === 0) return { amount: String(minutes / 60), unit: 'hours' };
  return { amount: String(minutes), unit: 'minutes' };
}

export function parseDuration(amount: string, unit: DurationUnit): number | null {
  const number = Number(amount);
  const multiplier = unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1;
  const minutes = number * multiplier;
  return amount.trim() && Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_DELIVERY_MINUTES
    ? minutes
    : null;
}
