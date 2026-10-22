/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Changing the vault on disk safely (docs/PASSWORDS.md §4.2, §6): saves,
 * changing the master password, replacing the encryption key, the queue of
 * saves made while a replacement holds the write lock, and finishing what
 * a crash interrupted.
 *
 * Changing the master password re-wraps the vault key: the recovery key,
 * the keyring and Windows Hello keep working.
 *
 * Replacing the encryption key is two calls, because the new recovery key
 * must be shown, and confirmed as stored, in between:
 *
 *   prepare  takes the write lock; a new vault key on a copy of the vault;
 *            everything sealed again; the password slot, and a new
 *            recovery key, keyring entry (new generation) and Hello
 *            enrolment where there were ones; written to vault.bwv.new;
 *            opened again from disk with the password, the new recovery
 *            key, a fresh keyring lookup and a second Hello signature.
 *   commit   the marker; vault.bwv.new over vault.bwv; the browser's own
 *            backup refreshed from it; keyring entries of other
 *            generations deleted; the marker removed.
 *   abort    vault.bwv.new and the new keyring entry deleted, the copy
 *            wiped. The old vault, recovery key, keyring entry and Hello
 *            enrolment stay valid.
 *
 * Until commit renames the new file into place, every failure leaves the
 * old vault as it was. After the rename the new vault is in use; anything
 * left to tidy up is reported as BWV_E_CLEANUP and finished by
 * bwt_recover() at the next start.
 *
 * The keyring and Windows Hello are reached through providers, so they
 * can be faked in tests. A provider that is NULL isn't there.
 */

#ifndef bwvtxn_h
#define bwvtxn_h

#include "bwvault.h"
#include "bwvstore.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BWT_MAX_SIGNATURE 1024

typedef struct {
  void* ctx;
  /* Keyring entries are named by vault id and generation. */
  bwv_status (*keyring_store)(void* ctx, const uint8_t vault_id[BWV_ID_BYTES],
                              const uint8_t gen[BWV_ITEM_TAG_BYTES],
                              const uint8_t key[BWV_KEY_BYTES]);
  bwv_status (*keyring_lookup)(void* ctx, const uint8_t vault_id[BWV_ID_BYTES],
                               const uint8_t gen[BWV_ITEM_TAG_BYTES],
                               uint8_t key[BWV_KEY_BYTES]);
  /* Delete this vault's entries except generation `keep` (all if NULL). */
  bwv_status (*keyring_delete_except)(void* ctx,
                                      const uint8_t vault_id[BWV_ID_BYTES],
                                      const uint8_t* keep);
  /* Sign `challenge` with this vault's Hello key: one Hello prompt. *len is
   * the buffer's size on the way in, the signature's on the way out. */
  bwv_status (*hello_sign)(void* ctx, const uint8_t vault_id[BWV_ID_BYTES],
                           const uint8_t challenge[BWV_CHALLENGE_BYTES],
                           uint8_t* signature, size_t* len);
} bwt_providers;

typedef struct bwt_session bwt_session;
typedef struct bwt_replacement bwt_replacement;

bwt_session* bwt_session_new(bws_store* store, const bwt_providers* providers);
/* Wipes the vault and the queue. */
void bwt_session_free(bwt_session* session);

/* At start, with no vault unlocked: delete keyring entries of other
 * generations than the vault's, and finish a commit a crash interrupted.
 * BWV_E_CLEANUP when something must be tried again later. */
bwv_status bwt_recover(bwt_session* session);

/* Hand over the open vault: unlocked, body open. */
void bwt_attach(bwt_session* session, bwv_vault* vault);
bwv_vault* bwt_vault(bwt_session* session);

/* A replacement holds the write lock. */
int bwt_busy(const bwt_session* session);

/* Write the vault: the current file becomes the backup, then the new one
 * replaces it. BWV_E_BUSY while a replacement holds the lock: queue it. */
bwv_status bwt_save(bwt_session* session);

/* Re-wrap the vault key under a new master password. `current` is checked
 * first. */
bwv_status bwt_change_password(bwt_session* session, const char* current,
                               size_t current_len, const char* fresh,
                               size_t fresh_len);

/* How many Hello prompts a replacement will cause (0 or 2), to say so
 * before the first. */
int bwt_hello_prompts(const bwt_session* session);

/* `current` is checked first; the new key is wrapped under `fresh` (the
 * same password from Settings; the new one from a password change). `code`
 * receives the new recovery key, or "" when the vault had none. */
bwv_status bwt_replace_prepare(bwt_session* session, const char* current,
                               size_t current_len, const char* fresh,
                               size_t fresh_len, bwt_replacement** out,
                               char code[BWV_RECOVERY_CHARS + 1]);
/* Consumes `r`. BWV_OK, BWV_E_CLEANUP (in use; tidying up to be retried)
 * or an error from before the swap (the old vault is still in use). */
bwv_status bwt_replace_commit(bwt_session* session, bwt_replacement* r);
/* Consumes `r`. */
void bwt_replace_abort(bwt_session* session, bwt_replacement* r);

/* ---- Saves made while the write lock is held ----
 *
 * The password is sealed at once under a key that exists only in this
 * session; `patch` is the index change, opaque here and applied by
 * `apply_patch` (in the browser, JavaScript). Nothing leaves the queue
 * until a save that includes it has succeeded. */

bwv_status bwt_queue_save(bwt_session* session,
                          const uint8_t entry_id[BWV_ENTRY_ID_BYTES],
                          const char* origin, size_t origin_len,
                          const uint8_t* secret, size_t secret_len,
                          const uint8_t* patch, size_t patch_len);
size_t bwt_queue_length(const bwt_session* session);

typedef bwv_status (*bwt_patch_fn)(void* ctx, bwv_vault* vault,
                                   const uint8_t* patch, size_t len);
bwv_status bwt_queue_apply(bwt_session* session, bwt_patch_fn apply_patch,
                           void* ctx);

#ifdef BWV_TESTING
/* Make the named step fail (NULL: none). BWV_CRASH_AT=<step> in the
 * environment makes the process exit there instead. */
void bwv_test_fail_at(const char* step);
int bwv_test_reached(const char* step);
void bwv_test_reset_reached(void);
#endif

#ifdef __cplusplus
}
#endif

#endif /* bwvtxn_h */
