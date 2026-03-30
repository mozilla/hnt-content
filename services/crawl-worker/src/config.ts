import { requireInt } from 'crawl-common';

export default {
  port: requireInt('PORT', '8080', 0, 65535),
};
