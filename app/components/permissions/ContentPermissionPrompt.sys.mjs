/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Gecko's nsIContentPermissionPrompt: location, notifications, persistent
 * storage, MIDI, VR and storage access ask through here. Without an
 * implementation Gecko quietly denies them all; Firefox's is in browser/.
 *
 * A remembered decision is applied at once; otherwise the window's
 * permission prompt (permissions.js) asks. Registered at startup by
 * BrowserWipGlue.
 */

// Request type -> how it is kept in the permission manager.
//   permission: the permission manager's name for it
//   needsGesture: only asked when the page is handling a click or key press
const TYPES = {
  geolocation: { permission: "geo" },
  "desktop-notification": { permission: "desktop-notification", needsGesture: true },
  "persistent-storage": { permission: "persistent-storage" },
  midi: { permission: "midi" },
  xr: { permission: "xr" },
  // Gecko stores the grant itself, per pair of sites.
  "storage-access": {},
};

export class ContentPermissionPrompt {
  QueryInterface = ChromeUtils.generateQI(["nsIContentPermissionPrompt"]);

  prompt(request) {
    let type = request.types.queryElementAt(0, Ci.nsIContentPermissionType).type;
    let spec = TYPES[type];
    let browser = request.element;
    let prompts = browser?.ownerDocument?.defaultView?.PermissionPrompts;
    if (!spec || !prompts) {
      request.cancel();
      return;
    }

    let { perms } = Services;
    let principal = request.principal;
    if (spec.permission) {
      let stored = perms.testExactPermissionFromPrincipal(principal, spec.permission);
      if (stored == perms.ALLOW_ACTION) {
        request.allow();
        return;
      }
      if (stored == perms.DENY_ACTION) {
        request.cancel();
        return;
      }
    }
    // Notification prompts that appear on their own as a page loads are
    // almost always spam; Firefox drops them the same way.
    if (spec.needsGesture && !request.hasValidTransientUserGestureActivation) {
      request.cancel();
      return;
    }

    prompts.request({
      kind: type,
      browser,
      principal,
      topLevelPrincipal: request.topLevelPrincipal,
      canRemember: !!spec.permission,
      respond: (allow, { remember = false, dismissed = false } = {}) => {
        if (spec.permission && !dismissed && (remember || !allow)) {
          perms.addFromPrincipal(
            principal,
            spec.permission,
            allow ? perms.ALLOW_ACTION : perms.DENY_ACTION,
            remember ? perms.EXPIRE_NEVER : perms.EXPIRE_SESSION
          );
        }
        if (!allow) {
          request.cancel();
        } else if (type == "storage-access") {
          request.allow({ "storage-access": "allow" });
        } else {
          request.allow();
        }
      },
    });
  }
}
