# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

settings-page-title = Settings
settings-heading = Settings
settings-privacy-heading = Privacy
settings-restart-needed = Some changes take effect after a restart.
settings-restart = Restart now
settings-startup-heading = When { -brand-short-name } starts
settings-startup-newtab = Open a new tab
settings-startup-restore = Continue where you left off
settings-startup-help = After a crash your tabs always come back. You can also bring them back from the menu with “Restore previous session”.
settings-search-heading = Search
settings-search-engine = Search with
settings-downloads-heading = Downloads
settings-downloads-folder = Save files to
settings-downloads-change = Change…
settings-downloads-picker-title = Choose a downloads folder
settings-downloads-ask-label = Ask where to save each file
settings-downloads-ask-help = When off, files go straight to the folder above.
settings-appearance-heading = Appearance
settings-appearance-auto = Automatic
settings-appearance-light = Light
settings-appearance-dark = Dark
settings-about-heading = About
# $version (String) - app version; $gecko (String) - engine version
settings-about-version = { -brand-full-name } { $version }, Gecko { $gecko }
settings-about-lists = Ad and tracker blocking uses EasyList, EasyPrivacy and Fanboy’s Social Blocking List by the EasyList authors, under CC BY-SA 3.0. The lists ship with the browser and are never downloaded.
settings-about-youtube = “Block YouTube ads” uses the YouTube rules of uBlock Origin’s filter lists, by Raymond Hill and the uBlock Origin contributors, under GPLv3. They are downloaded only while it is on.

## YouTube ads

settings-youtube-heading = YouTube
settings-youtube-ads-label = Block YouTube ads
settings-youtube-ads-help = Uses uBlock Origin’s YouTube rules, which are downloaded while this is on. They apply to YouTube pages opened or reloaded after a download. Off by default.
settings-youtube-ads-disclaimer = YouTube changes how it shows ads every few days, so { -brand-short-name } can’t block them with lists that ship with the browser. Turning this on downloads uBlock Origin’s filter lists from ublockorigin.github.io (GitHub) now, and again every 8 hours while it’s on. The downloads carry no cookies or browsing data, but GitHub sees your IP address and when you download. Only the rules for YouTube are kept, and they run only on YouTube pages, where they can change how the site works. YouTube may still show an ad or a warning at times.
settings-youtube-ads-accept = Download rules and turn on
settings-youtube-ads-cancel = Cancel
settings-youtube-ads-updating = Downloading rules…
# $updated (Number) - when the rules were downloaded
settings-youtube-ads-ready = Rules downloaded { DATETIME($updated, dateStyle: "medium", timeStyle: "short") }.
settings-youtube-ads-error = The rules couldn’t be downloaded, so YouTube ads aren’t blocked yet. { -brand-short-name } tries again every hour.
# $updated (Number) - when the rules in use were downloaded
settings-youtube-ads-error-old = The rules couldn’t be updated. Those from { DATETIME($updated, dateStyle: "medium", timeStyle: "short") } are still used, and { -brand-short-name } tries again every hour.
settings-youtube-ads-update = Update now

## Search suggestions and history

settings-search-suggest-label = Show search suggestions
# $engine: the search engine's name
settings-search-suggest-help = What you type in the address bar is sent to { $engine } as you type, never addresses. Off by default.
settings-search-suggest-none = { $engine } doesn’t offer suggestions.
settings-history-heading = History
settings-history-remember-label = Remember browsing history
settings-history-remember-help = Pages you visit are kept on this computer, for the address bar and the History page. Strict Privacy and Anonymous turn this off.
settings-history-clear-label = Clear what’s kept
settings-history-clear = Clear history…
settings-history-open = Show history
