# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## The key button in the address field

passwords-button =
    .title = Passwords
    .aria-label = Passwords
passwords-button-pending =
    .title = A login is waiting to be saved
    .aria-label = Passwords: a login is waiting to be saved

## Save and update. $site (String) - the site, e.g. example.com;
## $host (String) - the full host, e.g. accounts.example.com

passwords-save-title = Save login for <strong>{ $site }</strong>?
passwords-update-title = Update password for <strong>{ $site }</strong>?
passwords-save-where = { $host } · stored encrypted on this device
passwords-username-label = Username
passwords-username-none =
    .placeholder = No username
passwords-password-label = Password
passwords-show-password =
    .title = Show password
    .aria-label = Show password
passwords-hide-password =
    .title = Hide password
    .aria-label = Hide password
passwords-more-options =
    .title = More options
    .aria-label = More options
passwords-save = Save
passwords-update = Update
passwords-not-now = Not now
passwords-never-for-site =
    .label = Never for this site
passwords-manage =
    .label = Manage passwords
passwords-saved-title = Login saved
passwords-saved-generated = The new password for { $host } was saved.
passwords-undo = Undo

## Unlock. $host (String) - the site the user is on

passwords-unlock-title = Unlock passwords
passwords-unlock-to-fill = To sign in on { $host }.
passwords-unlock-to-save = To save the login for { $host }.
passwords-unlock-general = Your saved passwords are encrypted on this device.
passwords-master-password =
    .placeholder = Master password
    .aria-label = Master password
passwords-unlock = Unlock
passwords-unlocking = Unlocking…
passwords-wrong-password = That isn’t the master password.
passwords-forgot = Forgot password?
# $minutes (Number)
passwords-locks-after = Locks after { $minutes } min idle

## Setup, from the first Save

passwords-setup-title = Choose a master password
passwords-setup-intro = It encrypts your saved passwords on this device. Nobody can recover it if you forget it, not even { -brand-short-name }.
passwords-setup-password =
    .placeholder = Master password, 12 characters or more
    .aria-label = Master password
passwords-setup-confirm =
    .placeholder = Type it again
    .aria-label = Type the master password again
passwords-setup-where = Only { -brand-short-name } itself asks for it: under the key in the address field, and on about:passwords. A website that asks for it isn’t { -brand-short-name }.
passwords-setup-create = Create and save
passwords-setup-creating = Creating…
passwords-setup-cancel = Cancel
passwords-too-short = Use at least 12 characters.
passwords-mismatch = The two passwords don’t match.
passwords-error = Something went wrong. Your passwords weren’t changed.

## The site panel (key button, nothing waiting)

passwords-site-title = Passwords for { $site }
passwords-site-none = No logins saved for this site.
passwords-site-intro-title = Save passwords in { -brand-short-name }
passwords-site-intro = Sign in to a site and { -brand-short-name } offers to keep the login, encrypted on this device under a master password.
passwords-copy-username =
    .title = Copy username
    .aria-label = Copy username
passwords-copied = Copied
passwords-lock-now = Lock now
passwords-manage-link = Manage passwords

## Dropdown under login fields. $host, $top (String) - hosts

passwords-dropdown-label =
    .aria-label = Saved logins
passwords-dropdown-locked = Passwords are locked
passwords-dropdown-unlock = Unlock…
passwords-dropdown-iframe = Sign in to { $host } (inside { $top })
passwords-dropdown-saved-for = Saved for { $host }
passwords-dropdown-also-use = Click to fill · also use here
passwords-dropdown-no-username = (no username)
passwords-dropdown-generate = Use a strong password
passwords-dropdown-generate-note-standard = Saved when you create the account. Undo from the key in the address field.
passwords-dropdown-generate-note-strict = You’ll be asked to save it when you create the account.
passwords-dropdown-manage = Manage passwords

## about:passwords

passwords-page-title = Passwords
passwords-heading = Passwords
passwords-status-unlocked = Unlocked
passwords-status-locked = Locked
passwords-search =
    .placeholder = Search
    .aria-label = Search passwords
passwords-add = Add login
passwords-page-lock = Lock now
# $count (Number)
passwords-count =
    { $count ->
        [one] 1 login
       *[other] { $count } logins
    }
passwords-list =
    .aria-label = Saved logins
