# Built-in password manager: Stage 1 design

Status: **approved 2026-10-19; Stage 2 in progress.** Every question in
§17 was decided as recommended. Q9: logind `Lock`/`LockedHint` and
`org.freedesktop.ScreenSaver`. Windows Hello is tested by hand on a real
Windows machine (§15).

Mockups: `design/mockups/passwords/` (published as a canvas, *Password manager
mockups*).

**Built so far (Stage 2):**

- **Master password and Windows Hello.** The keyring and the recovery
  key are not built yet (§18 part 3).
- **Windows Hello (§5.3),** turned on in Settings › Passwords with the
  master password: a TPM-backed KeyCredentialManager key named
  `BWVAULT-<vault id>` signs the vault's HELLO-slot challenge
  (`service/WindowsUnlock.cpp`). It unlocks for filling only; showing,
  copying and exporting still ask for the master password.
- **The bridge to the core:** `components/passwords/service/`
  (`nsIPasswordVault`). The core runs on one background task queue and
  every call returns a Promise.
- **`PasswordVault.sys.mjs`:** lock state and the index, saving and
  editing, captured logins, reveal and copy behind the master password
  with the 5-minute grace, clearing the clipboard after 30 s, locking on
  idle (system idle, through `nsIUserIdleService`), on sleep, on quit and
  when Windows locks (WTS session notifications, `browserwip:session-locked`).
- **`PasswordRules.sys.mjs`:** the §7.1 origin rules, tested in Node
  (`tests/unit/password-rules.test.mjs`).
- **In pages:** `PasswordsChild`/`PasswordsParent` (https frames only) and
  `base/content/passwords.js`. They provide:
  - the key button with its dot
  - the save, update, unlock and setup panel under it
  - the dropdown under login fields, with the generator and "also use
    here"
  - Standard saving generated passwords with Undo
- **The manager and Settings:** `about:passwords`
  (`base/content/passwords.html`) and Settings › Passwords.
- **Export and import (§9),** from the ⋯ menu on about:passwords or from
  Settings:
  - the encrypted .bwv export, and the plain-text CSV behind its warning;
    both ask for the master password every time
  - import of a .bwv file (with its passphrase), or of CSV files from
    Firefox, Chrome, Bitwarden or KeePassXC
  - duplicates listed with Keep mine / Use imported, never overwritten
    silently
  - .bwv passwords copied inside `nsIPasswordVault`, never through JS
  - the column mapping and the import plan in `PasswordTransfer.sys.mjs`
    (`tests/unit/password-transfer.test.mjs`)
- **Not built yet:**
  - the passphrase suggestion at setup (it needs the EFF word list)
  - "Start over" from Forgot password
  - runtime checks for these parts in `tools/runtime/check.py`

---

## 0. Done before Stage 1 (branch `claude/password-manager`, from `main`)

- **`main`** now exists at the tip of `claude/anonymous-mode`, which also
  carries two new commits: the fullscreen work and the middle-click/Ctrl+click
  link handling it was mixed with.
- **Toolkit's `LoginManager` actor is unregistered** at startup. Toolkit
  still calls `getActor("LoginManager")` in three places:
  - `FormHistoryChild`, on every form submission
  - `AutoCompleteChild`, on every password field
  - `AutoCompleteParent`, whenever any dropdown opens

  Without that actor all three throw, and form history would stop saving. So
  an inert stand-in (`components/passwords/LoginManagerStub*`) takes the
  name. It reports that no field is the password manager's, offers nothing,
  listens to nothing and sends nothing.
- **All `signon.*` capture, fill, generation, backup and loose-matching
  prefs are off.** This is a second layer of protection.
- **HTTP Basic auth, checked.** Gecko gets auth prompts from
  `@mozilla.org/passwordmanager/authpromptfactory;1`. Toolkit's
  implementation calls `Services.logins.searchLoginsAsync` on every prompt,
  whatever the prefs say. That starts Firefox's JSON and Rust login stores
  and the migrator between them, and afterwards it tries to show a save
  prompt. Our app also has no `Prompt` actor (Firefox's lives in
  `browser/`), so `Prompter` falls back to toolkit's window-modal
  `commonDialog`. The contract now points to
  `components/passwords/AuthPrompt.sys.mjs`, which shows the same dialog,
  never touches storage, and keeps toolkit's de-duplication and its
  "stop after 2 cancels" limit.
- **Runtime checks, part 6, now part of release CI on both OSes.** They cover:
  - the prefs are off
  - the stand-in actor is in place
  - form history still saves next to a password field
  - Basic sign-in works
  - a third prompt is suppressed after two cancels
  - no Firefox password-manager module is loaded
  - no `logins.json`, `logins.db` or `logins-backup.json` appears in the
    profile
  - no errors mention the missing actor

  **None of this has been compiled yet** (see §15 on CI).

---

## 1. The design in one picture

```
master password ──Argon2id(salt, t, m)──► MPK ─┐
recovery key (optional) ──Argon2id──────► RK ──┤
Linux keyring secret (32 random B) ───────────┼─ each unwraps ─► VK (vault key, 32 random B)
Windows Hello signature over challenge ─HKDF──► HK ─┘                │
                                                     HKDF(VK,"index")│ HKDF(VK,"secret")
                                                         ▼           ▼
                                        body: whole index      each password sealed again,
                                        (sites, usernames,     in a table beside the index that
                                         times) XChaCha20-     stays in C; opened one at a time,
                                         Poly1305              only to fill / reveal / copy / export
```

- **One file per profile, fully encrypted.** Sites and usernames are
  encrypted too. Only a versioned header with the KDF parameters and the
  key slots is in the clear, and it is authenticated.
