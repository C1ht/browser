# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Window

browser-main-window-title = { -brand-full-name }
# $title (String) - title of the page in the selected tab
browser-main-window-title-page = { $title } — { -brand-full-name }

## Toolbar

nav-bar =
    .aria-label = Navigation
back-button =
    .title = Back (Alt+Left)
    .aria-label = Back
forward-button =
    .title = Forward (Alt+Right)
    .aria-label = Forward
reload-button =
    .title = Reload (Ctrl+R)
    .aria-label = Reload
stop-button =
    .title = Stop loading
    .aria-label = Stop
app-menu-button =
    .title = Menu
    .aria-label = Menu
downloads-button =
    .title = Downloads (Ctrl+J)
    .aria-label = Downloads

## Window controls (Windows)

window-minimize =
    .title = Minimize
    .aria-label = Minimize
window-maximize =
    .title = Maximize
    .aria-label = Maximize
window-restore =
    .title = Restore down
    .aria-label = Restore down
window-close =
    .title = Close
    .aria-label = Close

## Address field

urlbar-input =
    .placeholder = Search or enter address
    .aria-label = Search or enter address
identity-button-secure =
    .title = Site information
    .aria-label = Site information
identity-button-insecure =
    .title = Your connection to this site is not encrypted
    .aria-label = Not secure. Site information
identity-not-secure = Not secure
sharing-button =
    .title = This site is using your camera or microphone
    .aria-label = Camera or microphone in use
# $count (Number) - trackers and ads blocked on the page
protections-button =
    .title =
        { $count ->
            [0] Protections are on for this site
            [one] 1 tracker or ad blocked
           *[other] { $count } trackers and ads blocked
        }
    .aria-label = Protections

## Tabs

tab-strip =
    .aria-label = Tabs
new-tab-button =
    .title = New tab (Ctrl+T)
    .aria-label = New tab
tab-close-button =
    .title = Close tab
    .aria-label = Close tab
tab-new-tab-label = New Tab

## Tab context menu

tab-context-reload =
    .label = Reload
tab-context-duplicate =
    .label = Duplicate tab
tab-context-pin =
    .label = Pin tab
tab-context-unpin =
    .label = Unpin tab
tab-context-mute =
    .label = Mute tab
tab-context-unmute =
    .label = Unmute tab
tab-context-close =
    .label = Close tab
tab-context-close-others =
    .label = Close other tabs
tab-context-reopen =
    .label = Reopen closed tab

## Menu

app-menu-new-tab =
    .label = New tab
app-menu-new-window =
    .label = New window
app-menu-downloads =
    .label = Downloads
app-menu-settings =
    .label = Settings
app-menu-quit =
    .label = Quit

## Downloads panel

downloads-title = Downloads
downloads-empty = No downloads yet.
downloads-open-folder = Open downloads folder
downloads-clear = Clear list
# $current, $total, $speed (String) - sizes such as "4.2 MB"
download-status-progress = { $current } of { $total }
download-status-progress-speed = { $current } of { $total } · { $speed }/s
download-status-unknown = { $current }
# $size (String) - e.g. "4.2 MB"; $host (String) - the site it came from
download-status-done = { $size }
download-status-done-host = { $size } · { $host }
download-status-failed = Failed
download-status-canceled = Canceled
download-status-missing = File moved or deleted
download-action-cancel =
    .title = Cancel
    .aria-label = Cancel download
download-action-retry =
    .title = Try again
    .aria-label = Try download again
download-action-show =
    .title = Show in folder
    .aria-label = Show in folder

## Protections panel

# $host (String) - the site, e.g. "example.com"
protections-title = Protections for { $host }
# $count (Number) - trackers and ads blocked on this page
# $mode (String) - "standard", "strict", "anonymous" or "custom"
protections-summary-on =
    { $count ->
        [0] Nothing to block on this page so far.
        [one] Blocked 1 tracker or ad on this page.
       *[other] Blocked { $count } trackers and ads on this page.
    } { $mode ->
        [strict] Strict Privacy is on.
        [anonymous] Anonymous mode is on.
        [custom] You’re using custom privacy settings.
       *[standard] Standard privacy is on.
    }
protections-summary-off = Protections are off for this site. Trackers and ads can load.
protections-toggle-label = Protections for this site
protections-toggle-help = Turn this off if the site doesn’t work properly. The page reloads.
protections-open-settings = Privacy settings

## Site information panel

identity-title = { $host }
identity-summary-secure = Your connection to this site is encrypted.
identity-summary-insecure = Your connection to this site is not encrypted. Don’t enter passwords or card numbers here.
