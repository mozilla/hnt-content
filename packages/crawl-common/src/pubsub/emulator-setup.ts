import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { PROJECT_ID } from './test-helpers.js';

const execFileAsync = promisify(execFile);

const EMULATOR_IMAGE = 'gcr.io/google.com/cloudsdktool/cloud-sdk:emulators';
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 100;

let containerId: string | undefined;

/**
 * Vitest globalSetup that ensures a Pub/Sub emulator is reachable
 * at PUBSUB_EMULATOR_HOST before any integration test runs.
 *
 * CI (and any caller that wants pnpm test to stay under 5s) is
 * expected to start the emulator in advance, set the env var,
 * and let this function probe-and-pass. When the env var is
 * unset (developer workflow), the function falls back to
 * `docker run` so a plain `pnpm test` still works locally.
 */
export async function setup(): Promise<void> {
  if (process.env.PUBSUB_EMULATOR_HOST) {
    const port = parseHostPort(process.env.PUBSUB_EMULATOR_HOST);
    await waitForHttpReady(port);
    return;
  }

  const { stdout: runStdout } = await execFileAsync('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '0:8085',
    EMULATOR_IMAGE,
    'gcloud',
    'beta',
    'emulators',
    'pubsub',
    'start',
    '--host-port=0.0.0.0:8085',
    `--project=${PROJECT_ID}`,
  ]);
  containerId = runStdout.trim();

  const { stdout: portStdout } = await execFileAsync('docker', [
    'port',
    containerId,
    '8085/tcp',
  ]);
  const port = portStdout.split('\n')[0].split(':').pop()?.trim();
  if (!port) throw new Error(`unable to read mapped port: ${portStdout}`);
  process.env.PUBSUB_EMULATOR_HOST = `localhost:${port}`;

  await waitForHttpReady(Number(port));
}

/** Parse "host:port" into a numeric port. */
function parseHostPort(hostPort: string): number {
  const port = Number(hostPort.split(':').pop());
  if (!Number.isFinite(port)) {
    throw new Error(`PUBSUB_EMULATOR_HOST is malformed: ${hostPort}`);
  }
  return port;
}

export async function teardown(): Promise<void> {
  if (containerId) {
    // -t 0 issues SIGKILL immediately; the default 10s graceful
    // window adds a full block of dead time at the end of every
    // run, since the emulator JVM doesn't trap SIGTERM.
    await execFileAsync('docker', ['stop', '-t', '0', containerId]).catch(
      () => {},
    );
  }
}

/**
 * Poll the emulator's HTTP endpoint until it returns 200. The
 * emulator opens its TCP socket a few seconds before logging
 * "Server started", so probing HTTP fires earlier than tailing
 * container logs.
 */
async function waitForHttpReady(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(port)) return;
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error(`emulator did not become ready within ${READY_TIMEOUT_MS}ms`);
}

/** One HTTP probe; resolves to true on a 200, false otherwise. */
function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: 'localhost',
        port,
        path: `/v1/projects/${PROJECT_ID}/topics`,
        method: 'GET',
        timeout: 1000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
