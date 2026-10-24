# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Privacy modes, shared by the first-run screen and Settings

privacy-modes-group =
    .aria-label = Privacy level
privacy-mode-recommended = Recommended
privacy-mode-standard-name = Standard
privacy-mode-standard-description = Strong protection that stays out of your way. Sites learn little about your device, and video calls, streaming and sign-ins work as you expect.
privacy-mode-strict-name = Strict Privacy
privacy-mode-strict-description = Also turns off features sites can misuse, and doesn’t keep your browsing history. Some sites will be slower, and a few may not work.
privacy-mode-anonymous-name = Anonymous
privacy-mode-anonymous-description = Makes { -brand-short-name } look the same as other privacy browsers, so sites can’t tell you apart. Sites show times in UTC and pages in English, pages get margins around them, calls are off, and no history is kept.
privacy-mode-custom = You’re using a custom mix of the settings below.

## Switches. Each has a -label and a -help string.

privacy-toggle-jit-label = Fast JavaScript
privacy-toggle-jit-help = Turning this off makes it harder for attackers to exploit bugs, but script-heavy sites get slower.
privacy-toggle-webrtc-label = Share local network details in calls
privacy-toggle-webrtc-help = When off, calls only see your public address. Some calls may fail to connect.
privacy-toggle-timezone-label = Report time zone as UTC
privacy-toggle-timezone-help = Hides your time zone. Clocks and calendars on websites may show the wrong time.
privacy-toggle-https-only-label = Only connect over HTTPS
privacy-toggle-https-only-help = Asks before opening any page that isn’t encrypted, such as some routers and printers.
privacy-toggle-storage-heuristics-label = Let sign-in pages share data automatically
privacy-toggle-storage-heuristics-help = When off, some sign-in pages ask before they can use data from another site.
privacy-toggle-social-label = Block social media widgets
privacy-toggle-social-help = Blocks like buttons and embedded posts from social networks on other sites.
privacy-toggle-history-label = Remember browsing history
privacy-toggle-history-help = When off, pages you visit aren’t kept, and the address bar suggests only bookmarks. History kept before stays until you clear it.
privacy-toggle-webrtc-off-label = Allow video and voice calls
privacy-toggle-webrtc-off-help = When off, websites can’t make calls at all.
privacy-toggle-rfp-label = Look like everyone else
privacy-toggle-rfp-help = Sites see the same screen size, fonts, time zone and other details as every other privacy browser. Pages always appear in light colors.
privacy-toggle-english-label = Ask sites for English pages
privacy-toggle-english-help = Hides your language. Only applies while “Look like everyone else” is on.
privacy-toggle-letterboxing-label = Add margins around pages
privacy-toggle-letterboxing-help = Sizes pages in fixed steps, so sites can’t learn the size of your window.
privacy-toggle-referrer-label = Hide where you came from
privacy-toggle-referrer-help = Other sites aren’t told which site linked to them. Some payment and sign-in pages may not work.
privacy-toggle-restart-note = Takes effect after you restart { -brand-short-name }.
