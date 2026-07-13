/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import { loadParser, parse } from '../services/extractor/parser/parser.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://inberlinwohnen.de';

let appliedBlackList = [];
let appliedBlacklistedDistricts = [];

/**
 * Turn a relative URL coming from the portal (e.g. "/img/images/apartments/...")
 * into an absolute one. Returns null for falsy input.
 * @param {string|null|undefined} link
 * @returns {string|null}
 */
function toAbsoluteLink(link) {
  if (!link) return null;
  return link.startsWith('http') ? link : `${BASE_URL}${link}`;
}

/**
 * Fetch the Wohnungsfinder list page with a plain HTTP GET and parse it.
 *
 * The portal (Laravel Livewire) server-side renders all listings into the
 * initial HTML, but in a real browser the cookie-consent layer removes them
 * from the DOM before they can be scraped. A plain fetch never executes that
 * JavaScript, so it reliably sees the fully rendered listings — no headless
 * browser needed.
 *
 * @param {string} url Search URL (already passed through the query-string mutator).
 * @returns {Promise<any[]>} Raw crawled listing objects (normalized later in the pipeline).
 */
async function getListings(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  if (!response.ok) {
    logger.error(`Error fetching inberlinwohnen listings (HTTP ${response.status}) from ${url}`);
    return [];
  }
  const html = await response.text();
  loadParser(html);
  return parse(config.crawlContainer, config.crawlFields, html, url) ?? [];
}

/**
 * The portal renders no free-text description on the list page, so a compact
 * summary is composed from the structured facts instead. All parts are
 * optional; missing values are skipped.
 * @param {any} o raw crawled listing
 * @returns {string}
 */
function buildDescription(o) {
  return [
    o.rooms ? `${o.rooms} Zimmer` : null,
    o.size || null,
    o.price ? `${o.price} Kaltmiete` : null,
    o.availableFrom ? `Bezugsfertig ab ${o.availableFrom}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Extract a number and round it to the nearest integer. The portal displays
 * cent-/decimal-exact values ("519,56 €", "78,59 m²") that get recalculated by
 * tiny amounts between crawls; rounding keeps the listing hash stable so the
 * same flat is not re-notified over a cent-level change.
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
function extractRoundedNumber(value) {
  const num = extractNumber(value);
  return num == null ? null : Math.round(num);
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const price = extractRoundedNumber(o.price);
  return {
    // Hash on the rounded price (not the raw string) for the same stability
    // reason. buildHash ignores non-strings, so the number must be stringified.
    id: buildHash(o.id, price == null ? null : String(price)),
    title: o.title,
    link: o.link || config.url,
    price,
    size: extractRoundedNumber(o.size),
    rooms: extractNumber(o.rooms),
    address: o.address,
    image: toAbsoluteLink(o.image),
    description: buildDescription(o),
  };
}

/**
 * @param {ParsedListing} o
 * @returns {boolean}
 */
function applyBlacklist(o) {
  const titleNotBlacklisted = !isOneOf(o.title, appliedBlackList);
  const descNotBlacklisted = !isOneOf(o.description, appliedBlackList);
  const isBlacklistedDistrict =
    appliedBlacklistedDistricts.length === 0 ? false : isOneOf(o.address, appliedBlacklistedDistricts);
  return o.title != null && !isBlacklistedDistrict && titleNotBlacklisted && descNotBlacklisted;
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  // Each apartment renders one ".list__details" card containing the title, the
  // structured facts (dt/dd pairs), the image and the deeplink to the housing
  // company's expose page.
  crawlContainer: '.list__details',
  // The Wohnungsfinder already sorts by "created_at desc" (newest first) by default.
  sortByDateParam: null,
  // Listings are fetched via plain HTTP (see getListings), not the headless browser.
  waitForSelector: null,
  getListings,
  crawlFields: {
    // Deeplink to the housing company's own expose page (berlinovo, degewo,
    // GESOBAU, Gewobag, HOWOGE, STADT UND LAND, WBM).
    id: 'div.text-center a@href',
    link: 'div.text-center a@href',
    title: 'span.text-xl | trim',
    address: 'button[aria-label="Auf der Karte anzeigen"] | trim',
    rooms: 'dt:contains("Zimmeranzahl") + dd | trim',
    size: 'dt:contains("Wohnfläche") + dd | trim',
    price: 'dt:contains("Kaltmiete") + dd | trim',
    availableFrom: 'dt:contains("Bezugsfertig") + dd | trim',
    image: 'picture img@src',
  },
  normalize,
  filter: applyBlacklist,
  activeTester: checkIfListingIsActive,
};

export const metaInformation = {
  name: 'inBerlinWohnen',
  baseUrl: `${BASE_URL}/`,
  id: 'inberlinwohnen',
};

export const init = (sourceConfig, blacklist, blacklistedDistricts) => {
  config.enabled = sourceConfig.enabled;
  config.url = sourceConfig.url;
  appliedBlacklistedDistricts = blacklistedDistricts || [];
  appliedBlackList = blacklist || [];
};

export { config };