- **The master password is the root.** It, or the optional recovery key you
  hold, is the only thing that can reveal, export, change the password or
  add an unlock method. The keyring and Windows Hello are extra *slots*
  that unlock for autofill only.
- **The vault lives only in the browser (parent) process.** Content
  processes describe forms and receive exactly one credential, after a
  click, for an origin the parent checked itself.

---

## 2. Threat model

**Covered:**

| Threat | What stops it |
|---|---|
| Profile folder or disk copied (stolen laptop, backup, sync folder) | Everything is encrypted under a key derived with Argon2id from the master password (256 MiB, t=3; §4.3). Nothing in the file says which sites you use, how many logins you have (padded) or your usernames. The keyring and Hello slots are useless without the live keyring or the TPM. Keys are wiped before suspend and hibernation, so a hibernation file holds none. |
| Another local user | The file is 0600 on Linux and has a user-only DACL on Windows. Keyring items and Hello keys belong to your account. |
| Phishing and look-alike pages | Fill only on an exact origin (scheme, host, port), only over HTTPS, only after your click in browser UI a page cannot draw or trigger, only into visible fields, and the origin is taken from the parent's own record of the frame. A look-alike origin is simply a different origin. |
| A compromised content process | It can only ask about frames of its own site (Fission gives each site its own process). It never holds the vault key or other sites' credentials. |

**Not covered, and said plainly in Settings and on the manager page:**

- **Malware running as you while the vault is unlocked.** It can read the
  browser's memory, watch you type the master password, read the keyring
  over D-Bus, inject into pages, or simply wait for a fill. Nothing in a
  browser fixes that. Lock-on-idle and lock-on-session-lock shrink the
  window; they don't close it.
- **Malware running as you while the vault is locked** can't decrypt the
  file. It can still capture the master password the next time you type it,
  or replace the browser.
- **Someone with your unlocked desktop session** can use autofill (that's
  what unlocking means). They can't reveal or export without the master
  password. With Q1(b)'s grace window, the exception is revealing within 5
  minutes of you typing it.
- **Root or an administrator** on the machine, physical memory attacks, and
  a compromised OS.
- **A site you sign into.** It gets the password you fill into it, by design.
- **Weak master passwords.** Argon2id slows guessing; it can't save
  `password1`.

---

## 3. Architecture

```
content process (one per site)            parent process
┌──────────────────────────────┐          ┌────────────────────────────────────────────┐
│ PasswordsChild (JSWindowActor) │  IPC    │ PasswordsParent ── origin from              │
│  · finds login forms           │ ──────► │   WindowGlobalParent.documentPrincipal      │
│    (toolkit LoginFormFactory,  │ field   │ PasswordVault.sys.mjs: state, index, rules  │
│     NewPasswordModel)          │ info,   │ passwords.js (window): dropdown, save/unlock │
│  · visibility checks           │ submits │   panels, key button                        │
│  · sets ONE credential when    │ ◄────── │ about:passwords, about:settings#passwords   │
│    told, re-checking the field │ 1 cred  │        │ XPCOM (C++)                          │
└──────────────────────────────┘          │ nsIPasswordVault ─ vault core (C) ─ libsodium │
                                          │   OS providers: libsecret · fprintd · logind │
                                          │   (Linux), Hello · WTS · power (Windows)     │
                                          └────────────────────────────────────────────┘
```

- **Vault core (C, `app/components/passwords/vault/`).** Reads and writes
  the header, runs the KDF, handles slots, and does body and per-secret
  AEAD. It has no Gecko dependency, so CI builds and tests it on its own in
  minutes, and fuzzes it.
- **libsodium 1.0.22,** vendored under `app/third_party/libsodium/` as a
  minimal subset, compiled into libxul from our directory
  (`FINAL_LIBRARY = "xul"`, already proven by `app/build/win`). It is also
  built standalone for tests. Debian 13 ships 1.0.18, which lacks
  `crypto_kdf_hkdf_sha256` (added in 1.0.19) and predates a 2025 fix, so
  it is vendored on both OSes. That also guarantees identical crypto.
- **`nsIPasswordVault` (C++, main process only).** Holds keys in
  `sodium_malloc` memory. Runs Argon2 on a background thread and returns
  Promises. Writes files with the right permissions. Hosts the OS providers.
- **`PasswordVault.sys.mjs`** keeps the decrypted index (no passwords in
  it), matching, lock state and timers.
- **No mozilla-central changes and no Rust.** Rust in libxul would mean
  editing `toolkit/library/rust/shared/Cargo.toml`.
- **Crypto context strings never contain the codename**
  (`"BWVAULT"`, `"vault/v1/…"`), so `tools/rename.sh` can't break existing
  vaults. A test enforces this.

---

## 4. Vault format (version 2)

