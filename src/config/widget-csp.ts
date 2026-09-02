import type { WidgetCspOptions } from '@nitrostack/core';

/**
 * Hosts that serve eBay product imagery.
 *
 * eBay returns per-item image URLs on a small set of CDN hosts, so a widget
 * sandbox can allow images without allowing arbitrary third-party resources.
 * `i.ebayimg.com` serves listing photos; `*.ebaystatic.com` serves the
 * placeholder and category artwork the Browse API falls back to.
 */
export const EBAY_IMAGE_HOSTS: readonly string[] = [
  'https://i.ebayimg.com',
  'https://*.ebayimg.com',
  'https://secureir.ebaystatic.com',
  'https://*.ebaystatic.com',
];

/**
 * CSP for widgets that render catalog imagery. Only `resourceDomains` is
 * widened: widgets never open sockets or frames of their own, so
 * `connectDomains` and `frameDomains` stay empty.
 */
export const EBAY_IMAGE_CSP: WidgetCspOptions = {
  resourceDomains: [...EBAY_IMAGE_HOSTS],
  connectDomains: [],
  frameDomains: [],
};
