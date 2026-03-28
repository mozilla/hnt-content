import request from 'supertest';
import { app, setLastTickAt } from './app.js';
import config from './config.js';

describe('crawl-agent healthcheck', () => {
  it('GET /healthz returns 200 when tick is recent', async () => {
    setLastTickAt(Date.now());
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });

  it('GET /healthz returns 500 when tick is stale', async () => {
    setLastTickAt(
      Date.now() - (config.staleTickThresholdMinutes + 1) * 60_000,
    );
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(500);
    expect(res.text).toMatch(/last tick/);
  });
});
