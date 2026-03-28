import express, { type Express } from 'express';

export const app: Express = express();

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});
