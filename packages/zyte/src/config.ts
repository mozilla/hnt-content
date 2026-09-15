// The following config is shared by all consumers of this package. For
// deployed pods, the key comes from Secret Manager through the chart.

export default {
  apiKey: process.env.ZYTE_API_KEY,
};
