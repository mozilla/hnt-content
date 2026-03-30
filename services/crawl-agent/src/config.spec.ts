describe('crawl-agent config validation', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
  });

  it('loads defaults when no env vars are set', async () => {
    const { default: config } = await import('./config.js');
    expect(config.port).toBe(8080);
    expect(config.tickIntervalMs).toBe(60000);
    expect(config.staleTickThresholdMinutes).toBe(10);
  });

  it('throws when PORT is not numeric', async () => {
    process.env.PORT = 'abc';
    await expect(() => import('./config.js')).rejects.toThrow(
      /PORT must be an integer/,
    );
  });

  it('throws when TICK_INTERVAL_MS is 0 (below min)', async () => {
    process.env.TICK_INTERVAL_MS = '0';
    await expect(() => import('./config.js')).rejects.toThrow(
      /TICK_INTERVAL_MS must be an integer/,
    );
  });

  it('throws when STALE_TICK_THRESHOLD_MINUTES is negative', async () => {
    process.env.STALE_TICK_THRESHOLD_MINUTES = '-1';
    await expect(() => import('./config.js')).rejects.toThrow(
      /STALE_TICK_THRESHOLD_MINUTES must be an integer/,
    );
  });
});
