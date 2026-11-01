/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef browserwip_LinuxKeyring_h
#define browserwip_LinuxKeyring_h

#include <stddef.h>
#include <stdint.h>

#include "bwvault.h"

namespace mozilla::browserwip::linux_keyring {

// ---- The system keyring (docs/PASSWORDS.md §5.2) ----
//
// The keyring slot's key (32 random bytes) lives in the Secret Service
// (GNOME Keyring, KWallet's ksecretd, KeePassXC...) through libsecret,
// loaded with dlopen as Gecko's LibSecret.cpp does, so the browser still
// runs without it. Items use the schema "org.browserwip.Vault" with the
// attributes vault=<vault id hex> and generation=<generation hex>, in the
// default collection.
//
// These block, and a locked collection shows the desktop's own unlock
// prompt: call them on the vault's task queue, never on the main thread.
// Elsewhere than Linux they report that there's no keyring.

// libsecret loads and a Secret Service is running or can be started.
bool Available();

// The bwt_providers shapes (bwvtxn.h). Store and Lookup return
// BWV_E_PROVIDER when there is no keyring or no such item, and
// BWV_E_CANCELLED when the unlock prompt was dismissed.
bwv_status Store(void* aCtx, const uint8_t aVaultId[BWV_ID_BYTES],
                 const uint8_t aGeneration[BWV_ITEM_TAG_BYTES],
                 const uint8_t aKey[BWV_KEY_BYTES]);
bwv_status Lookup(void* aCtx, const uint8_t aVaultId[BWV_ID_BYTES],
                  const uint8_t aGeneration[BWV_ITEM_TAG_BYTES],
                  uint8_t aKey[BWV_KEY_BYTES]);

// Deletes this vault's items except generation aKeep (all if null). Only
// when a Secret Service is already running, and without unlocking anything
// to find them: at start, a browser that never used the keyring doesn't
// start a keyring daemon or show a prompt.
bwv_status DeleteExcept(void* aCtx, const uint8_t aVaultId[BWV_ID_BYTES],
                        const uint8_t* aKeep);

}  // namespace mozilla::browserwip::linux_keyring

#endif  // browserwip_LinuxKeyring_h
