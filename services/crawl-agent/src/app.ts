import express, { type Express } from 'express';
import config from './config.js';

export const app: Express = express();

let lastTickAt = Date.now();
let running = true;

export function isRunning() {
  return running;
}

export function stopRunning() {
  running = false;
}

export function getLastTickAt() {
  return lastTickAt;
}

export function setLastTickAt(t: number) {
  lastTickAt = t;
}

app.get('/healthz', (_req, res) => {
  const staleMs = Date.now() - lastTickAt;
  const staleMinutes = staleMs / 60_000; // convert milliseconds to minutes
  if (staleMinutes > config.staleTickThresholdMinutes) {
    res.status(500).send(`last tick ${staleMinutes.toFixed(1)}m ago`);
    return;
  }
  res.status(200).send('ok');
});
