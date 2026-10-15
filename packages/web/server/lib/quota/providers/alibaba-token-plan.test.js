import { describe, expect, it } from 'bun:test';
import { fetchAlibabaUsage, fetchConsoleApi, parseAlibabaUsage } from './alibaba-token-plan.js';

const usagePayload = { per1MonthPercentage: 1, per1MonthResetTime: 1794153600000 };

const addonPayload = {
  total: 1,
  items: [
    {
      addonTier: 'extrabundle',
      remainingCredits: 18765.3,
      totalCredits: 20000,
      remainingDays: 31,
      startTime: 1791973876000,
      endTime: 1794672000000,
      status: 'ACTIVE',
    },
    {
      addonTier: 'expired',
      remainingCredits: 0,
      totalCredits: 1000,
      endTime: 1700000000000,
      status: 'EXPIRED',
    },
  ],
};

const consoleEnvelope = (inner) => ({
  data: {
    DataV2: { ret: ['SUCCESS'], data: { code: 'SUCCESS', data: inner, success: true } },
    success: true,
  },
});

describe('alibaba token plan quota provider', () => {
  it('converts the monthly fraction into a window', () => {
    const windows = parseAlibabaUsage(usagePayload, null);
    expect(windows['Monthly quota'].usedPercent).toBe(100);
    expect(windows['Monthly quota'].resetAt).toBe(1794153600000);
  });

  it('maps active add-on packs to their own windows and skips inactive ones', () => {
    const windows = parseAlibabaUsage(usagePayload, addonPayload);
    const labels = Object.keys(windows);
    expect(labels).toHaveLength(2);
    const addon = windows['Quota add-on (extrabundle) 1'];
    expect(addon.usedPercent).toBeCloseTo(6.17, 1);
    expect(addon.resetAt).toBe(1794672000000);
    expect(addon.valueLabel).toBe('1.2k / 20.0k credits');
  });

  it('calls the console gateway with the console token and envelope', async () => {
    const requests = [];
    const windows = await fetchAlibabaUsage({ consoleToken: 'test-token' }, async (url, init) => {
      requests.push({ url, init });
      return Response.json(consoleEnvelope(requests.length === 1 ? usagePayload : addonPayload));
    });
    expect(windows['Monthly quota'].usedPercent).toBe(100);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain('/cli/api.json?');
    expect(requests[0].url).toContain('product=sfm_bailian');
    expect(requests[0].init.headers.Authorization).toBe('Bearer test-token');
    const body = new URLSearchParams(requests[0].init.body);
    expect(body.get('region')).toBe('ap-southeast-1');
    const params = JSON.parse(body.get('params'));
    expect(params.Api).toBe('zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage');
  });

  it('reports an expired console session without including the token', async () => {
    await expect(
      fetchConsoleApi({ consoleToken: 'test-token' }, 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage', {}, async () =>
        Response.json({ data: { success: false, errorCode: 'NotLogined' } }),
      ),
    ).rejects.toThrow('session expired');
  });

  it('rejects malformed successful responses', async () => {
    await expect(fetchAlibabaUsage({ consoleToken: 'test-token' }, async () => Response.json(consoleEnvelope({}))))
      .rejects.toThrow('could not be parsed');
  });
});