passwords-not-secure = Not secure
# $username (String)
passwords-wont-fill = { $username } · won’t be filled
passwords-no-username = (no username)
passwords-empty-title = No saved logins yet
passwords-empty-text = When you sign in to a site, { -brand-short-name } offers to keep the login here, encrypted on this device. You can also add one yourself.
# $query (String)
passwords-no-results = No logins match “{ $query }”.

## The selected login. $origin (String) - e.g. https://example.com;
## $site (String) - e.g. example.com

passwords-open-site = Open { $origin }
passwords-edit = Edit
passwords-delete = Delete
passwords-field-site = Site
passwords-field-username = Username
passwords-field-password = Password
passwords-field-also = Also fills on
passwords-field-history = History
passwords-also-add = Add a site of { $site }…
passwords-also-placeholder =
    .placeholder = https://login.{ $site }
passwords-also-add-button = Add
passwords-also-remove =
    .title = Remove { $origin }
    .aria-label = Remove { $origin }
passwords-also-wrong-site = Only another address of { $site } can be added.
passwords-copy = Copy
passwords-show = Show
passwords-hide = Hide
passwords-copied-short = Copied
# $created, $changed, $used (String) - dates
passwords-history = Saved { $created } · Password changed { $changed } · Last used { $used }
passwords-history-unused = Saved { $created } · Password changed { $changed } · Never used
passwords-reveal-note = Show and Copy ask for your master password, then not again for 5 minutes. Copied passwords clear from the clipboard after 30 seconds.
passwords-confirm-text = Enter your master password to continue.
passwords-confirm = Continue
passwords-cancel = Cancel
passwords-delete-confirm = Delete this login? This can’t be undone.
passwords-delete-yes = Delete
passwords-edit-title = Edit login
passwords-new-title = New login
passwords-site-placeholder =
    .placeholder = https://example.com
passwords-password-unchanged =
    .placeholder = Unchanged
passwords-password-required =
    .placeholder = Password
passwords-generate = Generate
passwords-save-changes = Save
passwords-site-invalid = Enter a web address, like https://example.com.
passwords-site-http = Plain http: the login is kept, but never filled.
passwords-password-missing = Enter the password.
passwords-duplicate = There’s already a login for this site with this username.

## Locked, setup and forgotten password

passwords-locked-title = Your passwords are locked
passwords-locked-text = Enter your master password to see and change them.
passwords-setup-page-title = Keep your passwords in { -brand-short-name }
passwords-setup-page-text = Choose a master password. It encrypts every saved login on this device, and nobody can recover it if you forget it.
passwords-setup-page-create = Create
passwords-forgot-title = Forgot your master password?
passwords-forgot-text = Nobody can recover it: there’s no server, no copy and no back door. If it comes back to you, unlock as usual. A recovery key and starting over with an empty vault are coming in a later version.
passwords-forgot-back = Back
passwords-protects-title = What this protects against
passwords-protects-text = Saved logins are encrypted on this device under a key made from your master password, so a copy of your profile or a stolen laptop reveals nothing. It can’t protect you from malware running as you while the passwords are unlocked: lock them when you’re done, or let them lock after a while without use.

## Settings › Passwords

settings-passwords-heading = Passwords
settings-passwords-none = Not set up yet.
# $count (Number)
settings-passwords-unlocked =
    { $count ->
        [one] Unlocked · 1 saved login
       *[other] Unlocked · { $count } saved logins
    }
settings-passwords-locked = Locked
settings-passwords-manage = Manage passwords
settings-passwords-lock = Lock now
settings-passwords-offer-label = Offer to save logins
settings-passwords-offer-help = After you sign in to a site.
settings-passwords-lock-after = Lock after this long without use
# $minutes (Number)
settings-passwords-minutes = { $minutes } min
settings-passwords-hour = 1 hour
settings-passwords-hours = 4 hours
settings-passwords-change = Change master password
settings-passwords-current =
    .placeholder = Current master password
    .aria-label = Current master password
settings-passwords-new =
    .placeholder = New master password, 12 characters or more
    .aria-label = New master password
settings-passwords-repeat =
    .placeholder = Type the new one again
    .aria-label = Type the new master password again
settings-passwords-change-button = Change
settings-passwords-changed = Master password changed.
