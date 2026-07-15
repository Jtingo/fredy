/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { get } from '../mocks/mockNotification.js';
import { mockFredy, providerConfig } from '../utils.js';
import { expect } from 'vitest';
import * as provider from '../../lib/provider/deutschewohnen.js';
import { launchBrowser, closeBrowser } from '../../lib/services/extractor/puppeteerExtractor.js';

const TEST_TIMEOUT = 120_000;

describe('#deutschewohnen testsuite()', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser(providerConfig.deutschewohnen.url);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await closeBrowser(browser);
  });

  it(
    'should test deutschewohnen provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = {
        id: 'deutschewohnen',
        notificationAdapter: null,
        spatialFilter: null,
        specFilter: null,
      };
      provider.init(providerConfig.deutschewohnen, [], []);

      const fredy = new Fredy(provider.config, mockedJob, provider.metaInformation.id, similarityCache, browser);

      const listings = await fredy.execute();

      if (listings == null || listings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(listings).toBeInstanceOf(Array);
      // API values are rounded to whole euros / m² for hash stability.
      listings.forEach((listing) => {
        expect(listing.price).toBeTypeOf('number');
        expect(Number.isInteger(listing.price)).toBe(true);
        expect(listing.size).toBeTypeOf('number');
        expect(Number.isInteger(listing.size)).toBe(true);
        expect(listing.rooms).toBeTypeOf('number');
        // Coordinates come straight from the API so the polygon filter works
        expect(listing.latitude).toBeTypeOf('number');
        expect(listing.longitude).toBeTypeOf('number');
        if (listing.image != null) {
          expect(listing.image).toMatch(/^https?:\/\//);
        }
      });
      const notificationObj = get();
      expect(notificationObj).toBeTypeOf('object');
      expect(notificationObj.serviceName).toBe('deutschewohnen');
      notificationObj.payload.forEach((notify) => {
        /** check the actual structure **/
        expect(notify.id).toBeTypeOf('string');
        expect(notify.title).toBeTypeOf('string');
        expect(notify.link).toBeTypeOf('string');
        expect(notify.address).toBeTypeOf('string');
        expect(notify.description).toBeTypeOf('string');
        /** check the values if possible **/
        expect(notify.title).not.toBe('');
        // Expose links live under the configured search path
        expect(notify.link).toContain('https://www.deutsche-wohnen.com/mieten/mietangebote/');
        // Addresses carry street + zip + city
        expect(notify.address).toMatch(/\d{5}/);
      });
    },
    TEST_TIMEOUT,
  );
});
