/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Clear site data: what sites keep on this computer, for one site (the site
 * information panel) or for all of them (Settings).
 *
 * A site is its registrable domain, subdomains included: clearing
 * mail.example.com clears example.com and its other subdomains too, as
 * their cookies are shared. What goes: cookies, storage (local storage,
 * IndexedDB, caches of service workers, push subscriptions), cached files,
 * the site's permissions (camera, location, notifications, protections
 * turned off) and the icons the new tab page keeps for its favorites.
 * History, bookmarks and saved passwords stay.
 */

import { SiteIcons } from "resource://gre/modules/browserwip/SiteIcons.sys.mjs";

const FLAGS =
  Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA |
  Ci.nsIClearDataService.CLEAR_ALL_CACHES |
  Ci.nsIClearDataService.CLEAR_PERMISSIONS;

export const SiteData = {
  /**
   * The site whose data clearSite() would clear for a page, or null for a
   * page that keeps none (about:, file:, ...).
   */
  siteFor(uri) {
    if (!uri || !/^https?$/.test(uri.scheme) || !uri.host) {
      return null;
    }
    try {
      return Services.eTLD.getSchemelessSite(uri);
    } catch (e) {
      // An IP address or a single-label host: the host is the site.
      return uri.host;
    }
  },

  /** Clears everything one site keeps (site: from siteFor). */
  async clearSite(site) {
    await new Promise(resolve => Services.clearData.deleteDataFromSite(site, {}, true, FLAGS, resolve));
    await SiteIcons.forgetSite(site);
  },

  /** Clears everything every site keeps. */
  async clearAll() {
    await new Promise(resolve => Services.clearData.deleteData(FLAGS, resolve));
    await SiteIcons.clear();
  },
};
