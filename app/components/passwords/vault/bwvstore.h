/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The vault's directory in the profile (docs/PASSWORDS.md §10).
 *
 * - The directory is created owner-only: 0700 on Linux; on Windows a
 *   protected DACL with one entry, the user's SID. A symlink or reparse
 *   point in its place is refused.
 * - Files are created owner-only the same way (0600, O_NOFOLLOW; the same
 *   DACL), and existing ones are tightened when found looser.
 * - Every replacement is durable: a temporary file, flushed, renamed over
 *   the old one, then the directory flushed (Linux: fsync; Windows:
 *   FlushFileBuffers, then MoveFileExW with REPLACE_EXISTING and
 *   WRITE_THROUGH, retried briefly while a virus scanner holds the file).
 * - An exclusive lock (vault.lock: flock / an unshared handle) is held for
 *   as long as the store is open; a second process gets BWV_E_IN_USE.
 * - Opening removes a staged file (vault.bwv.new) and temporary files left
 *   by a crash. A staged file is never promoted at start.
 */

#ifndef bwvstore_h
#define bwvstore_h

#include <stddef.h>
#include <stdint.h>

#include "bwvault.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BWS_VAULT "vault.bwv"
#define BWS_BACKUP "vault.bwv.bak"
#define BWS_STAGED "vault.bwv.new"
/* Present from just before a staged file is promoted until everything
 * after it (the backup, the keyring) is done; bwt_recover() finishes the
 * job if a crash came in between. */
#define BWS_CLEANUP_MARKER "cleanup-pending"

typedef struct bws_store bws_store;

/* `dir` is UTF-8. *perms_fixed is set when an existing file or the
 * directory had looser permissions and was tightened (Linux). */
bwv_status bws_open(const char* dir, bws_store** out, int* perms_fixed);
/* Releases the lock. */
void bws_close(bws_store* store);

/* The whole file, into plain malloc memory (free with bwv_bytes_free).
 * BWV_E_NOT_FOUND if it doesn't exist. */
bwv_status bws_read(bws_store* store, const char* name, uint8_t** data,
                    size_t* len);
int bws_exists(bws_store* store, const char* name);

/* Durably replace (or create) `name` with `data`. */
bwv_status bws_replace(bws_store* store, const char* name,
                       const uint8_t* data, size_t len);
/* Durably rename `from` over `to`. */
bwv_status bws_rename(bws_store* store, const char* from, const char* to);
/* Remove `name` if it exists, durably. */
bwv_status bws_remove(bws_store* store, const char* name);

#ifdef __cplusplus
}
#endif

#endif /* bwvstore_h */
