import express from 'express';

const app = express();
const port = parseInt(process.env.PORT ?? '8080', 10);

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

app.listen(port, () => {
  console.log(`crawl-worker listening on port ${port}`);
});
