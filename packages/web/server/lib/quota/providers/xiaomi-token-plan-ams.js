/**
 * Xiaomi MiMo Token Plan quota fetch
 *
 * APIs (the same calls the plan page at platform.xiaomimimo.com makes):
 *
 * - `GET /api/v1/tokenPlan/detail`:
 *   `{"data":{"planCode":"lite","planName":"Lite","currentPeriodEnd":"2026-11-14 23:59:59","expired":false,…}}`
 *   (`currentPeriodEnd` is UTC, `yyyy-MM-dd HH:mm:ss`.)
 * - `GET /api/v1/tokenPlan/usage`:
 *   `{"data":{"monthUsage":{"percent":0.51,"items":[{"name":"month_total_token",
 *   "used":…,"limit":…,"percent":0.51}]}}}`
 *   `percent` is a used fraction (0..1); used/limit are Credits.
 * - `GET /api/v1/balance` — pay-as-you-go balance only; subscription accounts
 *   have none, so it is optional context.
 *
 * Auth: these endpoints reject the plan API key (401 with a Xiaomi account
 * login redirect) and the inference gateway exposes no usage routes. The only
 * working credential is the platform browser session: a `Cookie` header with
 * `api-platform_serviceToken` and `userId`.
 */
import { readManagedCredential } from '../credentials/providers.js';
import { buildResult, toNumber, toUsageWindow } from '../utils/index.js';

export const providerId = 'xiaomi-token-plan-ams';
export const providerName = 'Xiaomi MiMo Token Plan';

const BASE_URL = 'https://platform.xiaomimimo.com/api/v1';

const ITEM_LABELS = {
  month_total_token: 'Monthly credits',
  plan_total_token: 'Plan credits',
  compensation_total_token: 'Compensation credits',
};

// `currentPeriodEnd` is UTC without a zone marker.
const parseUtc = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(`${value.trim().replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : null;
};

const percentOf = (used, limit, reported) => {
  const usedValue = toNumber(used) ?? 0;
  const limitValue = toNumber(limit) ?? 0;
  if (limitValue > 0) return Math.min(100, Math.max(0, (usedValue / limitValue) * 100));
  const fraction = toNumber(reported);
  if (fraction === null) return null;
  return Math.min(100, Math.max(0, fraction <= 1 ? fraction * 100 : fraction));
};

const creditsLabel = (used, limit) => {
  const fmt = (value) =>
    value >= 1_000_000_000
      ? `${(value / 1_000_000_000).toFixed(1)}B`
      : value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}M`
        : value >= 1_000
          ? `${(value / 1_000).toFixed(1)}k`
          : String(Math.round(value));
  return `${fmt(used)} / ${fmt(limit)} credits`;
};

const mimoFetch = async (path, cookie, fetchImpl) => {
  const response = await fetchImpl(`${BASE_URL}${path}`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
      'User-Agent': 'OpenChamber quota provider',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Xiaomi MiMo session expired');
  if (response.status >= 300 && response.status < 400) throw new Error('Xiaomi MiMo login required');
  if (!response.ok) throw new Error(`Xiaomi MiMo API returned HTTP ${response.status}`);
  return response.json().catch(() => null);
};

/**
 * Builds named windows from the tokenPlan/usage payload, keyed by item name.
 * `periodEnd` is the raw UTC string from tokenPlan/detail.
 */
export const parseMiMoUsage = (usage, periodEnd) => {
  const resetAt = parseUtc(periodEnd);
  const data = usage?.data ?? {};
  const monthUsage = data.monthUsage ?? data;
  const items = Array.isArray(monthUsage.items) ? monthUsage.items : [];
  const windows = {};
  for (const item of items) {
    const limit = toNumber(item?.limit) ?? 0;
    const used = toNumber(item?.used) ?? 0;
    const usedPercent = percentOf(item?.used, item?.limit, item?.percent ?? monthUsage.percent);
    if (usedPercent === null) continue;
    const label = ITEM_LABELS[String(item?.name ?? '')] ?? (item?.name ?? 'Credits');
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel: limit > 0 ? creditsLabel(used, limit) : undefined,
    });
  }
  return windows;
};

export const fetchMiMoUsage = async (credential, fetchImpl = fetch) => {
  const [detail, usage] = await Promise.all([
    mimoFetch('/tokenPlan/detail', credential.cookie, fetchImpl),
    mimoFetch('/tokenPlan/usage', credential.cookie, fetchImpl),
  ]);
  const detailData = detail?.data ?? {};
  const windows = parseMiMoUsage(usage, detailData.currentPeriodEnd);
  if (Object.keys(windows).length === 0) throw new Error('Xiaomi MiMo usage data could not be parsed');
  return { windows, planLabel: detailData.planName ?? detailData.planCode ?? undefined };
};

export const isConfigured = () => Boolean(readManagedCredential(providerId));

export const fetchQuota = async () => {
  const credential = readManagedCredential(providerId);
  if (!credential) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  }
  try {
    const { windows, planLabel } = await fetchMiMoUsage(credential);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows }, planLabel });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};
