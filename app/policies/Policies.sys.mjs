/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Enterprise policy definitions for browser-wip, loaded by toolkit's policy
 * engine (EnterprisePoliciesParent.sys.mjs) from
 * resource:///modules/policies/Policies.sys.mjs.
 *
 * Firefox's large policy set lives in browser/ and is not part of this app.
 * This file defines only what the app itself relies on; administrators can
 * add more later.
 */

export const Policies = {
  // Policies to undo when a previously active policies.json goes away.
  _cleanup: {},

  /**
   * Turns off Remote Settings, Mozilla's service for pushing data such as
   * blocklists and configuration to the browser. browser-wip ships that data
   * in the build instead. With the feature disallowed, Remote Settings never
   * polls and never fetches a collection that has no bundled copy.
   *
   * Enabled by the policies.json shipped in the app's distribution directory.
   */
  DisableRemoteSettings: {
    onBeforeAddons(manager, param) {
      if (param) {
        manager.disallowFeature("remoteSettings", true);
      }
    },
  },
};
