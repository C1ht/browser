# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

newtab-page-title = New Tab
newtab-calm = Search or type an address above.
# $engine (String) - the search engine's name, e.g. "Brave Search"
newtab-search =
    .placeholder = Search with { $engine } or enter an address
    .aria-label = Search with { $engine } or enter an address
newtab-search-section = Search bar

## Sections

newtab-favorites = Favorites
newtab-report = Privacy report
newtab-show-more = Show more
newtab-show-less = Show less
newtab-favorites-empty = Sites on your bookmarks bar show up here. Imported ones show a letter until you visit them.
newtab-import-bookmarks = Import bookmarks…
newtab-import-title = Import bookmarks
# $count (Number) - how many bookmarks were imported
newtab-imported =
    { $count ->
        [one] Imported 1 bookmark.
       *[other] Imported { $count } bookmarks.
    }
# $count (Number) - how many bookmarks were imported
newtab-imported-none-on-bar =
    { $count ->
        [one] Imported 1 bookmark, not on a bookmarks bar. Move it there from Bookmarks to see it here.
       *[other] Imported { $count } bookmarks, none on a bookmarks bar. Move some there from Bookmarks to see them here.
    }
newtab-import-failed = That file couldn’t be imported. Bookmarks files from Firefox, Chrome, Edge and Safari (HTML) work.

## Privacy report: what the blocker stopped in the last 7 days

# $trackers (Number) - trackers blocked; $pages (Number) - pages they were blocked on
newtab-report-summary =
    { $trackers ->
        [0] No trackers blocked in the last 7 days.
        [one] tracker blocked in the last 7 days, on { $pages ->
            [one] 1 page.
           *[other] { $pages } pages.
        }
       *[other] trackers blocked in the last 7 days, on { $pages ->
            [one] 1 page.
           *[other] { $pages } pages.
        }
    }
newtab-report-mode-standard = Standard privacy. Ads and trackers are blocked on every site.
newtab-report-mode-strict = Strict Privacy. Ads and trackers are blocked, and features sites can misuse are off.
newtab-report-mode-anonymous = Anonymous. Ads and trackers are blocked, and you look like everyone else.
newtab-report-mode-custom = Your own mix of privacy settings. Ads and trackers are blocked on every site.

## Customize

newtab-customize = Customize
newtab-customize-sections = Show on new tabs
newtab-customize-background = Background
newtab-background-plain =
    .title = Plain
    .aria-label = Plain
newtab-background-glow =
    .title = Glow
    .aria-label = Glow
newtab-background-dusk =
    .title = Dusk
    .aria-label = Dusk
newtab-background-meadow =
    .title = Meadow
    .aria-label = Meadow
newtab-background-sand =
    .title = Sand
    .aria-label = Sand
