# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

settings-page-title = Settings
settings-heading = Settings
settings-search-field =
    .placeholder = Search settings
    .aria-label = Search settings
# $query (String) - what was typed in the search field
settings-search-empty = No settings match “{ $query }”
settings-nav-general = General
settings-nav-search = Search and history
settings-privacy-intro = Choose how much websites can learn about you. Each setting can also be changed on its own below, which makes a custom mix.
settings-privacy-group-connections = Connections and calls
settings-privacy-group-tracking = Tracking
settings-privacy-group-fingerprinting = Fingerprinting
settings-privacy-group-security = Security
settings-blocking-heading = Ads and trackers
settings-blocking-always-label = Ads and trackers are blocked on every site
settings-blocking-always-help = With EasyList and EasyPrivacy, built in and never downloaded. To allow one site, turn off its protections with the shield in the address bar.
settings-blocking-pages-label = Block scam and pop-up pages
settings-blocking-pages-help = Pages on EasyList’s list of scam, pop-up and pop-under sites show a warning instead. You can still open them from there.
settings-passwords-group-unlock = Saving and unlocking
settings-passwords-group-keep = Recovery and backups
settings-privacy-heading = Privacy
settings-restart-needed = Some changes take effect after a restart.
settings-restart = Restart now
settings-startup-heading = When { -brand-short-name } starts
settings-startup-newtab = Open a new tab
settings-startup-restore = Continue where you left off
settings-startup-help = After a crash your tabs always come back. You can also bring them back from the menu with “Restore previous session”.
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
settings-about-name = { -brand-full-name }
# $version (String) - app version; $gecko (String) - engine version
settings-about-version = Version { $version } · Gecko { $gecko }
settings-dev-builds-label = Check for new dev builds
settings-dev-builds-help = Once a day, asks GitHub whether a newer dev build is out. Contacts github.com; nothing is downloaded.
settings-dev-builds-help-mode = Off in Strict privacy and Anonymous.
settings-dev-builds-now = Check now
settings-dev-builds-open = Open its page
settings-dev-builds-checking = Checking…
# $tag: this build's release, e.g. dev-20261105-360e538.
settings-dev-builds-this = This is dev build { $tag }.
# $checked: when GitHub was last asked.
settings-dev-builds-current = This is the newest dev build. Checked { DATETIME($checked, month: "short", day: "numeric", hour: "numeric", minute: "numeric") }.
# $date: when the newer build was published.
settings-dev-builds-newer = A newer dev build is out, from { DATETIME($date, month: "short", day: "numeric") }.
settings-dev-builds-failed = Couldn’t reach GitHub. Try again later.
settings-dev-builds-unpublished = This browser wasn’t installed from a published dev build, so there’s nothing to compare it with.
settings-about-lists-title = Ad and tracker lists
settings-about-lists = EasyList, EasyPrivacy and Fanboy’s Social Blocking List, by the EasyList authors, under CC BY-SA 3.0. Included with the browser, never downloaded.
# $date (Number) - when the included lists were taken
settings-about-lists-snapshot = Snapshot from { DATETIME($date, dateStyle: "long") }.
settings-about-youtube-title = YouTube rules
settings-about-youtube = uBlock Origin’s filter lists, by Raymond Hill and the uBlock Origin contributors, under GPLv3. Downloaded only while “Block YouTube ads” is on.
settings-about-font-title = Font
settings-about-font = Instrument Sans, under the SIL Open Font License 1.1.

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