Version 1 was the first development format, with the passwords inside the
JSON index. It is refused with BWV_E_OLDER ("made by an earlier development
version"), never misread. No released build ever wrote it.

### 4.1 Layout (little-endian)

```
prefix, 16 bytes
  0   8  magic        "BWVAULT\0"
  8   2  version      2
  10  2  header_len   H  (≤ 4096)
  12  4  reserved     0
header, H bytes: records  type u8 | len u16 | value
  0x01 vault_id   16 random bytes
  0x02 kdf        alg u8 (1 = Argon2id v1.3) | t u32 | m_kib u32 | p u8 (= 1) | salt 16
  0x03 aead       alg u8 (1 = XChaCha20-Poly1305-IETF)
  0x04 counter    u64, +1 on every write (for rollback checks and sync later)
  0x10 slot.password  nonce 24 | wrapped_vk 48
  0x11 slot.recovery  t u32 | m_kib u32 | salt 16 | nonce 24 | wrapped_vk 48
                      (its own parameters, so raising the password's later
                      doesn't break a recovery key on paper)
  0x12 slot.keyring   generation 16 | nonce 24 | wrapped_vk 48
  0x13 slot.hello     challenge 32 | nonce 24 | wrapped_vk 48
  type ≥ 0x80 = "critical": a reader that doesn't know it refuses the file.
  Unknown types below 0x80 are skipped and kept unchanged on rewrite.
body
  nonce 24 | ct_len u32 | ciphertext (incl. 16-byte tag)
  AAD = prefix ‖ header, byte for byte
payload (the body's plaintext, before padding)
  index_len u32 | count u32 | index (JSON) | records
  record   len u32 | entry id 16 | origin_len u16 | origin | sealed password
```

- **Slot wrap AAD:** `magic ‖ version ‖ vault_id ‖ slot type ‖ the slot's
  fixed fields`. A wrapped key can't be moved to another vault or another
  slot type.
- **The payload is padded** with `sodium_pad` to a 16 KiB multiple, so the
  file size gives the number of logins only to within about 60.
- **The index (JSON) and the sealed passwords are kept apart.** The index
  goes to JS: sites, usernames, times. The passwords stay in the C core,
  so JS never holds them, not even sealed. The core can then re-encrypt the
  whole vault (§4.2) without JS building a new plaintext index.
- **Parsing:** the C parser handles the prefix, the header, the body framing
  and the password table, which is everything an attacker can feed us, and
  it's what we fuzz. The index is parsed in JS, after authentication.

```json
{ "v": 1,
  "entries": [{ "id": "<16 B, base64url>", "origin": "https://accounts.example.com",
                "also": [], "realm": null, "username": "ana@example.com",
                "created": 0, "changed": 0, "used": 0 }],
  "never": ["https://example.org"] }
```

- **Each password is sealed a second time:**
  `XChaCha20-Poly1305(SK, nonce, password, AAD = vault_id ‖ entry id ‖
  origin)`. It is opened only to fill, reveal, copy or export.
  - Because the AAD includes the origin, a password opens only when the
    caller presents that origin.
  - The automatic fill path always passes the *frame's* origin, so if the
    matching code has a bug, decryption fails rather than filling the wrong
    site.

### 4.2 Keys, changing the master password, replacing the key

| Key | How it is made | Where it lives |
|---|---|---|
| VK, the vault key | 32 random bytes; replaced only by "Replace encryption key" | Wrapped in each slot. Kept in `sodium_malloc` memory while unlocked, `mprotect`ed no-access between uses. |
| IK, the index key | `HKDF-SHA256(VK, salt=vault_id, info="vault/v1/index")` | Same. Encrypts the body. |
| SK, the secret key | `HKDF-SHA256(VK, salt=vault_id, info="vault/v1/secret")` | Same. Seals each password. |
| MPK, the master password key | `Argon2id(NFC(master password), salt, t, m, p=1)` → 32 B | Exists only during unlock, then zeroed. |
| RK, the recovery key | 160-bit random code, shown once as 8 groups of base32 → Argon2id with the recovery slot's own salt and parameters | Only on paper; same handling as MPK. |
| HK, the Hello key | See §5.3 | Exists only during unlock. |
| KK, the keyring key | 32 random bytes in the Secret Service, under an entry named by vault id and generation | The user's keyring. |

**Changing the master password re-wraps VK** (decided after the part 1
checkpoint):
- Only the password slot changes: a fresh salt, the vault's current KDF
  parameters, the same VK.
- The recovery key, the keyring and Windows Hello keep working, and no new
  recovery key is shown.
- The dialog has an unchecked box, "My old password may have been exposed".
  Ticked, the key replacement below runs as part of the same operation,
  wrapping the new key under the new password.

**Replace encryption key** (Settings › Passwords, or the box above). In
order:
1. **Confirm:** the master password is checked.
2. **Warn:** if Windows Hello is set up, the user is told it will ask twice.
3. **Lock:** the write lock is taken (§4.5).
4. **Build the new vault on a copy, in the C core** (the live vault isn't
   touched):
   - a new VK
   - the index and every password encrypted again
   - the password slot under the master password (the same KDF parameters)
   - a new recovery key, with the old slot's parameters, **only if there was
     one**
   - a new keyring entry, under a **new generation**, if the keyring was set
     up
   - Hello enrolled again on a new challenge (**first prompt**), if it was
     set up
5. **Write `vault.bwv.new`,** owner-only, flushed to disk.
6. **Check it from disk.** Every way in has to work:
   - the password
   - the new recovery key
   - a *fresh* keyring lookup
   - a second Hello signature (**second prompt**). If that signature doesn't
     reproduce the first, it's a failure: abort, nothing changes.
7. **Show the new recovery key once.** It is described as taking effect only
   once the replacement finishes, and the user keeps the current one until
   then. "I have stored it" is required to go on.
8. **Commit:**
   - the cleanup marker
   - `vault.bwv.new` renamed over `vault.bwv`
   - the browser's own `vault.bwv.bak` refreshed from the new file
   - keyring entries of other generations deleted
   - the marker removed
9. **Final screen:** "Replacement complete. Your old recovery key no longer
   works and can be destroyed." Also: "Copies of your passwords saved before
   now, such as backups, still open with the password you used then."

**If anything fails:**
- **Before the rename** (re-encrypting, wrapping, writing, checking,
  keyring, a Hello cancel, a non-reproducing Hello signature, closing the
  dialog):
  - `vault.bwv.new` and the new keyring entry are deleted
  - the copy's keys, index and passwords are wiped
  - the old vault, recovery key, keyring entry and Hello enrolment stay valid
- **A Hello cancel** stops everything and offers to retry, or to turn Hello
  off first.
- **After the rename** the new vault is in use. Unfinished tidying (the
  backup, old keyring entries, the marker) returns BWV_E_CLEANUP and is
  finished at the next start (§4.4).

### 4.3 KDF parameters

- **Default: Argon2id, m = 256 MiB, t = 3, p = 1.** That is libsodium's
  `MODERATE`, roughly 0.5–1 s on a 4-core laptop. The parameters are stored
  in the header, so a vault opens identically on both OSes.
- **Accepted range when opening:** m between 64 MiB and 2 GiB, t between 2
  and 16. Anything outside is refused, with no downgrade to cheap
  parameters and no memory blow-up from a crafted file.
- **Both flows keep the parameters:** a password change and a replacement
  use the vault's current ones (tested).
- **Upgrades:** when we raise the defaults, the next successful unlock
  re-derives and rewraps (the password is in hand at that moment).

### 4.4 Versions, writes and start-up recovery

- **A newer version, or a critical record we don't know,** is refused with
  "This vault was made by a newer version" and **never overwritten.**
- **Older versions** are migrated after a successful unlock, once there are
  released ones. Version 1 is refused (above).
- **The index has its own `"v"`,** so the entry schema can change without
  touching the outer format.
- **Algorithm agility:** the `kdf` and `aead` ids. A new cipher means a new
  id and a rewrite after unlock.
- **Writes are durable:**
  - temp file, then flush, then rename, then directory flush
  - Linux: `fsync` of the file and the directory
  - Windows: `FlushFileBuffers`, then `MoveFileExW(REPLACE_EXISTING |
    WRITE_THROUGH)`, retried up to 10 times, 50 ms apart, while a scanner
    holds the file
  - an ordinary save first makes the current file the browser's own `.bak`
  - a file that fails to parse or authenticate is **never** replaced
    automatically
- **At start:**
  - a leftover `vault.bwv.new` or temp file is deleted, never promoted
  - keyring entries whose generation isn't the one in the header are deleted
    (all of this vault's entries, if there's no keyring slot); if the
    keyring is locked, this waits for its next unlock
  - if the cleanup marker is present, the backup is refreshed from
    `vault.bwv` and the marker removed

  A crash at any point therefore leaves no orphan entry and no
  half-finished state.

### 4.5 The write lock and saves made meanwhile

- **The write lock is held from step 3 of a replacement until commit or
  abort.** A password change holds it for its own (short) duration.
- **A save that comes in meanwhile is queued:**
  - the password is sealed at once under a key that exists only for the
    session
  - the index change is kept with it
  - the key button shows the pending dot
- **When the dialog closes,** the queue is applied to whichever vault is now
  current and saved. Nothing leaves the queue until a save that includes it
  has succeeded.
- **If applying fails,** the queue stays sealed in memory, the user is told
  plainly, and it's retried. A queued save is never dropped silently.
- **Quitting while the dialog is open** aborts the replacement, then applies
  the queue to the old vault before exit.
- **A second instance:**
  - Gecko's profile lock stops a second browser on the same profile
  - as a second layer, the vault directory's own lock (`flock`, or an
    unshared handle on Windows) makes the vault refuse to open in another
    process

