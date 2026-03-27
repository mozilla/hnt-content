import express from 'express';

const app = express();
const port = parseInt(process.env.PORT ?? '8080', 10);

let lastTickAt = Date.now();

app.get('/healthz', (_req, res) => {
  const staleMs = Date.now() - lastTickAt;
  const staleMinutes = staleMs / 60_000;
  if (staleMinutes > 10) {
    res.status(500).send(`last tick ${staleMinutes.toFixed(1)}m ago`);
    return;
  }
  res.status(200).send('ok');
});

app.listen(port, () => {
  console.log(`crawl-agent listening on port ${port}`);
});

// Placeholder tick loop; will be replaced with real scheduling logic.
async function tick() {
  lastTickAt = Date.now();
}

async function run() {
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error('tick failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

run();
