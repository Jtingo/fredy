/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const API_PATH = '/api/real-estate/list';
/** High limit so the full inventory is returned in a single request (no paging). */
const API_LIMIT = 200;

let appliedBlackList = [];
let appliedBlacklistedDistricts = [];

/**
 * Fetch listings from the site's JSON API. The user configures the regular
 * search URL (e.g. /zuhause-finden/immobilien?rentType=miete&city=Berlin...); its
 * query string is passed unchanged to the list API, plus a high limit so all
 * results arrive in one request.
 *
 * @param {string} url Search URL (already passed through the query-string mutator).
 * @returns {Promise<any[]>} Raw API listing objects (normalized later in the pipeline).
 */
async function getListings(url) {
  const parsed = new URL(url);
  const apiUrl = `${parsed.origin}${API_PATH}${parsed.search}${parsed.search ? '&' : '?'}limit=${API_LIMIT}`;
  const response = await fetch(apiUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    logger.error(`Error fetching vonovia listings (HTTP ${response.status}) from ${apiUrl}`);
    return [];
  }
  const body = await response.json();
  return body?.results ?? [];
}

/**
 * Round a numeric API value to the nearest integer, keeping listing hashes
 * stable across cent-/decimal-level recalculations.
 * @param {number|null|undefined} value
 * @returns {number|null}
 */
function roundOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * Build the expose link for a result. The detail route lives under the same
 * path as the configured search URL: <origin><searchPath>/<slug>.
 * @param {string|null|undefined} slug
 * @returns {string|null}
 */
function buildExposeLink(slug) {
  if (!slug || !config.url) return config.url ?? null;
  try {
    const parsed = new URL(config.url);
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}/${slug}`;
  } catch {
    return config.url;
  }
}

/**
 * @param {any} o raw API result
 * @returns {ParsedListing}
 */
function normalize(o) {
  const price = roundOrNull(o.preis);
  const size = roundOrNull(o.groesse);
  const rooms = typeof o.anzahl_zimmer === 'number' ? o.anzahl_zimmer : null;
  const address = [o.strasse, [o.plz, o.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  return {
    id: buildHash(o.wrk_id, price == null ? null : String(price)),
    title: o.titel,
    link: buildExposeLink(o.slug),
    price,
    size,
    rooms,
    address,
    image: o.preview_img_url || null,
    description: [rooms ? `${rooms} Zimmer` : null, size ? `${size} m²` : null, price ? `${price} € Kaltmiete` : null]
      .filter(Boolean)
      .join(' · '),
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
  // API based provider: crawlContainer/crawlFields are unused but kept for shape.
  crawlContainer: null,
  sortByDateParam: null,
  waitForSelector: null,
  getListings,
  crawlFields: {},
  normalize,
  filter: applyBlacklist,
  activeTester: checkIfListingIsActive,
};

export const metaInformation = {
  name: 'Vonovia',
  baseUrl: 'https://www.vonovia.de/',
  id: 'vonovia',
};

export const init = (sourceConfig, blacklist, blacklistedDistricts) => {
  config.enabled = sourceConfig.enabled;
  config.url = sourceConfig.url;
  appliedBlacklistedDistricts = blacklistedDistricts || [];
  appliedBlackList = blacklist || [];
};

export { config };