---

## 5. Unlocking and locking

### 5.1 States

| State | What is in memory | Fill | Reveal / copy | Export, change password, add an unlock method |
|---|---|---|---|---|
| **No vault** | nothing | – | – | Setting up creates one |
| **Locked** | nothing (not even site names) | no | no | no |
| **Unlocked** (by any slot) | VK/IK/SK in locked memory, index in JS | yes | **needs the master password** (§17 Q1) | **needs the master password every time** |

### 5.2 Linux: Secret Service (libsecret), optional fprintd

- **Enabling it** (needs the master password):
  1. Make KK and store it with `secret_password_store_sync`. Schema
     `org.browserwip.Vault` (renamed with the codename), attributes
     `vault=<vault_id hex>` and `generation=<generation hex>` (the
     generation is also in the entry's label and in the vault header),
     the default collection.
  2. Add `slot.keyring`.

  libsecret is loaded with `dlopen`, as Gecko's `LibSecret.cpp` does, so
  the browser still runs without it.
- **Unlocking:** look up KK (`secret_password_lookup_binary_sync`, which
  zeroes its copy), then unwrap VK.
  - If the collection is locked, the desktop's own keyring prompt appears.
  - If there's no `org.freedesktop.secrets` on the bus (common on minimal
    sessions), the item is gone, or the unwrap fails, **the master password
    is asked for.**
  - It never falls back to plaintext, an empty key or an unprotected
    stored key. In that case there is simply no slot to use.
- **fprintd is a presence check, not a factor.** If you turn on "Confirm
  with fingerprint", a keyring unlock first needs a fingerprint match
  through `net.reactivated.Fprint.Device.VerifyStart`. It holds no key
  material and is skipped by the master password. The UI says exactly
  that: "Confirms it's you at the keyboard. It doesn't add protection to
  the vault itself."
- **Honest note shown in Settings:** any program running as you can read
  the keyring while your session is unlocked.

### 5.3 Windows: Windows Hello, TPM-backed, no DPAPI

