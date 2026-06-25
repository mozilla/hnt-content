import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

/** Import a fresh config module with the given env overrides applied. */
async function loadConfig(
  overrides: Record<string, string | undefined>,
): Promise<(typeof import('./config.js'))['default']> {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ...overrides };
  return (await import('./config.js')).default;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('agent Corpus config', () => {
  it('parses surfaces and refresh interval when the JWK is set', async () => {
    const config = await loadConfig({
      CORPUS_API_JWK_JSON: '{"kid":"x"}',
      CORPUS_SCHEDULED_SURFACE_GUIDS: 'NEW_TAB_EN_US, NEW_TAB_DE_DE',
      CORPUS_REFRESH_MINUTES: '5',
    });

    expect(config.scheduledSurfaceGuids).toEqual([
      'NEW_TAB_EN_US',
      'NEW_TAB_DE_DE',
    ]);
    expect(config.corpusRefreshMinutes).toBe(5);
  });

  it('fails fast when the JWK is set but no surfaces are configured', async () => {
    await expect(
      loadConfig({
        CORPUS_API_JWK_JSON: '{"kid":"x"}',
        CORPUS_SCHEDULED_SURFACE_GUIDS: ' , ,',
      }),
    ).rejects.toThrow('CORPUS_SCHEDULED_SURFACE_GUIDS');
  });

  it('fails fast when the JWK is set but the refresh interval is not positive', async () => {
    await expect(
      loadConfig({
        CORPUS_API_JWK_JSON: '{"kid":"x"}',
        CORPUS_REFRESH_MINUTES: '0',
      }),
    ).rejects.toThrow('CORPUS_REFRESH_MINUTES');
  });

  it('does not require surfaces when the Corpus source is disabled', async () => {
    const config = await loadConfig({
      CORPUS_API_JWK_JSON: undefined,
      CORPUS_SCHEDULED_SURFACE_GUIDS: '',
    });

    expect(config.corpusApi.jwkJson).toBe('');
    expect(config.scheduledSurfaceGuids).toEqual([]);
  });
});
