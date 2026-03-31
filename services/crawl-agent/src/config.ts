export default {
  port: Number(process.env.PORT ?? '8080'),
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? '60000'),
  staleTickThresholdMinutes: Number(
    process.env.STALE_TICK_THRESHOLD_MINUTES ?? '10',
  ),
};