- **Enabling it** (needs the master password):
  1. `KeyCredentialManager.RequestCreateAsync("BWVAULT-<vault_id hex>",
     ReplaceExisting)` creates a per-user RSA-2048 key in the Microsoft
     Passport key store, inside the TPM.
  2. Make a 32-byte random challenge **C**.
  3. `RequestSignAsync(C)` returns the signature **S**. Hello verifies the
     user (PIN, face or fingerprint) for this call.
  4. **HK = HKDF-SHA256(IKM = S, salt = vault_id, info = "vault/v1/hello")**.
  5. Store `slot.hello = C ‖ nonce ‖ XChaCha20-Poly1305(HK, nonce, VK, AAD)`.
- **Unlocking:** `OpenAsync`, then `RequestSignAsync(C)` (one Hello
  prompt), then HK, then VK.
- **Why it holds:**
  - S is never stored.
  - Making S needs the non-exportable private key in *this* machine's TPM
    and a fresh user verification every time.
  - RSASSA-PKCS1-v1_5 is deterministic, so the same C always gives the same
    S.
  - The same pattern is used by KeePassXC (which uses SHA-256 of S as the
    key) and Bitwarden.
- **Failure means the master password, never DPAPI.** That includes:
  - no Hello on this machine
  - no TPM: Hello keys would then be software keys, no better than DPAPI,
    so it isn't offered (§17 Q6)
  - the PIN was reset, the key was deleted, or the slot fails to unwrap

  There is no Credential Manager or DPAPI fallback anywhere.

### 5.4 When it locks

- **Always (no setting):**
  - session lock or switch-user (Windows `WTS_SESSION_LOCK`,
    `WTS_CONSOLE_DISCONNECT`; Linux logind `Lock` / `LockedHint` and the
    `org.freedesktop.ScreenSaver` `ActiveChanged` signal; §17 Q9 asks what
    your desktop sends)
  - **suspend and hibernate** (`PBT_APMSUSPEND`; logind `PrepareForSleep`).
    This keeps keys out of the hibernation image.
  - quitting the browser
  - "Lock now"
- **Idle timeout, the one setting:** lock after *N* minutes without input
  to the browser. Measuring the browser's own input works the same on
  Wayland, X11 and Windows, where system idle detection varies.
- **Locking** zeroes and frees VK, IK, SK and pending sealed captures, drops
  the index, clears a password we put on the clipboard (if it's still
  there) and closes any open reveal.

### 5.5 The master password

- Normalised to NFC before the KDF, so the same password typed on Linux or
  Windows gives the same key. Never trimmed.
- **At least 12 characters.** Setup suggests a 5-word passphrase, made from
  a bundled EFF word list.
- After five wrong tries in a row, each try waits a few seconds. Nothing is
  ever wiped for wrong tries: an attacker with a copy of the file isn't
  slowed by this anyway.

---

## 6. Forgotten master password

Nobody can recover it: there's no server, no escrow and no back door, and
the UI says so at setup.

- **Recovery key (optional, offered at setup, §17 Q3).** A 160-bit code is
  shown once, with "Print" and "I've written it down". It is a full
  replacement for the master password, including setting a new one. It's a
  secret you hold, not an OS convenience. You can make a new one later,
  which removes the old one; that needs the master password.
- **"Forgot password?"** with no recovery key:
  - It explains the situation, then offers **Start over**, which you have
    to confirm by typing the word *start over*.
  - The old vault is **kept**, renamed `vault-forgotten-YYYY-MM-DD.bwv`.
    Settings has "Open an older vault…" in case the password comes back to
    you; a successful open merges it into the current vault.
  - A new empty vault is created.
- **While still unlocked through the keyring or Hello** after forgetting:
  - autofill keeps working
  - reveal, export, password change and recovery-key creation don't

  Otherwise a convenience unlock would end up doing the master password's
  job.

---

## 7. Autofill and saving

### 7.1 Where a credential may go

The parent decides, using `WindowGlobalParent.documentPrincipal` of the
frame. The frame's own URL report is never trusted.

1. **Exact origin.** The stored origin is normalised: lower-case, punycode
   (ASCII) host, default port dropped. It must equal the frame's
   `principal.originNoSuffix`. Scheme, host and port must all match.
2. **Never on plain HTTP.** No dropdown, no fill and no save prompt. That
   includes `http://localhost` and LAN IPs (§17 Q8). Also never on
   `null`/opaque principals (sandboxed frames, `data:`), `file:`, `about:`,
   the system principal or extension pages.
3. **Other subdomains of the same site** (same registrable domain under the
   public suffix list, via `Services.eTLD`):
   - never filled automatically and never offered by default
   - an entry can list extra origins in `also`, which you add yourself in
     the manager or by choosing "Also use on login.example.com" in the
     dropdown (§17 Q5)
   - entries can't be shared across registrable domains: `github.io` user
     sites, for example, stay separate
   - IP addresses only ever match exactly
4. **Cross-origin iframes:**
   - the dropdown opens only on a **mouse click** in the field, never on
     keyboard focus
   - choosing an entry needs a click
   - the dropdown's header names both: *"Sign in to idp.example (inside
     shop.example)"*
5. **Hidden fields are never filled.** The child checks every field it would
   touch, right before filling:
   - `checkVisibility({ checkOpacity, checkVisibilityCSS })`, which covers
     ancestors too
   - at least 4×4 CSS px, inside the viewport, not `disabled` or
     `readonly`, still connected
   - still in the same document (inner window id)

   A hidden username field is skipped, and the password is filled alone.
