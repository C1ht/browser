/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* The password vault's file format and cryptography (docs/PASSWORDS.md §4,
 * §5). Plain C on libsodium, with no Gecko dependency, so it is built and
 * tested on its own too (tools/vault/build.py).
 *
 * A vault file is a small header in the clear, authenticated, then one
 * encrypted body:
 *
 *   prefix   "BWVAULT\0" | version u16 | header_len u16 | reserved u32
 *   header   records: type u8 | len u16 | value
 *   body     nonce 24 | ct_len u32 | ciphertext (padded payload + tag)
 *
 * The body's payload is the index and the sealed passwords, apart:
 *
 *   index_len u32 | count u32 | index (JSON, by convention) | records
 *   record   len u32 | entry id 16 | origin_len u16 | origin | sealed
 *
 * so the index can go to JavaScript while the passwords stay here, and the
 * whole vault can be re-encrypted without JavaScript touching either.
 *
 * The vault key (VK) is random. Each slot holds VK encrypted under one slot
 * key: the master password's (Argon2id), the recovery key's (Argon2id), the
 * Linux keyring's (stored there) or Windows Hello's (HKDF of a signature).
 * VK gives the index key (IK, for the body) and the secret key (SK, for each
 * password) through HKDF-SHA256.
 *
 * Keys, the index and opened passwords only live in libsodium's guarded
 * memory: page-locked, kept out of core dumps, keys no-access between uses.
 * Plaintext this API hands out is guarded too; free it with
 * bwv_secret_free().
 *
 * Not thread-safe per vault. bwv_derive_*() touch no vault and may run on
 * any thread; they are the slow calls (Argon2id).
 */

#ifndef bwvault_h
#define bwvault_h

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 1 was the first development format (index and passwords together); its
 * files are refused with BWV_E_OLDER. */
#define BWV_FORMAT_VERSION 2

#define BWV_KEY_BYTES 32
#define BWV_ID_BYTES 16
#define BWV_SALT_BYTES 16
#define BWV_ITEM_TAG_BYTES 16
#define BWV_CHALLENGE_BYTES 32
#define BWV_ENTRY_ID_BYTES 16
#define BWV_MAX_ORIGIN 2048
#define BWV_MAX_SECRET (64u * 1024u)

/* Recovery codes: 160 random bits as 32 base32 characters, shown in eight
 * dash-separated groups of four. */
#define BWV_RECOVERY_BYTES 20
#define BWV_RECOVERY_CHARS 39

/* Argon2id. libsodium runs one lane, so parallelism is always 1. */
#define BWV_KDF_DEFAULT_T 3u
#define BWV_KDF_DEFAULT_M_KIB (256u * 1024u)
#define BWV_KDF_MIN_T 2u
#define BWV_KDF_MAX_T 16u
#define BWV_KDF_MIN_M_KIB (64u * 1024u)
#define BWV_KDF_MAX_M_KIB (2048u * 1024u)

typedef enum {
  BWV_OK = 0,
  BWV_E_FORMAT,    /* not a vault file, or damaged */
  BWV_E_NEWER,     /* written by a newer version: leave it alone */
  BWV_E_OLDER,     /* an earlier development format, no longer read */
  BWV_E_PARAMS,    /* KDF parameters outside what is accepted */
  BWV_E_AUTH,      /* wrong password or key, or the data was changed */
  BWV_E_NO_SLOT,   /* no slot of that kind */
  BWV_E_NOT_FOUND, /* no such file or entry */
  BWV_E_LOCKED,    /* needs the vault key (and an opened body) */
  BWV_E_STATE,     /* not possible now */
  BWV_E_ARG,       /* bad argument (e.g. a malformed recovery code) */
  BWV_E_NOMEM,
  BWV_E_INIT,      /* libsodium could not start */
  BWV_E_IO,        /* reading or writing a file failed */
  BWV_E_IN_USE,    /* the vault is open in another process */
  BWV_E_BUSY,      /* a key replacement holds the write lock */
  BWV_E_PROVIDER,  /* the keyring or Windows Hello failed */
  BWV_E_CANCELLED, /* the user cancelled (e.g. the Hello prompt) */
  BWV_E_VERIFY,    /* the new file did not open as it must */
  BWV_E_CLEANUP    /* done, but tidying up afterwards must be retried */
} bwv_status;

