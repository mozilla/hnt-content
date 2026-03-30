describe('crawl-worker config validation', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
  });

  it('loads default port when PORT is not set', async () => {
    const { default: config } = await import('./config.js');
    expect(config.port).toBe(8080);
  });

  it('throws when PORT is not numeric', async () => {
    process.env.PORT = 'abc';
    await expect(() => import('./config.js')).rejects.toThrow(
      /PORT must be an integer/,
    );
  });

  it('throws when PORT exceeds 65535', async () => {
    process.env.PORT = '70000';
    await expect(() => import('./config.js')).rejects.toThrow(
      /PORT must be an integer/,
    );
  });
});