6. **Only after a user action in browser UI.**
   - Nothing fills on page load.
   - The dropdown is a chrome popup in the parent. It opens on a trusted
     click in the field or ArrowDown, never on script focus.
   - The fill happens when you pick an entry there. A page can't draw or
     click that popup.
   - Fullscreen pages leave fullscreen first, as permission prompts already
     do.
7. **One credential per fill.** The parent sends `{username, password}` for
   the chosen entry and nothing else. Usernames of other entries never
   reach content.

The matching code is a pure JS module with the PSL injected. The same code
runs in Node unit tests and in the browser.

### 7.2 What the dropdown looks like

- **Locked:** a single row, "Passwords are locked · Unlock…".
  - This reveals nothing about whether entries exist for the site.
  - Picking it opens the unlock panel, which **always hangs from the key
    button in the address field**, outside the page. A page can draw a fake
    box, but it can't draw one attached to the toolbar. Setup tells you the
    browser only ever asks for the master password there.
- **Unlocked:** the matching entries, showing username and host. Then
  "Use a strong password" on new-password fields (detected by toolkit's
  `NewPasswordModel`), then "Manage passwords".

### 7.3 Saving and updating

- **Detecting a submission:**
  - The child listens for toolkit's `form-submission-detected` event
    (from `FormHandlerChild`, which also covers forms without a `<form>`
    element). Stage 2 verifies it is registered in our build.
  - It reads the fields with `LoginFormFactory`.
  - Only values you typed are taken (`lastInteractiveValue`) or values we
    filled.
- **The parent:**
  - checks the origin (HTTPS, not opaque)
  - **seals the password immediately with a per-session key** in locked
    memory, so it isn't kept as a JS string while the prompt is open
  - shows the prompt
- **The prompt** hangs from the key button in the address field:
  - *Save login for example.com?* with the username (editable) and the
    password (hidden, can be shown, since it's what you just typed)
  - **Save** / **Not now** / ⋯ → **Never for this site**
  - If an entry with the same username exists, it reads *Update password?*
    instead
- **If the vault is locked,** the browser can't know whether this is new,
  changed or on the never list without decrypting. So it shows no popup:
  the key button gets a dot instead, and clicking it offers *Unlock to save
  this login*. That way you're never nagged on never-list sites.
- **Standard and Strict** (§17 Q4):
  - **Standard:** prompts after sign-in. A password from our generator is
    saved automatically when the form is submitted, with "Saved · Undo" on
    the key button, so a new account's password is never lost.
  - **Strict:** nothing is ever saved without you confirming a prompt,
    generated passwords included.
- **No vault yet:** the first Save expands the panel into setup (§9). The
  pending login stays sealed until then.

### 7.4 Password generator

- toolkit's `PasswordGenerator`, which uses `crypto.getRandomValues`
- 20 characters, with letters, digits and symbols, and without
  look-alikes
- the manager's generator can change the length and drop symbols
- passphrases use the bundled EFF long word list
- site rules come only from the bundled `password-rules` data; nothing is
  fetched

### 7.5 HTTP authentication

v1 keeps the storage-free prompt from §0. Filling it from the vault (exact
origin and realm, HTTPS only) is a small later step (§17 Q7).

---

## 8. Handling secrets

- **Decrypt only when needed.**
  - Unlocking decrypts the index, which holds no passwords.
  - A password is opened only to fill, reveal, copy or export, into
    `sodium_malloc` memory (locked, guard pages, `MADV_DONTDUMP`, so it's
    left out of core dumps), and it is zeroed right after.
  - VK, IK and SK are `mprotect`ed no-access except while in use.
- **Where JS can't follow.** These are said in the docs, not hidden:
  - A password being filled must become a JS string on its way to the
    page, and the page's field holds it after that. JS strings can't be
    zeroed or locked.
  - The same goes for the master password, while it's in the unlock field.
    We clear the field immediately.
  - Argon2's 256 MiB working memory can't be page-locked (Linux's
    `RLIMIT_MEMLOCK` is usually 8 MiB). libsodium wipes it after use, but
    it may still reach unencrypted swap. Settings recommends disk
    encryption.
- **Clipboard:**
  - `nsIClipboardHelper.copyString(…, Sensitive)`. The privacy flag keeps
    it out of KDE Klipper's history and out of Windows clipboard
    history and cloud clipboard.
  - It is never put in the X11/Wayland primary selection.
  - After **30 s**, and on lock or quit, the clipboard is cleared, but only
    if it still holds what we put there (we compare a keyed hash, not the
    text).
- **No secrets in logs:**
  - Errors carry codes only: no origins, usernames, passwords or key
    material.
  - There's no debug logging pref.
  - A test greps the CI log for every test secret.
- **Re-authentication:** reveal and copy need the master password (§17
  Q1). Export needs it every time.
- **Export warnings:** plaintext export needs the master password, a
  warning explaining what plaintext means, and ticking *"I understand
  anyone who gets this file can read every password."*

---

## 9. Setup, export, import

- **Setup** opens from the first Save prompt, from about:passwords or from
  Settings:
  1. master password, entered twice, with a strength hint and a
     passphrase button
  2. recovery key (optional)
  3. "Also unlock with Windows Hello" or "…with your system keyring", shown
     only where it works, and off unless you turn it on
  4. a one-paragraph summary of what this protects against, with the
     malware limit
- **Encrypted export (the default):**
  - the same `.bwv` format
  - a fresh VK
  - one password slot under an **export passphrase** asked for at export
    time (it can be the same as the master password, but you type it on
    purpose)
  - no keyring or Hello slots
  - It opens on any OS. KDBX4 comes later.
- **Plaintext CSV export:** columns `url,username,password,httpRealm`, which
  imports into Firefox, Chrome and Bitwarden. Gated as in §8.
- **Import:**
  - our `.bwv` (with its passphrase)
  - CSV from Firefox, Chrome, Bitwarden or KeePassXC, using toolkit's
    `CSV.sys.mjs` parser
  - Rows on HTTP are imported but shown as *"won't be filled (not
    secure)"*.
  - Duplicates (same origin and username) are listed so you can choose,
    never overwritten silently.
  - CSV import is in scope for v1 unless you say otherwise (§17 Q10).

