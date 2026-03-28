export default {
  port: parseInt(process.env.PORT ?? '8080', 10),
  tickIntervalMs: 60_000, // ms — how often the scheduler ticks
  staleTickThresholdMinutes: 10, // minutes — healthcheck fails if no tick within this window
};
