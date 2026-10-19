/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* libFuzzer target for everything a vault file can make the core do
 * (tools/vault/build.py --fuzz). Seeds from `vault_test corpus` unlock with
 * the fixed keyring key below, so the fuzzer also reaches the slot and body
 * paths, and rewriting. */

#include <string.h>

#include "bwvault.h"

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size);

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  static bwv_key* keyring = NULL;
  if (!keyring) {
    if (bwv_init() != BWV_OK) {
      return 0;
    }
    uint8_t raw[BWV_KEY_BYTES];
    memset(raw, 0x42, sizeof(raw));
    keyring = bwv_key_new();
    bwv_key_import(keyring, raw);
  }

  bwv_vault* vault = bwv_new();
  if (bwv_load(vault, data, size) == BWV_OK) {
    uint8_t fixed[BWV_CHALLENGE_BYTES];
    size_t fixed_len;
    bwv_kdf_params params;
    for (int t = BWV_SLOT_PASSWORD; t <= BWV_SLOT_HELLO; t++) {
      bwv_slot_inputs(vault, (bwv_slot_type)t, &params, fixed, &fixed_len);
    }
    (void)bwv_kdf_outdated(vault);
    if (bwv_unlock(vault, BWV_SLOT_KEYRING, keyring) == BWV_OK) {
      uint8_t* body;
      size_t len;
      if (bwv_read_body(vault, &body, &len) == BWV_OK) {
        uint8_t* file;
        size_t file_len;
        if (bwv_write(vault, body, len, &file, &file_len) == BWV_OK) {
          bwv_vault* again = bwv_new();
          if (bwv_load(again, file, file_len) != BWV_OK) {
            __builtin_trap(); /* we must read back what we write */
          }
          bwv_free(again);
          bwv_bytes_free(file);
        }
        bwv_secret_free(body);
      }
    }
  }
  bwv_free(vault);
  return 0;
}
