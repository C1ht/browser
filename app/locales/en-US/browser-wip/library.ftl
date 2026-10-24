# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## about:history and about:bookmarks

library-cancel = Cancel

## History

history-page-title = History
history-heading = History
history-search =
    .placeholder = Search history
    .aria-label = Search history
history-clear = Clear history…
history-off = History is off: pages you visit aren’t kept. Strict Privacy and Anonymous turn it off; what’s below was kept before.
history-turn-on = Turn on
history-today = Today
history-yesterday = Yesterday
history-more = Show more
history-empty = Pages you visit will show here.
# $query: what was searched for
history-no-results = Nothing in history matches “{ $query }”.
# $title: the page's title
history-entry-menu =
    .title = More for { $title }
    .aria-label = More for { $title }
history-delete-page = Delete from history
# $host: a site, like example.com
history-delete-site = Delete everything from { $host }
history-more-from-site = More from { $host }
history-clear-title = Clear history
history-clear-range =
    .aria-label = Time range
history-clear-hour = Last hour
history-clear-today = Today
history-clear-all = Everything
history-clear-text = Pages visited in that time are forgotten. Bookmarks, passwords, cookies and downloads stay.
history-clear-submit = Clear

## Bookmarks

bookmarks-page-title = Bookmarks
bookmarks-heading = Bookmarks
bookmarks-search =
    .placeholder = Search bookmarks
    .aria-label = Search bookmarks
bookmarks-new-folder = New folder
bookmarks-new-folder-name = New folder
bookmarks-more-actions =
    .title = More
    .aria-label = More
bookmarks-import = Import from a file…
bookmarks-export = Export to a file…
bookmarks-show-bar = Show bookmarks bar
bookmarks-hide-bar = Hide bookmarks bar
bookmarks-folders =
    .aria-label = Folders
bookmarks-folder-bar = Bookmarks bar
bookmarks-folder-other = Other bookmarks
# $query: what was searched for
bookmarks-results = Results for “{ $query }”
bookmarks-no-results = No bookmarks match “{ $query }”.
bookmarks-folder-is-empty = This folder is empty.
# $title: the bookmark's or folder's name
bookmarks-entry-menu =
    .title = More for { $title }
    .aria-label = More for { $title }
bookmarks-edit = Edit
bookmarks-delete = Delete
bookmarks-edit-name = Name
bookmarks-edit-url = Address
bookmarks-edit-folder = Folder
bookmarks-edit-save = Save
bookmarks-edit-bad-url = That isn’t a web address.
bookmarks-delete-folder-title = Delete folder?
# $name: the folder's name
bookmarks-delete-folder-text = “{ $name }” and everything in it will be deleted.
bookmarks-import-title = Import bookmarks
bookmarks-export-title = Export bookmarks
# $count: how many bookmarks
bookmarks-imported = { $count ->
    [one] Imported 1 bookmark.
   *[other] Imported { $count } bookmarks.
  }
bookmarks-import-failed = That file couldn’t be imported. Bookmarks files from Firefox, Chrome, Edge and Safari (HTML) work.
# $count: how many bookmarks; $file: the file's name
bookmarks-exported = { $count ->
    [one] Exported 1 bookmark to { $file }.
   *[other] Exported { $count } bookmarks to { $file }.
  }
bookmarks-export-failed = The bookmarks couldn’t be exported.
