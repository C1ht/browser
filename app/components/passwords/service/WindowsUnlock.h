/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef browserwip_WindowsUnlock_h
#define browserwip_WindowsUnlock_h

#include <stddef.h>
#include <stdint.h>

#include "bwvault.h"

namespace mozilla::browserwip::windows_unlock {

// ---- Windows Hello (docs/PASSWORDS.md §5.3) ----
//
// A per-user RSA key in the Passport key store, inside the TPM, named
// "BWVAULT-<vault id hex>". Signing the Hello slot's challenge with it (one
// Hello prompt) gives the signature that the slot's key is derived from.
// RSASSA-PKCS1-v1_5 is deterministic, so the same challenge always gives the
// same signature; the signature is never stored.
//
// These block until the user answers the prompt: call them on the vault's
// task queue, never on the main thread. Elsewhere than Windows they report
// that Hello isn't there.

// Hello is set up for this user and the machine has a TPM 2.0. Without a TPM,
// Hello keys would be software keys, no better than DPAPI (§17 Q6).
bool HelloAvailable();

// Creates (or replaces) this vault's key. One Hello prompt.
bwv_status HelloEnroll(const uint8_t aVaultId[BWV_ID_BYTES]);

// Signs the challenge with this vault's key: one Hello prompt. *aLen is the
// buffer's size on the way in, the signature's on the way out. The same
// shape as bwt_providers.hello_sign. BWV_E_CANCELLED if the user cancels.
bwv_status HelloSign(void* aCtx, const uint8_t aVaultId[BWV_ID_BYTES],
                     const uint8_t aChallenge[BWV_CHALLENGE_BYTES],
                     uint8_t* aSignature, size_t* aLen);

// Deletes this vault's key (turning Hello off). Failures are ignored: the
// slot is gone from the vault either way.
void HelloDelete(const uint8_t aVaultId[BWV_ID_BYTES]);

// ---- Session lock (§5.4) ----
//
// Calls aCallback on the main thread when this Windows session is locked or
// switched away from (another user, a remote session taking over). Main
// thread only.
void WatchSessionLock(void (*aCallback)());
void StopWatchingSessionLock();

}  // namespace mozilla::browserwip::windows_unlock

#endif  // browserwip_WindowsUnlock_h
