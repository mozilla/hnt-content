import { requireInt } from 'crawl-common';

export default {
  port: requireInt('PORT', '8080', 1, 65535),
};