typedef enum {
  BWV_SLOT_PASSWORD = 0x10,
  BWV_SLOT_RECOVERY = 0x11,
  BWV_SLOT_KEYRING = 0x12,
  BWV_SLOT_HELLO = 0x13
} bwv_slot_type;

typedef struct {
  uint32_t t;      /* passes */
  uint32_t m_kib;  /* memory, KiB */
} bwv_kdf_params;

typedef struct bwv_vault bwv_vault;
typedef struct bwv_key bwv_key;

/* Once per process, before anything else. */
bwv_status bwv_init(void);

const char* bwv_status_name(bwv_status status);

/* ---- Keys: 32 bytes of guarded memory ---- */

bwv_key* bwv_key_new(void);
void bwv_key_free(bwv_key* key);
void bwv_key_generate(bwv_key* key);
/* For the Linux keyring, which stores the key itself. */
void bwv_key_import(bwv_key* key, const uint8_t in[BWV_KEY_BYTES]);
void bwv_key_export(const bwv_key* key, uint8_t out[BWV_KEY_BYTES]);

/* Argon2id over the master password (NFC-normalised UTF-8, by the caller). */
bwv_status bwv_derive_password_key(const bwv_kdf_params* params,
                                   const uint8_t salt[BWV_SALT_BYTES],
                                   const char* password, size_t len,
                                   bwv_key* out);

/* Argon2id over a recovery code's 160 bits. Case, dashes and spaces are
 * ignored, and 0/1 read as O/I. BWV_E_ARG if it isn't 32 base32 characters. */
bwv_status bwv_derive_recovery_key(const bwv_kdf_params* params,
                                   const uint8_t salt[BWV_SALT_BYTES],
                                   const char* code, size_t len, bwv_key* out);

/* A new code, NUL-terminated: "ABCD-EFGH-...". */
void bwv_recovery_code_generate(char out[BWV_RECOVERY_CHARS + 1]);

/* HKDF-SHA256(signature, salt = vault id, "vault/v1/hello"). */
bwv_status bwv_derive_hello_key(const uint8_t vault_id[BWV_ID_BYTES],
                                const uint8_t* signature, size_t len,
                                bwv_key* out);

/* ---- Vaults ---- */

bwv_vault* bwv_new(void);
/* Wipes keys, index and passwords, and frees everything. */
void bwv_free(bwv_vault* vault);

/* A new, unlocked vault with a fresh id and vault key, an empty index and
 * no passwords. Prepare and set a password slot before writing. */
bwv_status bwv_create(bwv_vault* vault);

/* Parse a vault file. The vault stays locked. Everything an attacker could
 * put in a file is checked here; nothing is decrypted. */
bwv_status bwv_load(bwv_vault* vault, const uint8_t* data, size_t len);

/* A complete copy, keys included (in new guarded memory), for working on
 * without touching the original. The original must be unlocked and its
 * body open. NULL if out of memory or not possible. */
bwv_vault* bwv_clone(const bwv_vault* vault);

void bwv_get_id(const bwv_vault* vault, uint8_t out[BWV_ID_BYTES]);
uint64_t bwv_get_counter(const bwv_vault* vault);
int bwv_is_unlocked(const bwv_vault* vault);
int bwv_has_slot(const bwv_vault* vault, bwv_slot_type type);

/* What a slot's key is derived from: the KDF parameters and salt for the
 * password and recovery slots, the keyring generation tag, the Hello
 * challenge. `fixed` gets up to BWV_CHALLENGE_BYTES; *fixed_len says how
 * many. */
bwv_status bwv_slot_inputs(const bwv_vault* vault, bwv_slot_type type,
                           bwv_kdf_params* params, uint8_t* fixed,
                           size_t* fixed_len);

/* 1 when two vaults hold the same slot of `type`, byte for byte. */
int bwv_slot_equal(const bwv_vault* a, const bwv_vault* b, bwv_slot_type type);

/* True when the password slot's KDF parameters are below the defaults, so
 * the caller should prepare and set it again while it has the password. */
int bwv_kdf_outdated(const bwv_vault* vault);

/* Unlock with a slot's key. BWV_E_AUTH if it is the wrong key. */
bwv_status bwv_unlock(bwv_vault* vault, bwv_slot_type type,
                      const bwv_key* slot_key);
/* Wipe the keys, the index and the passwords. The loaded file stays, so it
 * can be unlocked again. */
void bwv_lock(bwv_vault* vault);

