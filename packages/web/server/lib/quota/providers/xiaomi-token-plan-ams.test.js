import { describe, expect, it } from 'bun:test';
import { fetchMiMoUsage, parseMiMoUsage } from './xiaomi-token-plan-ams.js';

const usagePayload = {
  data: {
    monthUsage: {
      percent: 0.51,
      items: [{ name: 'month_total_token', used: 2100219044, limit: 4100000000, percent: 0.51 }],
    },
    usage: {
      percent: 0.51,
      items: [
        { name: 'plan_total_token', used: 2100219044, limit: 4100000000, percent: 0.51 },
        { name: 'compensation_total_token', used: 0, limit: 0, percent: 0 },
      ],
    },
  },
};

const detailPayload = {
  data: {
    planCode: 'lite',
    planName: 'Lite',
    currentPeriodEnd: '2026-11-14 23:59:59',
    expired: false,
    enableAutoRenew: true,
  },
};

describe('xiaomi mimo token plan quota provider', () => {
  it('maps credit items to windows with a UTC period end', () => {
    const windows = parseMiMoUsage(usagePayload, detailPayload.data.currentPeriodEnd);
    expect(Object.keys(windows)).toEqual(['Monthly credits']);
    expect(windows['Monthly credits'].usedPercent).toBeCloseTo(51.22, 1);
    expect(windows['Monthly credits'].resetAt).toBe(Date.parse('2026-11-14T23:59:59Z'));
    expect(windows['Monthly credits'].valueLabel).toBe('2.1B / 4.1B credits');
  });

  it('falls back to the reported fraction when limit is missing', () => {
    const windows = parseMiMoUsage(
      { data: { monthUsage: { percent: 0.25, items: [{ name: 'month_total_token', used: 0, limit: 0, percent: 0.25 }] } } },
      null,
    );
    expect(windows['Monthly credits'].usedPercent).toBeCloseTo(25, 5);
    expect(windows['Monthly credits'].resetAt).toBeNull();
  });

  it('sends the session cookie and reads both endpoints', async () => {
    const requests = [];
    const result = await fetchMiMoUsage({ cookie: 'api-platform_serviceToken=abc; userId=1' }, async (url, init) => {
      requests.push({ url, init });
      return Response.json(url.endsWith('/detail') ? detailPayload : usagePayload);
    });
    expect(result.planLabel).toBe('Lite');
    expect(requests.map((request) => request.url)).toEqual([
      'https://platform.xiaomimimo.com/api/v1/tokenPlan/detail',
      'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage',
    ]);
    expect(requests[0].init.headers.Cookie).toBe('api-platform_serviceToken=abc; userId=1');
  });

  it('reports an expired session without including the cookie', async () => {
    await expect(fetchMiMoUsage({ cookie: 'api-platform_serviceToken=abc' }, async () => new Response('', { status: 401 })))
      .rejects.toThrow('session expired');
  });

  it('rejects malformed successful responses', async () => {
    await expect(fetchMiMoUsage({ cookie: 'api-platform_serviceToken=abc' }, async () => Response.json({ data: {} })))
      .rejects.toThrow('could not be parsed');
  });
});
