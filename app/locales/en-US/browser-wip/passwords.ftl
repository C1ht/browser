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
passwords-forgot-text = Nobody can recover it: there’s no server, no copy and no back door. If it comes back to you, unlock as usual.
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
settings-passwords-transfer = Import or export passwords
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

## Import and export (about:passwords)

passwords-more-actions =
    .title = Import and export
    .aria-label = Import and export
passwords-menu-import = Import…
passwords-menu-export = Export…
passwords-menu-settings = Settings
passwords-close = Close

passwords-export-title = Export passwords
passwords-export-format =
    .aria-label = Format
passwords-export-encrypted = Encrypted file
passwords-export-csv = Plain text (CSV)
passwords-export-encrypted-text = A .bwv file that opens in { -brand-short-name } on Linux or Windows. It’s protected by a passphrase you choose now. Your keyring and Windows Hello aren’t included.
passwords-export-csv-warning = The file isn’t encrypted. Anyone or any program that can read it, including backups and sync folders, gets every password in it. Import it where you need it, then delete it.
passwords-export-master = Your master password
passwords-export-passphrase = Passphrase for the file, 12 characters or more
passwords-export-passphrase-again = Type it again
passwords-export-understand = I understand anyone who gets this file can read every password.
# $count (Number)
passwords-export-submit =
    { $count ->
        [one] Export 1 login…
       *[other] Export { $count } logins…
    }
passwords-export-submit-csv = Export as plain text…
passwords-export-file-title = Save passwords
# $count (Number), $path (String)
passwords-export-done =
    { $count ->
        [one] Exported 1 login to { $path }.
       *[other] Exported { $count } logins to { $path }.
    }

passwords-import-title = Import passwords
passwords-import-text = A CSV file from Firefox, Chrome, Bitwarden or KeePassXC, or an encrypted .bwv file exported from { -brand-short-name }.
passwords-import-choose = Choose file…
passwords-import-file-title = Import passwords
passwords-import-passphrase = Passphrase for this file
passwords-import-open = Open
passwords-import-continue = Continue
# $count (Number)
passwords-import-submit =
    { $count ->
        [0] Nothing to import
        [one] Import 1 login
       *[other] Import { $count } logins
    }
# $count (Number)
passwords-import-fresh =
    { $count ->
        [one] 1 new login
       *[other] { $count } new logins
    }
# $count (Number)
passwords-import-duplicates =
    { $count ->
        [one] 1 is already saved, with the same site and username. Choose which to keep:
       *[other] { $count } are already saved, with the same site and username. Choose which to keep:
    }
# $count (Number)
passwords-import-insecure =
    { $count ->
        [one] 1 is for a plain http site: it’s kept, but never filled.
       *[other] { $count } are for plain http sites: they’re kept, but never filled.
    }
# $count (Number)
passwords-import-skipped =
    { $count ->
        [one] 1 row isn’t a website login and is skipped.
       *[other] { $count } rows aren’t website logins and are skipped.
    }
# $count (Number)
passwords-import-repeated =
    { $count ->
        [one] 1 login appears twice in the file; the first is used.
       *[other] { $count } logins appear twice in the file; the first of each is used.
    }
passwords-import-keep-mine = Keep mine
passwords-import-use-imported = Use imported
passwords-import-choice =
    .aria-label = Which to keep
# $count (Number)
passwords-import-done =
    { $count ->
        [0] Nothing was imported.
        [one] Imported 1 login.
       *[other] Imported { $count } logins.
    }
passwords-import-wrong-passphrase = That isn’t this file’s passphrase.
passwords-import-bad-file = This file can’t be read. Import a CSV file or a .bwv file exported from { -brand-short-name }.
passwords-import-no-columns = This CSV file has no website and password columns.
passwords-import-newer = This file was made by a newer version of { -brand-short-name }.
passwords-import-empty = No logins found in this file.

## Windows Hello

passwords-use-hello = Use Windows Hello
passwords-hello-waiting = Waiting for Windows Hello…
passwords-or-master = or your master password
passwords-hello-failed = Windows Hello couldn’t unlock. Use your master password.
settings-passwords-hello-label = Unlock with Windows Hello
settings-passwords-hello-help = Face, fingerprint or PIN, backed by this computer’s security chip. It can also confirm showing and copying a password; exporting and changing settings still ask for the master password.
settings-passwords-hello-confirm = Turn on
settings-passwords-hello-master =
    .placeholder = Master password, to turn it on
    .aria-label = Master password
settings-passwords-hello-on = Windows Hello can now unlock your passwords.
settings-passwords-hello-cancelled = Windows Hello was cancelled. Nothing changed.
settings-passwords-hello-error = Windows Hello couldn’t be set up.