---

## 10. Files and permissions

| Item | Linux | Windows |
|---|---|---|
| Location | `<profile>/passwords/vault.bwv`, `.bak`, temp file | same, in the roaming profile folder (`ProfD`), so the profile moves between OSes |
| Directory | 0700 | DACL: protected (no inheritance), one ACE for the user's SID, full control |
| Files | created `O_CREAT\|O_EXCL\|O_NOFOLLOW`, mode 0600, umask ignored | `CreateFileW` with that DACL as `SECURITY_ATTRIBUTES` |
| Existing file looser than that | tightened to 0600 and noted in the manager | DACL reset and noted |
| Symlinked `passwords/` | refused | reparse points refused |

---

## 11. The UI (see mockups)

All of it uses Folio's tokens from `browser.css` and `pages.css`:
- Instrument Sans
- stone neutrals and the teal accent
- the 12 px radius on panels and `--panel-shadow`
- `.panel-button` / `.primary`, `.toggle-row`, `.switch` and `.segmented`
- the stroke icon style (1.6 px, round caps)

New icon: `key.svg`.

1. **Key button in the address field,** next to the shield. It appears on
   pages with a login form, or when a login is waiting to be saved
   (with a dot). It opens the save, update or unlock panel.
2. **Field dropdown:** one row per entry (username, with the host
   underneath), the generator row and "Manage passwords". Variants: locked,
   cross-origin iframe header, and "Also use here" for another subdomain.
3. **Save / update panel,** the same shape as the permission prompt.
4. **Unlock panel,** hanging from the key button:
   - master password field and *Unlock*
   - *Use Windows Hello* or *Use keyring* as the primary button where
     enrolled
   - *Forgot password?*
5. **about:passwords:**
   - a two-pane manager, list with search on the left, entry on the right
   - fields: site, other sites (`also`), username (copy), password (••••,
     show and copy after master-password check), created and changed
   - Edit, Delete, *Add login*, generator, Import and Export
   - on a narrow window the list and the entry stack
6. **about:settings → Passwords:**
   - status and *Lock now*
   - *Change master password*
   - unlock methods
   - the idle timeout
   - recovery key, Export / Import
   - "What this protects against"
7. **Setup** and **Forgot password** cards in about:passwords.

Everything is in Fluent, keyboard-complete and labelled for screen readers.
Contrast follows the AA rules from the PLAN.

---

## 12. Settings

| Setting | Values | Status |
|---|---|---|
| Lock after inactivity | 5 min · **15 min** · 30 min · 1 h · 4 h | **Approved** (the one setting) |
| Unlock with Windows Hello / system keyring | off by default | Part of the requested convenience layer; asked at setup |
| Confirm with fingerprint (Linux) | off; shown only if fprintd has an enrolled finger | Same |
| Offer to save logins | on | **New, needs your OK (§17 Q2)** |
| Password behaviour | follows the privacy mode | **Needs your OK (§17 Q4)**; adds no setting if approved |

No other settings. Things like the clipboard timeout (30 s) and Argon2
parameters are fixed.

---

## 13. Where end-to-end sync would plug in later

- Entries are already records with a stable `id`, `changed` timestamps and
  a monotonic file `counter`.
- Sync would add tombstones and a per-record server format, encrypted with
  `HKDF(VK, "vault/v1/sync")`. VK itself never leaves the device.
- The server would see opaque records. Merging happens on the client, per
  record, by `changed`.
- A new device would join by scanning a pairing code that carries VK
  wrapped for that device. The master password never goes over the
  network.
- The hook is a `VaultStore` interface in `PasswordVault.sys.mjs`.
  v1 has one implementation, the local file.

## 14. Out of scope for v1

- sync, breach checks, anything in the cloud
- passkeys (WebAuthn is untouched)
- TOTP, cards, addresses, notes
- sharing
- KDBX4 (later, as an export format)
- password history
- HTTP-auth fill (§17 Q7)

---

## 15. Testing (CI, Linux and Windows)

New workflow **`passwords.yml`**, on every push to the branch. It takes
minutes and needs no Gecko build:

| Job | What runs |
|---|---|
| core (ubuntu-24.04, gcc and clang + ASan/UBSan) | vault core plus vendored libsodium, standalone: round-trip, wrong password, every byte of a sample file flipped (must fail authentication), truncation, header limits (KDF floor and cap), newer versions and unknown critical records refused, unknown non-critical records kept through a rewrite, padding, sealed secrets bound to entry and origin, slots bound to their type, password change rotates VK, recovery codes as typed from paper, the Hello slot; libsodium's own Argon2id and XChaCha20-Poly1305 known-answer tests run against our build; HKDF against RFC 5869 A.1 |
| core (windows-2022, clang-cl) | the same suite |
| cross-OS | Linux makes `vault-linux.bwv` and Windows makes `vault-windows.bwv` (artifacts); each opens the other's and checks every entry. Both also open `tests/fixtures/v1-windows.bwv`, a v1 vault committed to the repo, so format drift between releases is caught. |
| fuzz (ubuntu, libFuzzer) | the header/body parser and the slot unwrapper, 5 minutes per push, with a corpus in the repo. Windows replays the corpus as regression tests. |
| matching (Node, both OSes) | origin rules: exact origin; ports; `http` refused; IDN look-alikes (`раypal.com` vs `paypal.com`), `paypal.com.evil.io`, `xn--` forms; trailing dots; IPv4/IPv6; subdomains; PSL edge cases (`github.io`, `co.uk`); `also` lists; opaque/`data:`/`file:` |
| no keyring | Linux job with no `org.freedesktop.secrets`: unlock asks for the password and never writes a keyring slot. A second run starts `gnome-keyring-daemon` in `dbus-run-session` and checks the keyring round trip. |

