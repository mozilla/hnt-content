import request from 'supertest';
import { app, setLastTickAt } from './app.js';
import config from './config.js';

describe('crawl-agent healthcheck', () => {
  beforeEach(() => {
    setLastTickAt(0);
  });

  it('GET /healthz returns 200 when tick is recent', async () => {
    setLastTickAt(Date.now());
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });

  it('GET /healthz returns 500 when tick is stale', async () => {
    setLastTickAt(Date.now() - (config.staleTickThresholdMinutes + 1) * 60_000);
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(500);
    expect(res.text).toMatch(/last tick/);
  });

  it('GET /healthz returns 200 when tick is just within threshold', async () => {
    // Use 1s buffer to avoid timing races between setLastTickAt and the request
    setLastTickAt(
      Date.now() - config.staleTickThresholdMinutes * 60_000 + 1_000,
    );
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
  });

  it('GET /healthz returns 500 when tick exceeds threshold', async () => {
    setLastTickAt(
      Date.now() - config.staleTickThresholdMinutes * 60_000 - 1_000,
    );
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(500);
  });

  it('GET /healthz returns 500 before first tick', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(500);
    expect(res.text).toBe('no tick yet');
  });
});
