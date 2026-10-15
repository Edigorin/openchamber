/**
 * Alibaba Cloud Model Studio (Token Plan) quota fetch
 *
 * APIs (console gateway, `zeldaHttp` "apikeyMgr" service):
 *
 * - `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`:
 *   `{"per1MonthPercentage": 1, "per1MonthResetTime": 1794153600000}`
 *   `per1MonthPercentage` is a used fraction (0..1), the reset is epoch ms.
 * - `…/addon/list`: quota add-ons ("加量包" / boost packs), one window each:
 *   `{"items":[{"addonTier":"extrabundle","remainingCredits":…,"totalCredits":…,
 *   "startTime":…,"endTime":…,"status":"ACTIVE"}]}`
 * - `…/addon/summary`: aggregate across active packs.
 *
 * The plan API key cannot read these endpoints (the inference gateway 404s
 * them); the console gateway authenticates with a console access token, the
 * credential this provider stores. Add-on packs matter in practice: a plan at
 * 100% monthly usage keeps working from its packs until they run out.
 */
import { readManagedCredential } from '../credentials/providers.js';
import { buildResult, toNumber, toUsageWindow } from '../utils/index.js';

export const providerId = 'alibaba-token-plan';
export const providerName = 'Alibaba Cloud Model Studio (Token Plan)';

// Mirrors the Bailian CLI's console gateway table (region × site).
const GATEWAYS = {
  'cn-beijing': {
    domestic: { host: 'bailian-cs.console.aliyun.com', action: 'BroadScopeAspnGateway' },
    international: { host: 'bailian-cs.console.alibabacloud.com', action: 'BroadScopeAspnGateway' },
  },
  'ap-southeast-1': {
    domestic: { host: 'modelstudio-cs.console.aliyun.com', action: 'IntlBroadScopeAspnGateway' },
    international: { host: 'bailian-singapore-cs.alibabacloud.com', action: 'IntlBroadScopeAspnGateway' },
  },
};

const DEFAULT_REGION = 'ap-southeast-1';
const DEFAULT_SITE = 'international';
const USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';
const ADDON_LIST_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/list';

const consoleParams = (api, data) =>
  JSON.stringify({
    Api: api,
    V: '1.0',
    Data: {
      ...data,
      cornerstoneParam: {
        protocol: 'V2',
        console: 'ONE_CONSOLE',
        productCode: 'p_efm',
        switchUserType: 3,
        consoleSite: 'BAILIAN_ALIYUN',
      },
    },
  });

/** One console gateway call; returns the inner payload (…DataV2.data.data) or null. */
export const fetchConsoleApi = async (credential, api, data = {}, fetchImpl = fetch) => {
  const region = credential.region ?? DEFAULT_REGION;
  const site = credential.site ?? DEFAULT_SITE;
  const gateway = GATEWAYS[region]?.[site] ?? GATEWAYS[DEFAULT_REGION][DEFAULT_SITE];
  const url = `https://${gateway.host}/cli/api.json?action=${gateway.action}&product=sfm_bailian&api=${encodeURIComponent(api)}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${credential.consoleToken}`,
    },
    body: new URLSearchParams({ params: consoleParams(api, data), region }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Alibaba console token rejected');
  if (!response.ok) throw new Error(`Alibaba console gateway returned HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  const envelope = body?.data;
  if (envelope?.success === false) {
    const code = String(envelope.errorCode ?? '');
    if (code.includes('NotLogined')) throw new Error('Alibaba console session expired');
    throw new Error(`Alibaba console gateway error: ${code || 'unknown'}`);
  }
  return envelope?.DataV2?.data?.data ?? null;
};

const creditsLabel = (used, total) => {
  const fmt = (value) =>
    value >= 1_000_000_000
      ? `${(value / 1_000_000_000).toFixed(1)}B`
      : value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}M`
        : value >= 1_000
          ? `${(value / 1_000).toFixed(1)}k`
          : String(Math.round(value));
  return `${fmt(used)} / ${fmt(total)} credits`;
};

/**
 * Combines the monthly quota and any active add-on packs into named windows.
 * `usage` is the v2/usage payload; `addons` is the addon/list payload.
 */
export const parseAlibabaUsage = (usage, addons) => {
  const windows = {};
  const usedFraction = toNumber(usage?.per1MonthPercentage);
  const resetAt = toNumber(usage?.per1MonthResetTime);
  if (usedFraction !== null) {
    windows['Monthly quota'] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, usedFraction <= 1 ? usedFraction * 100 : usedFraction)),
      windowSeconds: null,
      resetAt: resetAt ?? null,
    });
  }
  const items = Array.isArray(addons?.items) ? addons.items : [];
  items
    .filter((item) => item?.status === 'ACTIVE' || item?.status === undefined)
    .forEach((item, index) => {
      const total = toNumber(item?.totalCredits);
      const remaining = toNumber(item?.remainingCredits);
      if (total === null || total <= 0 || remaining === null) return;
      const used = Math.max(0, total - remaining);
      const label = `Quota add-on${item?.addonTier ? ` (${item.addonTier})` : ''} ${index + 1}`;
      windows[label] = toUsageWindow({
        usedPercent: Math.min(100, Math.max(0, (used / total) * 100)),
        windowSeconds: null,
        resetAt: toNumber(item?.endTime) ?? null,
        valueLabel: creditsLabel(used, total),
      });
    });
  return windows;
};

export const fetchAlibabaUsage = async (credential, fetchImpl = fetch) => {
  const usage = await fetchConsoleApi(credential, USAGE_API, {}, fetchImpl);
  if (!usage || toNumber(usage.per1MonthPercentage) === null) {
    throw new Error('Alibaba usage data could not be parsed');
  }
  let addons = null;
  try {
    addons = await fetchConsoleApi(credential, ADDON_LIST_API, {}, fetchImpl);
  } catch {
    // add-on packs are optional context; the monthly quota stands alone
  }
  return parseAlibabaUsage(usage, addons);
};

export const isConfigured = () => Boolean(readManagedCredential(providerId));

export const fetchQuota = async () => {
  const credential = readManagedCredential(providerId);
  if (!credential) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  }
  try {
    const windows = await fetchAlibabaUsage(credential);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
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
