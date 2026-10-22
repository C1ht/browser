/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The parent half of the stand-in for toolkit's LoginManager actor; see
 * LoginManagerStubChild.sys.mjs. AutoCompleteParent calls this method
 * whenever a dropdown opens.
 */

export class LoginManagerStubParent extends JSWindowActorParent {
  maybeRecordPasswordGenerationShownTelemetryEvent() {}
}

// Gecko looks the class up by the actor's name: "LoginManager" + "Parent".
export { LoginManagerStubParent as LoginManagerParent };