/* ---- Slots (the vault must be unlocked) ----
 *
 * Adding or replacing a slot is two steps: prepare picks fresh inputs (a
 * salt, a generation tag, a challenge), readable through
 * bwv_prepared_inputs(); the caller derives that slot's key from them; set
 * stores the vault key under it. Nothing changes until set. */

bwv_status bwv_prepare_slot(bwv_vault* vault, bwv_slot_type type,
                            const bwv_kdf_params* params);
bwv_status bwv_prepared_inputs(const bwv_vault* vault, bwv_slot_type type,
                               bwv_kdf_params* params, uint8_t* fixed,
                               size_t* fixed_len);
bwv_status bwv_set_slot(bwv_vault* vault, bwv_slot_type type,
                        const bwv_key* slot_key);
/* The password slot can't be removed. */
bwv_status bwv_remove_slot(bwv_vault* vault, bwv_slot_type type);

/* ---- Replacing the vault key ----
 *
 * A new vault key; every password is sealed again under it, inside the
 * core; every slot is dropped, since they all hold the old key. Meant for a
 * bwv_clone(): set the slots again, write, verify, then swap. */
bwv_status bwv_replace_key(bwv_vault* vault);

/* ---- Body: the index and the passwords ----
 *
 * After unlocking, bwv_open_body() decrypts the body into the vault. A
 * created vault's body is open from the start, empty. */

bwv_status bwv_open_body(bwv_vault* vault);

/* A guarded copy of the index. */
bwv_status bwv_get_index(const bwv_vault* vault, uint8_t** out, size_t* len);
bwv_status bwv_set_index(bwv_vault* vault, const uint8_t* index, size_t len);

/* One password per entry, sealed under SK with the vault id, the entry id
 * and the entry's origin as associated data: it opens only for the entry
 * and origin it was saved for. Setting replaces an entry's password. */
bwv_status bwv_set_secret(bwv_vault* vault,
                          const uint8_t entry_id[BWV_ENTRY_ID_BYTES],
                          const char* origin, size_t origin_len,
                          const uint8_t* secret, size_t len);
bwv_status bwv_get_secret(const bwv_vault* vault,
                          const uint8_t entry_id[BWV_ENTRY_ID_BYTES],
                          const char* origin, size_t origin_len,
                          uint8_t** out, size_t* out_len);
bwv_status bwv_remove_secret(bwv_vault* vault,
                             const uint8_t entry_id[BWV_ENTRY_ID_BYTES]);
size_t bwv_secret_count(const bwv_vault* vault);

/* 1 when both hold the same index and the same passwords (compared opened,
 * in constant time per password). Both must be unlocked with open bodies. */
int bwv_contents_equal(const bwv_vault* a, const bwv_vault* b);

/* Encrypt the body and serialise the whole file into *file (plain malloc;
 * free with bwv_bytes_free). The counter goes up by one. Needs an open body
 * and a password slot. */
bwv_status bwv_serialize(bwv_vault* vault, uint8_t** file, size_t* file_len);

/* ---- A box under any key: a login waiting to be saved, sealed under a
 * key that lives only for the session. ---- */

bwv_status bwv_box_seal(const bwv_key* key, const uint8_t* ad, size_t ad_len,
                        const uint8_t* msg, size_t len, uint8_t** out,
                        size_t* out_len);
bwv_status bwv_box_open(const bwv_key* key, const uint8_t* ad, size_t ad_len,
                        const uint8_t* box, size_t len, uint8_t** out,
                        size_t* out_len);

/* Plaintext from this API: zeroed, then freed. */
void bwv_secret_free(uint8_t* buf);
/* Ciphertext and files. */
void bwv_bytes_free(uint8_t* buf);

#ifdef BWV_TESTING
/* Only in the test build (tools/vault/build.py); a CI check makes sure none
 * of this reaches the browser. */

/* A fingerprint of the vault key, to tell whether it changed. */
void bwv_test_key_fingerprint(const bwv_vault* vault, uint8_t out[32]);
/* Give `dst` the keys of `src`, to try an old key on a new file. */
bwv_status bwv_test_adopt_keys(bwv_vault* dst, const bwv_vault* src);
/* A header record this version doesn't know, as a newer version would
 * write it. */
bwv_status bwv_test_add_unknown(bwv_vault* vault, uint8_t type,
                                const uint8_t* value, uint16_t len);
#endif

#ifdef __cplusplus
}
#endif

#endif /* bwvault_h */
