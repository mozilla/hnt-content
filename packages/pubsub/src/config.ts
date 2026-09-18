// The following config is shared by all consumers of this package.

const emulatorHost = process.env.PUBSUB_EMULATOR_HOST;

export default {
  // Set by the chart. Left unset the SDK resolves the shared cluster's
  // project, moz-fx-webservices-high-prod, while our topics live in
  // moz-fx-hnt-prod. Non-prod mirrors this split.
  projectId: process.env.PROJECT_ID,
  apiEndpoint: emulatorHost,
  // An emulator endpoint also means no credentials, which skips a
  // metadata-server probe that otherwise costs seconds per client.
  useEmulator: Boolean(emulatorHost),
};
