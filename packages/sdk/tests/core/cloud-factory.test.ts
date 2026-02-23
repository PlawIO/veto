import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Veto } from '../../src/core/veto.js';

const fetchMock = vi.fn();

describe('Veto.fromCloud', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ policies: [], outputRules: [] }),
      text: async () => '',
    });
    global.fetch = fetchMock as typeof global.fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads policies from cloud during initialization', async () => {
    const veto = await Veto.fromCloud({
      apiKey: 'veto_test_key',
      endpoint: 'https://api.runveto.com',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.runveto.com/v1/policies',
      expect.objectContaining({ method: 'GET' })
    );

    veto.dispose();
  });

  it('clears refresh interval on dispose', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const veto = await Veto.fromCloud({
      apiKey: 'veto_test_key',
      endpoint: 'https://api.runveto.com',
      refreshIntervalMs: 5000,
    });

    veto.dispose();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
