import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DATAGRAM_TIMEOUT_MS = 1_000;

/**
 * Integration test for the metrics client. Binds a real UDP socket to
 * check the one guarantee the unit tests cannot: that a tag value cannot
 * forge a second StatsD line once hot-shots has serialized it. The
 * library escapes `:|@,` but not newlines, so the wrapper's own
 * sanitizing has to be sufficient. What hot-shots does promise, batching
 * and global tag merging, is asserted as configuration in client.spec.ts
 * rather than re-tested here.
 */
describe('metrics client integration', () => {
  let socket: dgram.Socket;
  let datagrams: string[];

  beforeEach(async () => {
    datagrams = [];
    socket = dgram.createSocket('udp4');
    socket.on('message', (msg) => datagrams.push(msg.toString()));
    // Port 0 picks a free port, so concurrent runs cannot collide.
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));

    vi.stubEnv('STATSD_HOST', '127.0.0.1');
    vi.stubEnv('STATSD_PORT', String(socket.address().port));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  });

  it('emits one line for one metric despite a newline in a tag', async () => {
    // Imported per test so config re-reads the stubbed env.
    vi.resetModules();
    const metrics = await import('./client.js');
    metrics.initMetrics({ service: 'crawl-worker' });

    metrics.count('crawl.zyte.errors', 1, {
      error_type: 'boom\nevil.metric:999|c',
    });

    // Closing flushes the buffer, so this does not wait on the timer.
    await metrics.shutdownMetrics();
    await waitFor(() => datagrams.length > 0, DATAGRAM_TIMEOUT_MS);

    // An unsanitized newline would end this line and append a second,
    // attacker-chosen metric that the gateway would then reject.
    const lines = datagrams.join('').split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('error_type:boom_evil.metric_999_c');
  });
});

/** Poll until the predicate returns true, or reject on timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
