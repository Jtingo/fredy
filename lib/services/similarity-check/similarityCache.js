/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Similarity cache
 *
 * Maintains an in-memory Set of content hashes to detect whether a listing
 * (identified by a tuple of title, price and address) has been seen before.
 *
 * Two matching layers are used:
 * 1. Exact: an SHA-256 hash over the raw title|price|address tuple.
 * 2. Fuzzy: housing companies syndicate the same flat to several portals with
 *    identical titles but slightly different address formats ("Sredzkistr. 16,
 *    10435 Berlin, Prenzlauer Berg" vs "Sredzkistraße 16, 10435, Pankow") and
 *    prices that differ by rounding ("526" vs "525,93"). The fuzzy layer
 *    therefore compares a normalized title, a normalized street+zip address key
 *    and allows a small price tolerance.
 *
 * Design notes:
 * - The cache is refreshed periodically from persistent storage. To avoid
 *   modification-during-iteration issues, the refresh builds new structures and
 *   atomically swaps the references instead of mutating in place.
 * - Hashing ignores null/undefined values but preserves falsy-yet-valid values
 *   like 0. Non-string values are coerced to strings before hashing.
 *
 * This module has no persistence of its own; it relies on
 * getAllEntriesFromListings() for data hydration.
 * @module similarityCache
 */
import crypto from 'crypto';
import { getAllEntriesFromListings } from '../storage/listingsStorage.js';

/** Max price difference (in €) for two listings to still count as the same flat. */
const PRICE_TOLERANCE = 5;

/** @type {number} Refresh interval in milliseconds (defaults to one hour). */
const reloadCycle = 60 * 60 * 1000; // every hour, refresh

/**
 * Internal cache of content hashes for known listings.
 *
 * Each entry is an SHA-256 hex digest produced by toHash(title, price, address).
 * @type {Set<string>}
 */
let cache = new Set();

/**
 * Fuzzy index for cross-portal duplicate detection: normalized title →
 * entries of {price, addressKey} to compare against with tolerance.
 * @type {Map<string, Array<{price: number|null, addressKey: string|null}>>}
 */
let fuzzyIndex = new Map();

/**
 * Normalize a listing title for fuzzy comparison: lowercase, strip everything
 * except letters/digits, collapse whitespace.
 * @param {string|null|undefined} title
 * @returns {string|null} normalized title or null when empty
 */
function normalizeTitle(title) {
  if (title == null) return null;
  const normalized = String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Build a portal-independent address key: "<zip>|<street+housenumber>".
 * Normalizes the common German street abbreviations ("Sredzkistr. 16" and
 * "Sredzkistraße 16" produce the same key) and ignores city/district suffixes,
 * which differ between portals ("… Berlin, Wedding" vs "…, Mitte").
 * @param {string|null|undefined} address
 * @returns {string|null} address key or null when nothing usable was found
 */
function buildAddressKey(address) {
  if (address == null) return null;
  const lower = String(address).toLowerCase();
  const zip = lower.match(/\b\d{5}\b/)?.[0] ?? '';
  const street = lower
    .split(',')[0]
    .replace(/strasse/g, 'straße')
    .replace(/str\.?(?=\s|$)/g, 'straße')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  if (zip === '' && street === '') return null;
  return `${zip}|${street}`;
}

/**
 * Coerce a price to a number for tolerant comparison.
 * @param {number|string|null|undefined} price
 * @returns {number|null}
 */
function toPriceNumber(price) {
  if (price == null) return null;
  const num = Number(price);
  return Number.isFinite(num) ? num : null;
}

/**
 * Check whether a listing matches a known entry in the fuzzy index: identical
 * normalized title, identical address key and price within PRICE_TOLERANCE.
 * @param {string|null} titleKey
 * @param {string|null} addressKey
 * @param {number|null} price
 * @returns {boolean}
 */
function hasFuzzyMatch(titleKey, addressKey, price) {
  if (titleKey == null || addressKey == null) return false;
  const candidates = fuzzyIndex.get(titleKey);
  if (candidates == null) return false;
  return candidates.some((candidate) => {
    if (candidate.addressKey !== addressKey) return false;
    if (price == null || candidate.price == null) return price == null && candidate.price == null;
    return Math.abs(candidate.price - price) <= PRICE_TOLERANCE;
  });
}

/**
 * Add an entry to the given fuzzy index. No-op when the title is unusable.
 * @param {Map<string, Array<{price: number|null, addressKey: string|null}>>} index
 * @param {string|null} titleKey
 * @param {string|null} addressKey
 * @param {number|null} price
 * @returns {void}
 */
function addFuzzyEntry(index, titleKey, addressKey, price) {
  if (titleKey == null) return;
  const entries = index.get(titleKey);
  if (entries == null) {
    index.set(titleKey, [{ price, addressKey }]);
  } else {
    entries.push({ price, addressKey });
  }
}

export const startSimilarityCacheReloader = () => {
  // Periodically refresh the cache from storage
  setInterval(() => {
    initSimilarityCache();
  }, reloadCycle);
};

/**
 * Initialize or refresh the similarity cache from persistent storage.
 *
 * Reads all stored listings via getAllEntriesFromListings(), computes a hash for
 * each, and swaps the in-memory Set atomically to avoid in-place mutations that
 * could interfere with concurrent iteration.
 *
 * This function is idempotent and safe to call at any time.
 * @returns {void}
 */
export const initSimilarityCache = () => {
  const allEntries = getAllEntriesFromListings();
  const newCache = new Set();
  const newFuzzyIndex = new Map();
  for (const entry of allEntries) {
    newCache.add(toHash(entry?.title, entry?.price, entry?.address));
    addFuzzyEntry(
      newFuzzyIndex,
      normalizeTitle(entry?.title),
      buildAddressKey(entry?.address),
      toPriceNumber(entry?.price),
    );
  }
  // Atomic swap to avoid mutating the structures while they may be iterated elsewhere
  cache = newCache;
  fuzzyIndex = newFuzzyIndex;
};

/**
 * Check if a listing is already known and add it to the cache if not.
 *
 * The listing is identified by the combination of its title, price and
 * address. Null/undefined fields are ignored during hashing. Falsy-but-valid
 * values (e.g., price 0) are preserved.
 *
 * @param {Object} params - Listing fields
 * @param {string|undefined|null} params.title - The listing title
 * @param {string|undefined|null} params.address - The listing address
 * @param {number|string|undefined|null} params.price - The listing price
 * @returns {boolean} true if the entry already existed in the cache (duplicate), otherwise false
 */
export const checkAndAddEntry = ({ title, address, price }) => {
  const hash = toHash(title, price, address);
  const titleKey = normalizeTitle(title);
  const addressKey = buildAddressKey(address);
  const priceNumber = toPriceNumber(price);
  if (cache.has(hash) || hasFuzzyMatch(titleKey, addressKey, priceNumber)) {
    return true;
  }
  cache.add(hash);
  addFuzzyEntry(fuzzyIndex, titleKey, addressKey, priceNumber);
  return false;
};

/**
 * Remove an entry from the similarity cache.
 *
 * Must be called when a listing is permanently (hard) deleted. The on-disk row
 * is gone, but without evicting its content hash here the in-memory cache stays
 * stale until the next hourly reload (or a restart). That staleness causes the
 * "hard-deleted listings vanish" bug: the next scan re-discovers the listing
 * (its hash is no longer in the DB, so it counts as new and gets re-inserted),
 * but {@link checkAndAddEntry} still finds the old hash here and the pipeline
 * immediately soft-deletes the freshly inserted row.
 *
 * The cache is a plain Set of hashes with no reference counting, so if two
 * still-present listings happen to share the same title|price|address hash,
 * removing one drops the shared hash. This is self-healing and consistent with
 * the cache's best-effort design: the next {@link checkAndAddEntry} re-adds the
 * hash and the hourly reload rebuilds it from storage. The only consequence is
 * that a genuine duplicate may slip through once, which is far less harmful than
 * a hard-deleted listing never reappearing.
 *
 * Uses the same hashing rules as {@link checkAndAddEntry} (null/undefined
 * ignored, falsy-but-valid values like 0 preserved).
 *
 * @param {Object} params - Listing fields identifying the entry to evict.
 * @param {string|undefined|null} params.title - The listing title.
 * @param {string|undefined|null} params.address - The listing address.
 * @param {number|string|undefined|null} params.price - The listing price.
 * @returns {boolean} true if an entry was removed, false if it was not present.
 */
export const removeEntry = ({ title, address, price }) => {
  const titleKey = normalizeTitle(title);
  const entries = fuzzyIndex.get(titleKey);
  if (entries != null) {
    const addressKey = buildAddressKey(address);
    const priceNumber = toPriceNumber(price);
    const index = entries.findIndex((e) => e.addressKey === addressKey && e.price === priceNumber);
    if (index !== -1) {
      entries.splice(index, 1);
      if (entries.length === 0) {
        fuzzyIndex.delete(titleKey);
      }
    }
  }
  return cache.delete(toHash(title, price, address));
};

/**
 * Generate an SHA-256 hash from a list of input values.
 * Null or undefined values are ignored. Falsy but valid values like 0 are preserved.
 * Non-string values are coerced to strings prior to hashing.
 *
 * @param {...(string|number|null|undefined)} strings - Input values to hash
 * @returns {string} Hexadecimal hash
 */
function toHash(...strings) {
  const normalized = strings
    .filter((v) => v !== null && v !== undefined)
    .map((v) => (typeof v === 'string' ? v : String(v)));
  return crypto.createHash('sha256').update(normalized.join('|')).digest('hex');
}