The **Gecko build** (existing `release.yml`, run manually, as you asked)
adds runtime part 7:
- a local **HTTPS** server (self-signed, trusted through the cert override
  service in the test profile)
- fill on exact origin; nothing on another port, another host, HTTP, a
  hidden field, an off-screen field, or after script focus
- a cross-origin iframe: no dropdown on focus, fill only on click
- save prompt, never-list, Strict vs Standard
- lock on idle (shortened timeout pref in the test profile only)
- the clipboard is cleared
- no secrets in the browser log
- no vault file in the profile until setup

**Only on one OS, said up front:**
- Windows Hello can't run on CI runners (no Hello, no TPM). CI tests "Hello
  unavailable falls back to the password". The real Hello path needs **you
  to try it on a Windows machine**.
- fprintd needs a reader, so CI covers only "no fprintd".
- Linux session-lock signals are tested by emitting the D-Bus signals by
  hand.

---

## 16. Uncertain until Stage 2

- **libsodium inside Gecko's build.** Gecko's warning flags and clang-cl
  cross-compiling should be fine for its portable C. We need the minimal
  configuration (no asm, `SODIUM_STATIC`), and libsodium's AVX2 Argon2 code
  needs per-file flags. Fallback: the reference implementation only, which
  is slower but correct.
- **Windows Hello from an unpackaged app.** KeePassXC does this. The Hello
  dialog can open *behind* the window, and KeePassXC works around it by
  focusing it. **Confirming the key is TPM-backed** isn't exposed by
  `KeyCredentialManager`. The plan is to require a TPM 2.0 (TBS
  `Tbsi_GetDeviceInfo`) and assume Hello uses it, which is the default
  unless policy disables it. If that's not good enough, we'd need the
  undocumented NGC key store APIs.
- **Hello's signature staying deterministic.** It's RSA PKCS#1 v1.5 today.
  If Windows ever switched to ECDSA, Hello unlock would fail safely (master
  password) and offer re-enrolment.
- **`form-submission-detected` without Firefox's front end.** It comes from
  toolkit's `FormHandlerChild`. I'll verify the actor is registered and
  fires in our build, and otherwise listen to submit events directly.
- **Idle and session-lock signals on your desktop** (§17 Q9).

---

## 17. Your decisions

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Revealing or copying a password in the manager | (a) master password every time; (b) master password, then no re-ask for **5 min**; (c) Windows Hello also accepted for reveal | **(b)**. Export always asks. Hello never counts. |
| Q2 | A new setting, **"Offer to save logins"** (on/off) | add / don't add | **Add.** It's the basic off switch people expect. |
| Q3 | Optional **recovery key** at setup | offer / don't | **Offer** (skippable). |
| Q4 | Standard / Strict / Anonymous | (a) follow the browser's privacy mode: Standard auto-saves generated passwords, Strict and Anonymous always prompt; (b) a separate password setting | **(a)**, no new setting. |
| Q5 | Logins from another subdomain of the same site | (a) never offered, only via the entry's `also` list in the manager; (b) shown in a separate "Saved for login.example.com" group, click only, never automatic, with "Also use here" | **(b)** in Standard, **(a)** in Strict and Anonymous |
| Q6 | Windows Hello on a PC without a TPM | refuse / allow (software key) | **Refuse.** A software Hello key is no better than DPAPI. |
| Q7 | Fill HTTP-auth prompts from the vault | v1 / later | **Later.** v1 keeps the storage-free prompt. |
| Q8 | `http://localhost` and LAN-device logins | no exception / exception for loopback | **No exception.** Copy from the manager instead. |
| Q9 | Which screen locker or desktop signals does your desktop send? | logind `Lock` / `LockedHint`, `org.freedesktop.ScreenSaver`, something else | I'll handle logind and the ScreenSaver interface by default. Tell me if yours does something else. |
| Q10 | CSV import in v1 | in / out | **In.** It's how people get their passwords out of Firefox. |
| Q11 | Minimum master password | 12 characters with a passphrase suggestion / other | **12.** |

---

## 18. Stage 2 order (after approval)

1. **Vault core and KDF:** vendor libsodium, write the C core,
   `passwords.yml` with core, cross-OS and fuzz jobs. Checkpoint.
2. **Storage and migration:** file I/O with permissions, atomic writes,
   `.bak`, the version-migration path, the XPCOM component, and
   `PasswordVault.sys.mjs` with its index. Checkpoint.
3. **OS unlock providers:** libsecret, fprintd, logind/ScreenSaver; Hello,
   WTS, power; the no-keyring tests. Checkpoint.
4. **Autofill and origin matching:** matching module and tests; child/parent
   actors; capture and save logic. Checkpoint.
5. **UI:** key button, dropdown, panels, about:passwords, Settings, setup,
   export and import; then a full Gecko build in GitHub Actions with runtime
   part 7. Checkpoint.

If a build or API problem loops more than a few attempts, I stop and
explain.
