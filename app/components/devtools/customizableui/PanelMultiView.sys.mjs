/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Stands in for Firefox's PanelMultiView (see CustomizableUI.sys.mjs). */
export const PanelMultiView = {
  getViewNode(doc, id) {
    return doc.getElementById(id);
  },
};
