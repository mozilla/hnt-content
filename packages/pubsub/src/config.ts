// The following config is shared by all consumers of this package.

const emulatorHost = process.env.PUBSUB_EMULATOR_HOST;

export default {
  // Unset in a deployed pod: the SDK resolves the project from the GKE
  // metadata server, so the chart does not have to inject it.
  projectId: process.env.PROJECT_ID,
  apiEndpoint: emulatorHost,
  // An emulator endpoint also means no credentials, which skips a
  // metadata-server probe that otherwise costs seconds per client.
  useEmulator: Boolean(emulatorHost),
};
