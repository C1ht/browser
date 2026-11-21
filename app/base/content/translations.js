/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Page translation in the window: the address bar's translate button and
 * its panel (components/translations has the rest). Toolkit's
 * TranslationsParent actor detects each page's language and translates it;
 * this shows its state.
 *
 * The button shows when a page is in a language other than the user's that
 * can be translated, and while a page is translated (with the language it's
 * in now). The app menu's "Translate page" opens the panel on any page. The
 * panel's views:
 *   offer        from and to, and the size of what downloads first
 *   translating  the engine starting, and the download's progress
 *   translated   from and to, to change them, and Show original
 *   error        the same as offer, with what went wrong
 */

ChromeUtils.defineESModuleGetters(this, {
  PageTranslations: "resource://gre/modules/browserwip/PageTranslations.sys.mjs",
  TranslationsParent: "resource://gre/actors/TranslationsParent.sys.mjs",
});

var PageTranslationsUI = {
  init() {
    let $ = id => document.getElementById(id);
    this.button = $("translations-button");
    this.buttonLocale = $("translations-button-locale");
    this.panel = $("translations-panel");
    this.title = $("translations-title");
    this.status = $("translations-status");
    this.languages = $("translations-languages");
    this.from = $("translations-from");
    this.to = $("translations-to");
    this.note = $("translations-note");
    this.original = $("translations-original");
    this.cancel = $("translations-cancel");
    this.translateButton = $("translations-translate");
    this.menuItem = $("app-menu-translate");

    this.button.addEventListener("click", () => this.openPanel());
    this.menuItem.addEventListener("command", () => this.openPanel());
    $("translations-form").addEventListener("submit", e => {
      e.preventDefault();
      this._translate();
    });
    this.original.addEventListener("click", () => {
      this._actor()?.restorePage();
      this.panel.hidePopup();
    });
    this.cancel.addEventListener("click", () => this.panel.hidePopup());
    for (let select of [this.from, this.to]) {
      select.addEventListener("change", () => this._updatePanel());
    }
    this.panel.addEventListener("popuphidden", () => {
      this._forced = false;
      this._closeWhenReady = false;
      this.update();
    });

    // From every page's actor; only the selected tab's shows. An actor
    // sends its first state while it's being created, when asking for it
    // would create another: update once that's done.
    window.addEventListener("TranslationsParent:LanguageState", e => {
      if (e.target == gBrowser.selectedBrowser) {
        queueMicrotask(() => this.update());
      }
    });
    // Toolkit identifies a page's language when the page's actor is
    // created, which is when something asks for it. Firefox's window asks
    // on each page load, as this does, in every tab.
    gBrowser.tabContainer.addEventListener("TabLocationChange", e => {
      let webProgress = e.target.linkedBrowser.browsingContext?.webProgress;
      if (!e.detail?.sameDocument && webProgress && PageTranslations.enabled) {
        TranslationsParent.onLocationChange(window, e.target.linkedBrowser.currentURI, webProgress, 0);
      }
      // The new page's state, not the last one's, until it has its own.
      if (e.target == gBrowser.selectedTab) {
        this.update();
      }
    });
    gBrowser.tabContainer.addEventListener("TabSelect", () => {
      this.panel.hidePopup();
      this.update();
    });
    let onProgress = () => {
      if (this.panel.state == "open") {
        this._updatePanel();
      }
    };
    let onPref = () => {
      if (!PageTranslations.enabled) {
        this.panel.hidePopup();
      }
      this.update();
    };
    Services.obs.addObserver(onProgress, PageTranslations.PROGRESS_TOPIC);
    Services.prefs.addObserver(PageTranslations.ENABLED_PREF, onPref);
    window.addEventListener(
      "unload",
      () => {
        Services.obs.removeObserver(onProgress, PageTranslations.PROGRESS_TOPIC);
        Services.prefs.removeObserver(PageTranslations.ENABLED_PREF, onPref);
      },
      { once: true }
    );
    this.update();
  },

  // The selected page's actor, or null: translation off, or a page it
  // doesn't serve (the browser's own pages).
  _actor(browser = gBrowser.selectedBrowser) {
    if (!PageTranslations.enabled) {
      return null;
    }
    try {
      return browser.browsingContext?.currentWindowGlobal?.getActor("Translations") ?? null;
    } catch (e) {
      return null;
    }
  },

  _state() {
    // An actor still starting up has no state yet.
    let languageState = this._actor()?.languageState;
    if (!languageState) {
      return null;
    }
    let { detectedLanguages, requestedLanguagePair, error, isEngineReady } = languageState;
    return { detectedLanguages, requestedLanguagePair, error, isEngineReady };
  },

  _displayName(langTag) {
    try {
      return TranslationsParent.createLanguageDisplayNames().of(langTag);
    } catch (e) {
      return langTag;
    }
  },

  /** The button and the app menu item, for the selected tab. */
  update() {
    let state = this._state();
    this.menuItem.hidden = !PageTranslations.enabled;
    this.menuItem.disabled = !state;
    let detected = state?.detectedLanguages;
    let offer =
      !!detected?.docLangTag &&
      !!detected.userLangTag &&
      detected.isDocLangTagSupported &&
      detected.docLangTag != detected.userLangTag &&
      TranslationsParent.getIsTranslationsEngineSupported();
    let pair = state?.requestedLanguagePair;
    this.button.hidden = !state || !(offer || pair || state.error || this._forced);
    this.button.toggleAttribute("translated", !!pair);
    this.button.toggleAttribute("loading", !!pair && !state.isEngineReady && !state.error);
    this.buttonLocale.textContent = pair ? pair.targetLanguage.split("-")[0] : "";
    if (pair) {
      document.l10n.setAttributes(this.button, "translations-button-translated", {
        from: this._displayName(pair.sourceLanguage),
        to: this._displayName(pair.targetLanguage),
      });
    } else {
      document.l10n.setAttributes(this.button, "translations-button");
    }
    if (this.panel.state == "open") {
      if (this._closeWhenReady && pair && state.isEngineReady) {
        this.panel.hidePopup();
      } else {
        this._updatePanel();
      }
    }
  },

  /** Opens the panel for the selected tab (the button, or the app menu). */
  async openPanel() {
    if (!this._actor()) {
      return;
    }
    this._forced = true;
    this.update();
    await this._fillLanguages();
    this._updatePanel();
    this.panel.openPopup(this.button, "bottomright topright", 0, 4);
  },

  // The language lists, with the page's language and the user's chosen.
  async _fillLanguages() {
    let { sourceLanguages, targetLanguages } = await TranslationsParent.getSupportedLanguages();
    let state = this._state();
    let pair = state?.requestedLanguagePair;
    let detected = state?.detectedLanguages;
    let source = pair?.sourceLanguage ?? (detected?.isDocLangTagSupported ? detected.docLangTag : "");
    let target =
      pair?.targetLanguage ??
      (detected?.userLangTag && detected.userLangTag != source
        ? detected.userLangTag
        : await TranslationsParent.getTopPreferredSupportedToLang({ excludeLangTags: [source] }));
    let fill = (select, languages, value) => {
      select.textContent = "";
      if (!value) {
        // Unknown: a choice to make first.
        let choose = document.createElement("option");
        choose.value = "";
        document.l10n.setAttributes(choose, "translations-choose");
        select.append(choose);
      }
      for (let { langTag, displayName } of languages) {
        select.append(new Option(displayName, langTag));
      }
      select.value = value ?? "";
    };
    fill(this.from, sourceLanguages, source);
    fill(this.to, targetLanguages, target);
  },

  async _updatePanel() {
    let state = this._state();
    if (!state) {
      this.panel.hidePopup();
      return;
    }
    let { requestedLanguagePair: pair, error, isEngineReady } = state;
    if (!this.from.value && state.detectedLanguages?.isDocLangTagSupported) {
      // Opened before the page's language was known; it is now.
      await this._fillLanguages();
    }
    let view = error ? "error" : pair && !isEngineReady ? "translating" : pair ? "translated" : "offer";
    this.panel.setAttribute("view", view);
    let from = this.from.value;
    let to = this.to.value;
    let chosen = !!from && !!to && from != to;
    let changed = !pair || pair.sourceLanguage != from || pair.targetLanguage != to;

    let l10n = document.l10n;
    if (view == "translating") {
      l10n.setAttributes(this.title, "translations-translating", { to: this._displayName(pair.targetLanguage) });
    } else if (view == "translated") {
      l10n.setAttributes(this.title, "translations-translated", {
        from: this._displayName(pair.sourceLanguage),
        to: this._displayName(pair.targetLanguage),
      });
    } else if (view == "error") {
      l10n.setAttributes(this.title, "translations-error");
    } else {
      l10n.setAttributes(this.title, "translations-offer");
    }

    let { received, total } = PageTranslations.progress;
    this.status.hidden = view != "translating" && view != "error";
    if (view == "error") {
      l10n.setAttributes(this.status, error == "engine-load-failure" ? "translations-error-load" : "translations-error-other");
    } else if (total) {
      l10n.setAttributes(this.status, "translations-downloading", {
        received: Math.round(received / 1e5) / 10,
        total: Math.round(total / 1e5) / 10,
      });
    } else {
      l10n.setAttributes(this.status, "translations-starting");
    }

    this.languages.hidden = view == "translating";
    this.original.hidden = !pair;
    this.cancel.hidden = !!pair;
    this.translateButton.hidden = view == "translating" || (view == "translated" && !changed);
    this.translateButton.disabled = !chosen;
    l10n.setAttributes(this.translateButton, view == "error" ? "translations-try-again" : "translations-translate");

    // What translating downloads first, if anything.
    this.note.hidden = view == "translating" || !chosen || !changed;
    if (!this.note.hidden) {
      let { missing } = await PageTranslations.pairSize(from, to);
      if (this.from.value != from || this.to.value != to) {
        return;
      }
      if (missing) {
        l10n.setAttributes(this.note, "translations-note-download", { size: Math.max(1, Math.round(missing / 1e6)) });
      } else {
        l10n.setAttributes(this.note, "translations-note-ready");
      }
    }
  },

  _translate() {
    let actor = this._actor();
    let sourceLanguage = this.from.value;
    let targetLanguage = this.to.value;
    if (!actor || !sourceLanguage || !targetLanguage || sourceLanguage == targetLanguage) {
      return;
    }
    actor.translate({ sourceLanguage, targetLanguage }, false);
    // Open while the files download and the engine starts; closes when
    // the page is translated.
    this._closeWhenReady = true;
    this._updatePanel();
  },
};