## Passphrase suggestion, recovery key, starting over

passwords-suggest-passphrase = Suggest a passphrase
passwords-suggested-note = Five random words. Write them down somewhere safe before you go on: this is the only time they’re shown.
passwords-setup-recovery = Also make a recovery key, in case you forget the master password
passwords-recovery-title = Your recovery key
passwords-recovery-text = It unlocks your passwords and sets a new master password if you forget yours. Print it or write it down, and keep it somewhere safe and offline.
passwords-recovery-keep = It’s shown only now. Anyone who has it can open your passwords on this computer.
passwords-recovery-print = Print
passwords-recovery-done = I’ve written it down
passwords-recover-title = Use your recovery key
passwords-recover-code =
    .placeholder = Recovery key (XXXX-XXXX-…)
    .aria-label = Recovery key
passwords-recover-password =
    .placeholder = New master password
    .aria-label = New master password
passwords-recover-submit = Set new master password
passwords-recover-wrong = That isn’t this vault’s recovery key.
passwords-recover-none = This vault has no recovery key.
passwords-start-over-title = Start over
passwords-start-over-text = A new, empty vault is set up. The old one is kept in your profile; if the password comes back to you, open it from Settings › Passwords › Open an older vault, and its logins are added back.
passwords-start-over-confirm =
    .placeholder = Type “start over” to confirm
    .aria-label = Type start over to confirm
passwords-start-over = Start over
passwords-older-title = Open an older vault
passwords-older-password = That vault’s master password
settings-passwords-recovery-label = Recovery key
settings-passwords-recovery-none = Not set up. Without one, a forgotten master password means starting over.
settings-passwords-recovery-set = Set up. Making a new one stops the old one from working.
settings-passwords-recovery-create = Make a recovery key
settings-passwords-recovery-replace = Make a new one
settings-passwords-recovery-master =
    .placeholder = Master password
    .aria-label = Master password
settings-passwords-recovery-confirm = Make it
settings-passwords-older = Open an older vault…
settings-passwords-older-help = Vaults kept by Start over. Opening one with its master password adds its logins back.

## Replace encryption key

settings-passwords-exposed = My old password may have been exposed (also replace the encryption key)
settings-passwords-replace-help = Replace the encryption key if you think someone may have copied your passwords file and learned a master password. Everything is encrypted again under a new key.
settings-passwords-replace = Replace encryption key
settings-passwords-replace-working = Encrypting everything again…
settings-passwords-replace-working-hello = Encrypting everything again… Windows Hello will ask twice.
settings-passwords-replace-code = Your new recovery key. It works once the replacement is done; keep your current one until then.
settings-passwords-replace-stored = I have stored it
settings-passwords-replace-cancelled = Windows Hello was cancelled. Nothing changed; try again, or turn Windows Hello off first.
settings-passwords-replaced = Replacement complete.
settings-passwords-replaced-recovery = Replacement complete. Your old recovery key no longer works and can be destroyed.
settings-passwords-replace-copies = Copies of your passwords saved before now, such as backups, still open with the password you used then.
settings-passwords-replace-aborted = Nothing changed.

## Password health (checked on this computer only)

passwords-health-ok = No reused or weak passwords
passwords-health-summary = { $reused ->
    [one] 1 reused
   *[other] { $reused } reused
  } · { $weak ->
    [one] 1 weak
   *[other] { $weak } weak
  }
passwords-health-reused-badge = Reused
passwords-health-weak-badge = Weak
passwords-health-reused = { $count ->
    [one] The same password is saved for another login. If one site leaks it, both accounts are open: change it on this site, with a generated one.
   *[other] The same password is saved for { $count } other logins. If one site leaks it, all of them are open: change it on this site, with a generated one.
  }
passwords-health-weak = This password is short or simple, so it’s easy to guess. Change it on this site, with a generated one.

## This computer only

settings-passwords-device-label = Only open on this computer
settings-passwords-device-help = Your master password works only together with a key in this computer’s security chip, so a copy of your passwords file is useless anywhere else, even with the password. If the chip is cleared or the computer replaced, only your recovery key opens it. Exports still work anywhere.
settings-passwords-device-on = Turn on
settings-passwords-device-off = Turn off
settings-passwords-device-is-on = Your passwords now open only on this computer.
settings-passwords-device-is-off = Your master password alone opens your passwords again, on any computer.
settings-passwords-device-needs-recovery = Make a recovery key first: it’s the way back in if this computer’s security chip is cleared.
settings-passwords-device-error = This computer’s security chip couldn’t be used. Nothing changed.
passwords-device-failed = This computer’s security chip didn’t answer, so your master password can’t open your passwords. Try again, or use your recovery key (Forgot password?).
