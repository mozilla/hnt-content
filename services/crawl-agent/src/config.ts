export default {
  port: parseInt(process.env.PORT ?? '8080', 10),
  tickIntervalMs: parseInt(process.env.TICK_INTERVAL_MS ?? '60000', 10),
  staleTickThresholdMinutes: parseInt(
    process.env.STALE_TICK_THRESHOLD_MINUTES ?? '10',
    10,
  ),
};
