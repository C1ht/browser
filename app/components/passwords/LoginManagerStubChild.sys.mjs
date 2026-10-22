/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Stands in for toolkit's LoginManager actor, which BrowserWipGlue
 * unregisters so that Firefox's password manager never runs in pages: it
 * would fill forms as they load and keep logins in Firefox's store, beside
 * their key.
 *
 * Toolkit code still asks for an actor by that name, and throws without
 * one: AutoCompleteChild for every password field, FormHistoryChild on every
 * form submission (form history would stop being saved) and
 * AutoCompleteParent whenever a dropdown opens. This one says that no field
 * is the password manager's and offers nothing. It listens to no events and
 * sends nothing.
 */

// An autocomplete result with no entries, so that a search on a password
// field completes instead of staying open.
class EmptyResult {
  QueryInterface = ChromeUtils.generateQI(["nsIAutoCompleteResult"]);

  constructor(searchString) {
    this.searchString = searchString;
  }

  searchResult = Ci.nsIAutoCompleteResult.RESULT_NOMATCH;
  defaultIndex = -1;
  errorDescription = "";
  matchCount = 0;

  getValueAt() {
    throw Components.Exception("", Cr.NS_ERROR_ILLEGAL_VALUE);
  }

  getLabelAt = this.getValueAt;
  getCommentAt = this.getValueAt;
  getStyleAt = this.getValueAt;
  getImageAt = this.getValueAt;
  getFinalCompleteValueAt = this.getValueAt;

  isRemovableAt() {
    return false;
  }

  removeValueAt() {}
}

export class LoginManagerStubChild extends JSWindowActorChild {
  get actorName() {
    return "LoginManager";
  }

  isLoginManagerField() {
    return false;
  }

  shouldSearchForAutoComplete() {
    return false;
  }

  getAutoCompleteSearchOption() {
    return null;
  }

  searchResultToAutoCompleteResult(searchString) {
    return new EmptyResult(searchString);
  }
}
