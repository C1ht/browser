/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* sodium_init() picks the fastest implementation of every primitive,
 * including these four, which this build leaves out (see KEEP in
 * tools/vault/update-libsodium.py). Nothing here can call them, so there is
 * nothing to pick. */

int _crypto_scalarmult_curve25519_pick_best_implementation(void);
int _crypto_stream_salsa20_pick_best_implementation(void);
int _crypto_aead_aegis128l_pick_best_implementation(void);
int _crypto_aead_aegis256_pick_best_implementation(void);

int _crypto_scalarmult_curve25519_pick_best_implementation(void) { return 0; }
int _crypto_stream_salsa20_pick_best_implementation(void) { return 0; }
int _crypto_aead_aegis128l_pick_best_implementation(void) { return 0; }
int _crypto_aead_aegis256_pick_best_implementation(void) { return 0; }
