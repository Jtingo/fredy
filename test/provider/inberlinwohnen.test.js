/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { get } from '../mocks/mockNotification.js';
import { mockFredy, providerConfig } from '../utils.js';
import { expect } from 'vitest';
import * as provider from '../../lib/provider/inberlinwohnen.js';
import { launchBrowser, closeBrowser } from '../../lib/services/extractor/puppeteerExtractor.js';

const TEST_TIMEOUT = 120_000;

describe('#inberlinwohnen testsuite()', () => {
  let browser;

  beforeAll(async () => {
    browser = await launchBrowser(providerConfig.inberlinwohnen.url);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await closeBrowser(browser);
  });

  it(
    'should test inberlinwohnen provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = {
        id: 'inberlinwohnen',
        notificationAdapter: null,
        spatialFilter: null,
        specFilter: null,
      };
      provider.init(providerConfig.inberlinwohnen, [], []);

      const fredy = new Fredy(provider.config, mockedJob, provider.metaInformation.id, similarityCache, browser);

      const listings = await fredy.execute();

      if (listings == null || listings.length === 0) {
        throw new Error('Listings is empty!');
      }

      expect(listings).toBeInstanceOf(Array);
      // Normalized listings carry numeric values before notification formatting
      listings.forEach((listing) => {
        expect(listing.price).toBeTypeOf('number');
        expect(listing.size).toBeTypeOf('number');
        expect(listing.rooms).toBeTypeOf('number');
        if (listing.image != null) {
          expect(listing.image).toContain('https://inberlinwohnen.de/');
        }
      });
      const notificationObj = get();
      expect(notificationObj).toBeTypeOf('object');
      expect(notificationObj.serviceName).toBe('inberlinwohnen');
      notificationObj.payload.forEach((notify) => {
        /** check the actual structure **/
        expect(notify.id).toBeTypeOf('string');
        expect(notify.title).toBeTypeOf('string');
        expect(notify.link).toBeTypeOf('string');
        expect(notify.address).toBeTypeOf('string');
        expect(notify.description).toBeTypeOf('string');
        /** check the values if possible **/
        expect(notify.title).not.toBe('');
        // Deeplinks point to the individual housing companies' expose pages
        expect(notify.link).toMatch(/^https?:\/\//);
        // Addresses on the portal always carry a Berlin zip code
        expect(notify.address).toMatch(/\d{5}/);
      });
    },
    TEST_TIMEOUT,
  );
});
