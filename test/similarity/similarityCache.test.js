/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect } from 'vitest';

// Helper to create module under test with mocks
async function loadModuleWith({ entries = [] } = {}) {
  vi.resetModules();
  vi.doMock('../../lib/services/storage/listingsStorage.js', () => ({
    getAllEntriesFromListings: () => entries,
  }));
  return await import('../../lib/services/similarity-check/similarityCache.js');
}

describe('similarityCache', () => {
  it('initSimilarityCache builds cache from storage and enables duplicate detection', async () => {
    const entries = [
      { title: 'A', price: 1000, address: 'Main 1' },
      { title: 'B', price: 0, address: 'Zero St' },
    ];

    const { initSimilarityCache, checkAndAddEntry } = await loadModuleWith({ entries });

    // Initially, duplicates should not be detected for new data
    expect(checkAndAddEntry({ title: 'X', price: 200, address: 'Y' })).toBe(false);

    // Now initialize from storage
    initSimilarityCache();

    // Exact duplicates should be detected
    expect(checkAndAddEntry({ title: 'A', price: 1000, address: 'Main 1' })).toBe(true);
    // Ensure falsy-but-valid price 0 is preserved by hashing and detected as duplicate
    expect(checkAndAddEntry({ title: 'B', price: 0, address: 'Zero St' })).toBe(true);
  });

  it('checkAndAddEntry returns false for new entry then true for duplicate on second call', async () => {
    const { checkAndAddEntry } = await loadModuleWith();

    const first = checkAndAddEntry({ title: 'C', price: 300, address: 'Road 3' });
    const second = checkAndAddEntry({ title: 'C', price: 300, address: 'Road 3' });

    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  it('hashing ignores null/undefined but preserves 0 via behavior', async () => {
    const { checkAndAddEntry } = await loadModuleWith();

    // Add baseline (null address ignored)
    const add1 = checkAndAddEntry({ title: 'T', price: 1, address: null });
    expect(add1).toBe(false);
    // Duplicate with undefined address should match
    const dup = checkAndAddEntry({ title: 'T', price: 1, address: undefined });
    expect(dup).toBe(true);

    // Now test that price 0 is preserved (not filtered out)
    const addZero = checkAndAddEntry({ title: 'Z', price: 0, address: 'Zero' });
    expect(addZero).toBe(false);
    const dupZero = checkAndAddEntry({ title: 'Z', price: 0, address: 'Zero' });
    expect(dupZero).toBe(true);
  });

  it('removeEntry evicts a known entry so it is no longer detected as a duplicate', async () => {
    const { checkAndAddEntry, removeEntry } = await loadModuleWith();

    // Seed the cache with an entry
    expect(checkAndAddEntry({ title: 'A', price: 1000, address: 'Main 1' })).toBe(false);
    expect(checkAndAddEntry({ title: 'A', price: 1000, address: 'Main 1' })).toBe(true);

    // Evict it
    expect(removeEntry({ title: 'A', price: 1000, address: 'Main 1' })).toBe(true);

    // After eviction it must be treated as new again (this is the hard-delete fix)
    expect(checkAndAddEntry({ title: 'A', price: 1000, address: 'Main 1' })).toBe(false);
  });

  it('removeEntry returns false when the entry is not present', async () => {
    const { removeEntry } = await loadModuleWith();

    expect(removeEntry({ title: 'Nope', price: 1, address: 'Nowhere' })).toBe(false);
  });

  it('removeEntry uses the same hashing rules (null/undefined ignored, 0 preserved)', async () => {
    const { checkAndAddEntry, removeEntry } = await loadModuleWith();

    // Seed with a null address and price 0
    expect(checkAndAddEntry({ title: 'Z', price: 0, address: null })).toBe(false);

    // Removing with undefined address (same hash) should evict it
    expect(removeEntry({ title: 'Z', price: 0, address: undefined })).toBe(true);
    expect(checkAndAddEntry({ title: 'Z', price: 0, address: null })).toBe(false);
  });

  describe('fuzzy cross-portal matching', () => {
    // Real-world pairs: the same flat syndicated by the housing company to
    // immoscout and inberlinwohnen with diverging address formats and rounding.
    it('detects the same flat despite different address formats (str. vs straße, city/district suffixes)', async () => {
      const { checkAndAddEntry } = await loadModuleWith();

      expect(
        checkAndAddEntry({
          title: '2 Zimmerwohnung im Kollwitzkiez sucht neuen Mieter!',
          price: 859,
          address: 'Sredzkistr. 16, 10435 Berlin, Prenzlauer Berg',
        }),
      ).toBe(false);

      expect(
        checkAndAddEntry({
          title: '2 Zimmerwohnung im Kollwitzkiez sucht neuen Mieter!',
          price: 859,
          address: 'Sredzkistraße 16, 10435, Pankow',
        }),
      ).toBe(true);
    });

    it('detects the same flat despite small price differences (rounding across portals)', async () => {
      const { checkAndAddEntry } = await loadModuleWith();

      expect(
        checkAndAddEntry({
          title: 'Einfach mittendrin - mit der U8 nach Hause fahren!',
          price: 526,
          address: 'Demminer Straße 3, 13355 Berlin, Wedding',
        }),
      ).toBe(false);

      expect(
        checkAndAddEntry({
          title: 'Einfach mittendrin - mit der U8 nach Hause fahren!',
          price: 525,
          address: 'Demminer Straße 3, 13355, Mitte',
        }),
      ).toBe(true);
    });

    it('matches case-insensitively on house numbers and titles', async () => {
      const { checkAndAddEntry } = await loadModuleWith();

      expect(
        checkAndAddEntry({
          title: 'Iranische Straße 4b, 2 Zimmer, 1.OG, Rechts 1',
          price: 572,
          address: 'Iranische Straße 4b, 13347 Berlin, Wedding',
        }),
      ).toBe(false);

      expect(
        checkAndAddEntry({
          title: 'Iranische Straße 4B, 2 Zimmer, 1.OG, Rechts 1',
          price: 572,
          address: 'Iranische Straße 4B, 13347, Mitte',
        }),
      ).toBe(true);
    });

    it('does NOT match different flats in the same building with the same title but diverging prices', async () => {
      const { checkAndAddEntry } = await loadModuleWith();

      expect(
        checkAndAddEntry({
          title: '2-Zimmer-Wohnung mit Balkon',
          price: 525,
          address: 'Demminer Straße 3, 13355 Berlin',
        }),
      ).toBe(false);

      // Same building + title, but 100 € apart → different unit, must notify
      expect(
        checkAndAddEntry({
          title: '2-Zimmer-Wohnung mit Balkon',
          price: 625,
          address: 'Demminer Straße 3, 13355, Mitte',
        }),
      ).toBe(false);
    });

    it('does NOT match the same title at different addresses', async () => {
      const { checkAndAddEntry } = await loadModuleWith();

      expect(
        checkAndAddEntry({
          title: 'Im Kiez - 3 Zimmer',
          price: 525,
          address: 'Liverpooler Straße 16, 13349, Mitte',
        }),
      ).toBe(false);

      expect(
        checkAndAddEntry({
          title: 'Im Kiez - 3 Zimmer',
          price: 525,
          address: 'Demminer Straße 3, 13355 Berlin, Wedding',
        }),
      ).toBe(false);
    });

    it('is hydrated from storage for fuzzy matching too', async () => {
      const entries = [{ title: 'Kollwitzkiez Wohnung', price: 859, address: 'Sredzkistr. 16, 10435 Berlin' }];
      const { initSimilarityCache, checkAndAddEntry } = await loadModuleWith({ entries });
      initSimilarityCache();

      expect(
        checkAndAddEntry({ title: 'Kollwitzkiez Wohnung', price: 860, address: 'Sredzkistraße 16, 10435, Pankow' }),
      ).toBe(true);
    });

    it('removeEntry also evicts the fuzzy entry', async () => {
      const { checkAndAddEntry, removeEntry } = await loadModuleWith();

      expect(checkAndAddEntry({ title: 'Fuzzy Flat', price: 700, address: 'Teststraße 1, 10115 Berlin' })).toBe(false);
      expect(removeEntry({ title: 'Fuzzy Flat', price: 700, address: 'Teststraße 1, 10115 Berlin' })).toBe(true);

      // Neither exact nor fuzzy variant may be flagged after eviction
      expect(checkAndAddEntry({ title: 'Fuzzy Flat', price: 701, address: 'Teststr. 1, 10115, Mitte' })).toBe(false);
    });
  });
});
