import request from 'supertest';
import { app } from './app.js';

describe('crawl-worker healthcheck', () => {
  it('GET /healthz returns 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });
});
