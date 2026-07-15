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

const BASE_URL = 'https://www.adler-group.com';

let appliedBlackList = [];
let appliedBlacklistedDistricts = [];

/**
 * Turn a relative URL coming from the portal (e.g. "/expose?tx_adler...")
 * into an absolute one. Returns null for falsy input.
 * @param {string|null|undefined} link
 * @returns {string|null}
 */
function toAbsoluteLink(link) {
  if (!link) return null;
  return link.startsWith('http') ? link : `${BASE_URL}${link}`;
}

/**
 * Fetch the search result page with a plain HTTP GET and parse it. The site
 * (TYPO3 + Everreal) server-side renders all listings on a single page, so no
 * headless browser is needed.
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
    logger.error(`Error fetching adler-group listings (HTTP ${response.status}) from ${url}`);
    return [];
  }
  const html = await response.text();
  loadParser(html);
  return parse(config.crawlContainer, config.crawlFields, html, url) ?? [];
}

/**
 * Extract a number and round it to the nearest integer, keeping listing hashes
 * stable across cent-/decimal-level recalculations (same rationale as the
 * inberlinwohnen provider).
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
function extractRoundedNumber(value) {
  const num = extractNumber(value);
  return num == null ? null : Math.round(num);
}

/**
 * Extract the image URL from an inline background-image style attribute,
 * e.g. `background-image: url('https://resources.everreal.co/...')`.
 * @param {string|null|undefined} style
 * @returns {string|null}
 */
function imageFromStyle(style) {
  if (style == null) return null;
  const match = String(style).match(/url\(['"]?([^'")]+)['"]?\)/);
  return match ? match[1] : null;
}

/**
 * The card renders no free-text description, so a compact summary is composed
 * from the structured facts. All parts are optional; missing values are skipped.
 * @param {any} o raw crawled listing
 * @returns {string}
 */
function buildDescription(o) {
  // Some room cells already contain the word "Zimmer", so build the label
  // from the extracted number instead of the raw cell text.
  const rooms = extractNumber(o.rooms);
  return [rooms ? `${rooms} Zimmer` : null, o.size || null, o.price ? `${o.price} Kaltmiete` : null]
    .filter(Boolean)
    .join(' · ');
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const price = extractRoundedNumber(o.price);
  const address = [o.street, o.cityLine]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(', ');

  return {
    // The data-object-id is the portal's stable listing uid; hash it together
    // with the rounded price so real price changes still re-notify.
    id: buildHash(o.id, price == null ? null : String(price)),
    title: (o.title || '').replace(/\s*\.{3}\s*$/, '').trim(),
    link: toAbsoluteLink(o.link) || config.url,
    price,
    size: extractRoundedNumber(o.size),
    rooms: extractNumber(o.rooms),
    address,
    image: imageFromStyle(o.image),
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
  // One ".single-object" card per listing; all results render on a single page
  // (no pagination), so every crawl sees the full inventory.
  crawlContainer: '.single-object',
  sortByDateParam: null,
  // Listings are fetched via plain HTTP (see getListings), not the headless browser.
  waitForSelector: null,
  getListings,
  crawlFields: {
    id: '@data-object-id',
    link: '.object-headline a@href',
    title: '.object-headline h3 | trim',
    image: '.single-object-preview-image@style',
    // The card's info table is positional (no labels):
    // row 1: street | size, row 2: zip+city | rooms, row 3: map link | price
    street: 'table tr:nth-of-type(1) td:nth-of-type(1) | trim',
    size: 'table tr:nth-of-type(1) td:nth-of-type(2) | trim',
    cityLine: 'table tr:nth-of-type(2) td:nth-of-type(1) | trim',
    rooms: 'table tr:nth-of-type(2) td:nth-of-type(2) | trim',
    price: 'table b | trim',
  },
  normalize,
  filter: applyBlacklist,
  activeTester: checkIfListingIsActive,
};

export const metaInformation = {
  name: 'Adler Group',
  baseUrl: `${BASE_URL}/`,
  id: 'adlergroup',
};

export const init = (sourceConfig, blacklist, blacklistedDistricts) => {
  config.enabled = sourceConfig.enabled;
  config.url = sourceConfig.url;
  appliedBlacklistedDistricts = blacklistedDistricts || [];
  appliedBlackList = blacklist || [];
};

export { config };
