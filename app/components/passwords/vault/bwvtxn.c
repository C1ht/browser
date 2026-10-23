/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* See bwvtxn.h. */

#if defined(_WIN32) && defined(BWV_TESTING)
/* getenv() in the test hooks. */
#  define _CRT_SECURE_NO_WARNINGS
#endif

#include "bwvtxn.h"

#include <stdlib.h>
#include <string.h>

#include "sodium.h"

#ifdef BWV_TESTING
#  include <stdio.h>
#  ifdef _WIN32
#    include <process.h>
#  else
#    include <unistd.h>
#  endif

static const char* fail_step = NULL;
static char reached[128][48];
static int nreached = 0;

void bwv_test_fail_at(const char* step) { fail_step = step; }

int bwv_test_reached(const char* step) {
  for (int i = 0; i < nreached; i++) {
    if (strcmp(reached[i], step) == 0) {
      return 1;
    }
  }
  return 0;
}

void bwv_test_reset_reached(void) { nreached = 0; }

/* Called before each step: may end the process (BWV_CRASH_AT) or make the
 * step fail (bwv_test_fail_at). */
static int test_step(const char* step) {
  size_t n = strlen(step);
  if (!bwv_test_reached(step) && nreached < 128 && n < sizeof(reached[0])) {
    memcpy(reached[nreached++], step, n + 1);
  }
  const char* crash = getenv("BWV_CRASH_AT");
  if (crash && strcmp(crash, step) == 0) {
    fflush(NULL);
    _exit(86);
  }
  return fail_step && strcmp(fail_step, step) == 0;
}
#  define STEP_FAILS(step) test_step(step)
#else
#  define STEP_FAILS(step) 0
#endif

/* A step: fails as tests ask, or does `expr`. */
#define DO_STEP(step, expr) (STEP_FAILS(step) ? BWV_E_IO : (expr))

typedef struct {
  uint8_t id[BWV_ENTRY_ID_BYTES];
  char* origin;
  size_t origin_len;
  uint8_t* box; /* the password, under the session key */
  size_t box_len;
  uint8_t* patch; /* guarded */
  size_t patch_len;
} queued_t;

struct bwt_session {
  bws_store* store;
  bwt_providers providers;
  bwv_vault* vault;
  int busy;
  bwv_key* session_key;
  queued_t* queue;
  size_t queue_len;
};

struct bwt_replacement {
  bwv_vault* clone;
  uint8_t* file;
  size_t file_len;
  int keyring_stored;
  uint8_t keyring_gen[BWV_ITEM_TAG_BYTES];
  uint8_t old_keyring_gen[BWV_ITEM_TAG_BYTES];
  int had_keyring;
  int had_recovery;
  int had_hello;
  char code[BWV_RECOVERY_CHARS + 1];
};

/* ---- Session ---- */

bwt_session* bwt_session_new(bws_store* store, const bwt_providers* providers) {
  bwt_session* s = (bwt_session*)calloc(1, sizeof(*s));
  if (!s) {
    return NULL;
  }
  s->store = store;
  if (providers) {
    s->providers = *providers;
  }
  s->session_key = bwv_key_new();
  if (!s->session_key) {
    free(s);
    return NULL;
  }
  bwv_key_generate(s->session_key);
  return s;
}

static void free_queued(queued_t* q) {
  free(q->origin);
  free(q->box);
  bwv_secret_free(q->patch);
  memset(q, 0, sizeof(*q));
}

void bwt_session_free(bwt_session* s) {
  if (!s) {
    return;
  }
  for (size_t i = 0; i < s->queue_len; i++) {
    free_queued(&s->queue[i]);
  }
  free(s->queue);
  bwv_free(s->vault);
  bwv_key_free(s->session_key);
  free(s);
}

void bwt_attach(bwt_session* s, bwv_vault* vault) {
  bwv_free(s->vault);
  s->vault = vault;
}

bwv_vault* bwt_vault(bwt_session* s) { return s->vault; }

int bwt_busy(const bwt_session* s) { return s->busy; }

static int has_keyring(const bwt_session* s) {
  return s->providers.keyring_store && s->providers.keyring_lookup &&
         s->providers.keyring_delete_except;
}

static int has_hello(const bwt_session* s) {
  return s->providers.hello_sign != NULL;
}

int bwt_hello_prompts(const bwt_session* s) {
  return s->vault && has_hello(s) && bwv_has_slot(s->vault, BWV_SLOT_HELLO)
             ? 2
             : 0;
}

/* ---- Helpers ---- */

/* Derive a password key from `vault`'s password-slot inputs. */
static bwv_status password_key(const bwv_vault* vault, const char* pw,
                               size_t len, bwv_key* out) {
  bwv_kdf_params params;
  uint8_t salt[BWV_SALT_BYTES];
  bwv_status st = bwv_slot_inputs(vault, BWV_SLOT_PASSWORD, &params, salt, NULL);
  return st == BWV_OK ? bwv_derive_password_key(&params, salt, pw, len, out) : st;
}

/* Derive a recovery key from `vault`'s recovery-slot inputs. */
static bwv_status recovery_key(const bwv_vault* vault, const char* code,
                               size_t len, bwv_key* out) {
  bwv_kdf_params params;
  uint8_t salt[BWV_SALT_BYTES];
  bwv_status st = bwv_slot_inputs(vault, BWV_SLOT_RECOVERY, &params, salt, NULL);
  return st == BWV_OK ? bwv_derive_recovery_key(&params, salt, code, len, out) : st;
}

/* The file on disk opens with this password (or, for the recovery slot,
 * this recovery key): the check before a change. */
static bwv_status check_slot(bwt_session* s, bwv_slot_type type,
                             const char* pw, size_t len) {
  uint8_t* data;
  size_t data_len;
  bwv_status st = bws_read(s->store, BWS_VAULT, &data, &data_len);
  if (st != BWV_OK) {
    return st;
  }
  bwv_vault* v = bwv_new();
  bwv_key* key = bwv_key_new();
  if (!v || !key) {
    st = BWV_E_NOMEM;
  } else {
    st = bwv_load(v, data, data_len);
    if (st == BWV_OK) {
      st = type == BWV_SLOT_RECOVERY ? recovery_key(v, pw, len, key)
                                     : password_key(v, pw, len, key);
    }
    if (st == BWV_OK) {
      st = bwv_unlock(v, type, key);
    }
  }
  bwv_key_free(key);
  bwv_free(v);
  bwv_bytes_free(data);
  return st;
}

static bwv_status check_current(bwt_session* s, const char* pw, size_t len) {
  return check_slot(s, BWV_SLOT_PASSWORD, pw, len);
}

/* Prepare `type` with `params` (or none), derive its key with `derive`,
 * and set it. */
static bwv_status set_password_slot(bwv_vault* v, const bwv_kdf_params* params,
                                    const char* pw, size_t len) {
  bwv_kdf_params p;
  uint8_t salt[BWV_SALT_BYTES];
  bwv_key* key = bwv_key_new();
  if (!key) {
    return BWV_E_NOMEM;
  }
  bwv_status st = bwv_prepare_slot(v, BWV_SLOT_PASSWORD, params);
  if (st == BWV_OK) {
    st = bwv_prepared_inputs(v, BWV_SLOT_PASSWORD, &p, salt, NULL);
  }
  if (st == BWV_OK) {
    st = bwv_derive_password_key(&p, salt, pw, len, key);
  }
  if (st == BWV_OK) {
    st = bwv_set_slot(v, BWV_SLOT_PASSWORD, key);
  }
  bwv_key_free(key);
  return st;
}

/* Load `data` into a fresh vault. */
static bwv_status load_copy(const uint8_t* data, size_t len, bwv_vault** out) {
  bwv_vault* v = bwv_new();
  if (!v) {
    return BWV_E_NOMEM;
  }
  bwv_status st = bwv_load(v, data, len);
  if (st != BWV_OK) {
    bwv_free(v);
    return st;
  }
  *out = v;
  return BWV_OK;
}

/* Unlocking a freshly written file with a key we just made failing means
 * the file isn't what it must be. */
static bwv_status as_verify(bwv_status st) {
  return st == BWV_E_AUTH ? BWV_E_VERIFY : st;
}

/* Put a staged file in place: the marker; the rename; the backup; the
 * keyring entries of other generations (`keep_gen`, for a replacement);
 * the marker removed. *promoted says whether the rename happened: from
 * then on the new file is the vault, and later failures are BWV_E_CLEANUP. */
static bwv_status commit_staged(bwt_session* s, int replacement,
                                const uint8_t* file, size_t file_len,
                                const uint8_t* vault_id, const uint8_t* keep_gen,
                                int* promoted) {
  *promoted = 0;
  bwv_status st = DO_STEP(replacement ? "commit:marker" : "change-commit:marker",
                          bws_replace(s->store, BWS_CLEANUP_MARKER, NULL, 0));
  if (st == BWV_OK) {
    st = DO_STEP(replacement ? "commit:promote" : "change-commit:promote",
                 bws_rename(s->store, BWS_STAGED, BWS_VAULT));
  }
  if (st != BWV_OK) {
    bws_remove(s->store, BWS_CLEANUP_MARKER);
    return st;
  }
  *promoted = 1;
  bwv_status cleanup = BWV_OK;
  /* The browser's own backup: from now on, the new file. */
  if (DO_STEP(replacement ? "commit:backup" : "change-commit:backup",
              bws_replace(s->store, BWS_BACKUP, file, file_len)) != BWV_OK) {
    cleanup = BWV_E_CLEANUP;
  }
  if (replacement && cleanup == BWV_OK && has_keyring(s) &&
      DO_STEP("commit:keyring-cleanup",
              s->providers.keyring_delete_except(s->providers.ctx, vault_id,
                                                 keep_gen)) != BWV_OK) {
    cleanup = BWV_E_CLEANUP;
  }
  if (cleanup == BWV_OK &&
      DO_STEP(replacement ? "commit:marker-clear" : "change-commit:marker-clear",
              bws_remove(s->store, BWS_CLEANUP_MARKER)) != BWV_OK) {
    cleanup = BWV_E_CLEANUP;
  }
  return cleanup;
}

/* ---- Recovery at start ---- */

bwv_status bwt_recover(bwt_session* s) {
  uint8_t* data;
  size_t len;
  bwv_status st = bws_read(s->store, BWS_VAULT, &data, &len);
  if (st == BWV_E_NOT_FOUND) {
    /* No vault: a marker can only be a leftover. */
    return bws_remove(s->store, BWS_CLEANUP_MARKER);
  }
  if (st != BWV_OK) {
    return st;
  }
  bwv_vault* v = NULL;
  st = load_copy(data, len, &v);
  if (st != BWV_OK) {
    /* Not ours to repair; the caller reports a damaged vault. */
    bwv_bytes_free(data);
    return st;
  }
  bwv_status result = BWV_OK;
  if (has_keyring(s)) {
    uint8_t id[BWV_ID_BYTES], gen[BWV_ITEM_TAG_BYTES];
    bwv_get_id(v, id);
    const uint8_t* keep = NULL;
    if (bwv_slot_inputs(v, BWV_SLOT_KEYRING, NULL, gen, NULL) == BWV_OK) {
      keep = gen;
    }
    /* Entries of any other generation are left over from a replacement
     * that didn't finish, or from before one that did. */
    if (s->providers.keyring_delete_except(s->providers.ctx, id, keep) != BWV_OK) {
      result = BWV_E_CLEANUP;
    }
  }
  if (bws_exists(s->store, BWS_CLEANUP_MARKER)) {
    /* A commit was interrupted after its marker. Whether or not the rename
     * happened, vault.bwv is the vault now: refresh the backup from it. */
    if (bws_replace(s->store, BWS_BACKUP, data, len) != BWV_OK ||
        bws_remove(s->store, BWS_CLEANUP_MARKER) != BWV_OK) {
      result = BWV_E_CLEANUP;
    }
  }
  bwv_free(v);
  bwv_bytes_free(data);
  return result;
}

/* ---- Saving ---- */

bwv_status bwt_save(bwt_session* s) {
  if (!s->vault) {
    return BWV_E_STATE;
  }
  if (s->busy) {
    return BWV_E_BUSY;
  }
  uint8_t* file;
  size_t len;
  bwv_status st = DO_STEP("save:serialize", bwv_serialize(s->vault, &file, &len));
  if (st != BWV_OK) {
    return st;
  }
  uint8_t* old;
  size_t old_len;
  st = bws_read(s->store, BWS_VAULT, &old, &old_len);
  if (st == BWV_OK) {
    st = DO_STEP("save:backup", bws_replace(s->store, BWS_BACKUP, old, old_len));
    bwv_bytes_free(old);
  } else if (st == BWV_E_NOT_FOUND) {
    st = BWV_OK;
  }
  if (st == BWV_OK) {
    st = DO_STEP("save:write", bws_replace(s->store, BWS_VAULT, file, len));
  }
  bwv_bytes_free(file);
  return st;
}

/* ---- Master password change: re-wrap only ---- */

/* `current` opens `via` (the password slot for a change, the recovery
 * slot for a reset). */
static bwv_status change_password(bwt_session* s, bwv_slot_type via,
                                  const char* current, size_t current_len,
                                  const char* fresh, size_t fresh_len) {
  if (!s->vault) {
    return BWV_E_STATE;
  }
  if (s->busy) {
    return BWV_E_BUSY;
  }
  s->busy = 1;
  bwv_vault* clone = NULL;
  bwv_vault* check = NULL;
  uint8_t* file = NULL;
  size_t file_len = 0;
  uint8_t* staged = NULL;
  size_t staged_len = 0;
  bwv_key* key = NULL;
  bwv_kdf_params params;
  int promoted = 0;

  bwv_status st = DO_STEP("change:verify-current", check_slot(s, via, current, current_len));
  if (st == BWV_OK) {
    clone = bwv_clone(s->vault);
    st = DO_STEP("change:clone", clone ? BWV_OK : BWV_E_NOMEM);
  }
  if (st == BWV_OK) {
    /* The same KDF parameters, a fresh salt; the vault key stays. */
    st = bwv_slot_inputs(clone, BWV_SLOT_PASSWORD, &params, NULL, NULL);
  }
  if (st == BWV_OK) {
    st = DO_STEP("change:password", set_password_slot(clone, &params, fresh, fresh_len));
  }
  if (st == BWV_OK) {
    st = DO_STEP("change:serialize", bwv_serialize(clone, &file, &file_len));
  }
  if (st == BWV_OK) {
    st = DO_STEP("change:write-staged", bws_replace(s->store, BWS_STAGED, file, file_len));
  }
  if (st == BWV_OK) {
    st = DO_STEP("change:verify", bws_read(s->store, BWS_STAGED, &staged, &staged_len));
  }
  if (st == BWV_OK) {
    st = load_copy(staged, staged_len, &check);
  }
  if (st == BWV_OK) {
    key = bwv_key_new();
    st = key ? password_key(check, fresh, fresh_len, key) : BWV_E_NOMEM;
  }
  if (st == BWV_OK) {
    st = as_verify(bwv_unlock(check, BWV_SLOT_PASSWORD, key));
  }
  if (st == BWV_OK) {
    st = as_verify(bwv_open_body(check));
  }
  if (st == BWV_OK &&
      (!bwv_contents_equal(check, clone) ||
       !bwv_slot_equal(check, s->vault, BWV_SLOT_RECOVERY) ||
       !bwv_slot_equal(check, s->vault, BWV_SLOT_KEYRING) ||
       !bwv_slot_equal(check, s->vault, BWV_SLOT_HELLO))) {
    st = BWV_E_VERIFY;
  }
  if (st == BWV_OK) {
    st = commit_staged(s, 0, file, file_len, NULL, NULL, &promoted);
  } else {
    bws_remove(s->store, BWS_STAGED);
  }
  if (promoted) {
    bwv_free(s->vault);
    s->vault = clone;
    clone = NULL;
  }
  bwv_key_free(key);
  bwv_free(check);
  bwv_free(clone); /* wiped */
  bwv_bytes_free(file);
  bwv_bytes_free(staged);
  s->busy = 0;
  return st;
}

bwv_status bwt_change_password(bwt_session* s, const char* current,
                               size_t current_len, const char* fresh,
                               size_t fresh_len) {
  return change_password(s, BWV_SLOT_PASSWORD, current, current_len, fresh,
                         fresh_len);
}

bwv_status bwt_reset_password(bwt_session* s, const char* code,
                              size_t code_len, const char* fresh,
                              size_t fresh_len) {
  if (s->vault && !bwv_has_slot(s->vault, BWV_SLOT_RECOVERY)) {
    return BWV_E_NO_SLOT;
  }
  return change_password(s, BWV_SLOT_RECOVERY, code, code_len, fresh,
                         fresh_len);
}

/* ---- A new recovery key ---- */

bwv_status bwt_new_recovery_key(bwt_session* s, const char* current,
                                size_t current_len,
                                char code[BWV_RECOVERY_CHARS + 1]) {
  code[0] = 0;
  if (!s->vault) {
    return BWV_E_STATE;
  }
  if (s->busy) {
    return BWV_E_BUSY;
  }
  bwv_status st = DO_STEP("recovery:verify-current", check_current(s, current, current_len));
  /* On a copy, so a failed write leaves the old key (or none) in use. */
  bwv_vault* clone = NULL;
  if (st == BWV_OK) {
    clone = bwv_clone(s->vault);
    st = clone ? BWV_OK : BWV_E_NOMEM;
  }
  bwv_kdf_params params;
  if (st == BWV_OK) {
    /* The master password's parameters: the code has 160 bits anyway. */
    st = bwv_slot_inputs(clone, BWV_SLOT_PASSWORD, &params, NULL, NULL);
  }
  if (st == BWV_OK) {
    st = bwv_prepare_slot(clone, BWV_SLOT_RECOVERY, &params);
  }
  bwv_key* key = bwv_key_new();
  if (st == BWV_OK && !key) {
    st = BWV_E_NOMEM;
  }
  if (st == BWV_OK) {
    bwv_kdf_params p;
    uint8_t salt[BWV_SALT_BYTES];
    bwv_recovery_code_generate(code);
    st = bwv_prepared_inputs(clone, BWV_SLOT_RECOVERY, &p, salt, NULL);
    if (st == BWV_OK) {
      st = bwv_derive_recovery_key(&p, salt, code, strlen(code), key);
    }
  }
  if (st == BWV_OK) {
    st = DO_STEP("recovery:set", bwv_set_slot(clone, BWV_SLOT_RECOVERY, key));
  }
  bwv_key_free(key);
  if (st == BWV_OK) {
    bwv_vault* old = s->vault;
    s->vault = clone;
    st = bwt_save(s);
    if (st == BWV_OK) {
      clone = old;
    } else {
      s->vault = old;
    }
  }
  bwv_free(clone); /* wiped */
  if (st != BWV_OK) {
    sodium_memzero(code, BWV_RECOVERY_CHARS + 1);
  }
  return st;
}

/* ---- Replacing the encryption key ---- */

static void discard_replacement(bwt_session* s, bwt_replacement* r) {
  bws_remove(s->store, BWS_STAGED);
  if (r->keyring_stored) {
    /* Back to the old generation only (or none). */
    uint8_t id[BWV_ID_BYTES];
    bwv_get_id(s->vault, id);
    s->providers.keyring_delete_except(s->providers.ctx, id,
                                       r->had_keyring ? r->old_keyring_gen : NULL);
  }
  bwv_free(r->clone); /* wipes the new keys, index and passwords */
  bwv_bytes_free(r->file);
  sodium_memzero(r->code, sizeof(r->code));
  free(r);
  s->busy = 0;
}

bwv_status bwt_replace_prepare(bwt_session* s, const char* current,
                               size_t current_len, const char* fresh,
                               size_t fresh_len, bwt_replacement** out,
                               char code[BWV_RECOVERY_CHARS + 1]) {
  code[0] = 0;
  if (!s->vault) {
    return BWV_E_STATE;
  }
  if (s->busy) {
    return BWV_E_BUSY;
  }
  bwt_replacement* r = (bwt_replacement*)calloc(1, sizeof(*r));
  if (!r) {
    return BWV_E_NOMEM;
  }
  s->busy = 1;
  uint8_t id[BWV_ID_BYTES];
  bwv_get_id(s->vault, id);
  r->had_recovery = bwv_has_slot(s->vault, BWV_SLOT_RECOVERY);
  r->had_keyring = has_keyring(s) && bwv_has_slot(s->vault, BWV_SLOT_KEYRING);
  r->had_hello = has_hello(s) && bwv_has_slot(s->vault, BWV_SLOT_HELLO);
  if (r->had_keyring) {
    bwv_slot_inputs(s->vault, BWV_SLOT_KEYRING, NULL, r->old_keyring_gen, NULL);
  }
  bwv_kdf_params pw_params, rec_params;
  bwv_slot_inputs(s->vault, BWV_SLOT_PASSWORD, &pw_params, NULL, NULL);
  if (r->had_recovery) {
    bwv_slot_inputs(s->vault, BWV_SLOT_RECOVERY, &rec_params, NULL, NULL);
  }
  uint8_t challenge[BWV_CHALLENGE_BYTES];
  uint8_t sig[BWT_MAX_SIGNATURE];
  size_t sig_len = 0;
  bwv_key* key = bwv_key_new();
  bwv_vault* check = NULL;
  uint8_t* staged = NULL;
  size_t staged_len = 0;

  bwv_status st = key ? BWV_OK : BWV_E_NOMEM;
  if (st == BWV_OK) {
    st = DO_STEP("replace:verify-current", check_current(s, current, current_len));
  }
  if (st == BWV_OK) {
    r->clone = bwv_clone(s->vault);
    st = DO_STEP("replace:clone", r->clone ? BWV_OK : BWV_E_NOMEM);
  }
  if (st == BWV_OK) {
    /* New vault key; index and passwords re-encrypted inside the core;
     * every slot dropped. */
    st = DO_STEP("replace:rekey", bwv_replace_key(r->clone));
  }
  if (st == BWV_OK) {
    st = DO_STEP("replace:password", set_password_slot(r->clone, &pw_params, fresh, fresh_len));
  }
  if (st == BWV_OK && r->had_recovery) {
    bwv_kdf_params p;
    uint8_t salt[BWV_SALT_BYTES];
    st = DO_STEP("replace:recovery", bwv_prepare_slot(r->clone, BWV_SLOT_RECOVERY, &rec_params));
    if (st == BWV_OK) {
      bwv_recovery_code_generate(r->code);
      st = bwv_prepared_inputs(r->clone, BWV_SLOT_RECOVERY, &p, salt, NULL);
    }
    if (st == BWV_OK) {
      st = bwv_derive_recovery_key(&p, salt, r->code, strlen(r->code), key);
    }
    if (st == BWV_OK) {
      st = bwv_set_slot(r->clone, BWV_SLOT_RECOVERY, key);
    }
  }
  if (st == BWV_OK && r->had_keyring) {
    uint8_t raw[BWV_KEY_BYTES];
    st = bwv_prepare_slot(r->clone, BWV_SLOT_KEYRING, NULL);
    if (st == BWV_OK) {
      st = bwv_prepared_inputs(r->clone, BWV_SLOT_KEYRING, NULL, r->keyring_gen, NULL);
    }
    if (st == BWV_OK) {
      bwv_key_generate(key);
      bwv_key_export(key, raw);
      /* A new entry, under the new generation; the old one stays until
       * commit. */
      st = DO_STEP("replace:keyring-store",
                   s->providers.keyring_store(s->providers.ctx, id, r->keyring_gen, raw));
      r->keyring_stored = st == BWV_OK;
      sodium_memzero(raw, sizeof(raw));
    }
    if (st == BWV_OK) {
      st = bwv_set_slot(r->clone, BWV_SLOT_KEYRING, key);
    }
    if (st != BWV_OK && st != BWV_E_IO) {
      st = BWV_E_PROVIDER;
    }
  }
  if (st == BWV_OK && r->had_hello) {
    /* The first of the two Hello prompts. */
    st = bwv_prepare_slot(r->clone, BWV_SLOT_HELLO, NULL);
    if (st == BWV_OK) {
      st = bwv_prepared_inputs(r->clone, BWV_SLOT_HELLO, NULL, challenge, NULL);
    }
    if (st == BWV_OK) {
      sig_len = sizeof(sig);
      st = DO_STEP("replace:hello-enrol",
                   s->providers.hello_sign(s->providers.ctx, id, challenge, sig, &sig_len));
    }
    if (st == BWV_OK) {
      st = bwv_derive_hello_key(id, sig, sig_len, key);
    }
    sodium_memzero(sig, sizeof(sig));
    if (st == BWV_OK) {
      st = bwv_set_slot(r->clone, BWV_SLOT_HELLO, key);
    }
  }
  if (st == BWV_OK) {
    st = DO_STEP("replace:serialize", bwv_serialize(r->clone, &r->file, &r->file_len));
  }
  if (st == BWV_OK) {
    st = DO_STEP("replace:write-staged",
                 bws_replace(s->store, BWS_STAGED, r->file, r->file_len));
  }

  /* Open what was written, from disk, with every way in. */
  if (st == BWV_OK) {
    st = DO_STEP("replace:verify-load", bws_read(s->store, BWS_STAGED, &staged, &staged_len));
  }
  if (st == BWV_OK) {
    st = as_verify(load_copy(staged, staged_len, &check));
  }
  if (st == BWV_OK) {
    st = DO_STEP("replace:verify-password", password_key(check, fresh, fresh_len, key));
  }
  if (st == BWV_OK) {
    st = as_verify(bwv_unlock(check, BWV_SLOT_PASSWORD, key));
  }
  if (st == BWV_OK) {
    st = as_verify(bwv_open_body(check));
  }
  if (st == BWV_OK && !bwv_contents_equal(check, r->clone)) {
    st = BWV_E_VERIFY;
  }
  if (st == BWV_OK && r->had_recovery) {
    bwv_kdf_params p;
    uint8_t salt[BWV_SALT_BYTES];
    st = DO_STEP("replace:verify-recovery",
                 bwv_slot_inputs(check, BWV_SLOT_RECOVERY, &p, salt, NULL));
    if (st == BWV_OK) {
      st = bwv_derive_recovery_key(&p, salt, r->code, strlen(r->code), key);
    }
    if (st == BWV_OK) {
      st = as_verify(bwv_unlock(check, BWV_SLOT_RECOVERY, key));
    }
  }
  if (st == BWV_OK && r->had_keyring) {
    /* A fresh lookup, not the key in hand. */
    uint8_t raw[BWV_KEY_BYTES];
    st = DO_STEP("replace:verify-keyring",
                 s->providers.keyring_lookup(s->providers.ctx, id, r->keyring_gen, raw));
    if (st == BWV_OK) {
      bwv_key_import(key, raw);
      st = as_verify(bwv_unlock(check, BWV_SLOT_KEYRING, key));
    } else if (st != BWV_E_IO) {
      st = BWV_E_PROVIDER;
    }
    sodium_memzero(raw, sizeof(raw));
  }
  if (st == BWV_OK && r->had_hello) {
    /* The second Hello prompt: the signature must come out the same, or
     * Hello unlock would quietly stop working. */
    sig_len = sizeof(sig);
    st = DO_STEP("replace:verify-hello",
                 s->providers.hello_sign(s->providers.ctx, id, challenge, sig, &sig_len));
    if (st == BWV_OK) {
      st = bwv_derive_hello_key(id, sig, sig_len, key);
    }
    sodium_memzero(sig, sizeof(sig));
    if (st == BWV_OK) {
      st = as_verify(bwv_unlock(check, BWV_SLOT_HELLO, key));
    }
  }

  bwv_key_free(key);
  bwv_free(check);
  bwv_bytes_free(staged);
  sodium_memzero(challenge, sizeof(challenge));
  if (st != BWV_OK) {
    discard_replacement(s, r);
    return st;
  }
  memcpy(code, r->code, sizeof(r->code));
  *out = r;
  return BWV_OK;
}

bwv_status bwt_replace_commit(bwt_session* s, bwt_replacement* r) {
  uint8_t id[BWV_ID_BYTES];
  bwv_get_id(s->vault, id);
  int promoted = 0;
  bwv_status st = commit_staged(s, 1, r->file, r->file_len, id,
                                r->had_keyring ? r->keyring_gen : NULL, &promoted);
  if (!promoted) {
    discard_replacement(s, r);
    return st;
  }
  bwv_free(s->vault); /* wipes the old keys */
  s->vault = r->clone;
  r->clone = NULL;
  r->keyring_stored = 0; /* it is the current generation now */
  discard_replacement(s, r);
  return st;
}

void bwt_replace_abort(bwt_session* s, bwt_replacement* r) {
  discard_replacement(s, r);
}

/* ---- The queue ---- */

static size_t queue_ad(const uint8_t id[BWV_ENTRY_ID_BYTES], const char* origin,
                       size_t origin_len, uint8_t* ad) {
  memcpy(ad, id, BWV_ENTRY_ID_BYTES);
  memcpy(ad + BWV_ENTRY_ID_BYTES, origin, origin_len);
  return BWV_ENTRY_ID_BYTES + origin_len;
}

bwv_status bwt_queue_save(bwt_session* s,
                          const uint8_t entry_id[BWV_ENTRY_ID_BYTES],
                          const char* origin, size_t origin_len,
                          const uint8_t* secret, size_t secret_len,
                          const uint8_t* patch, size_t patch_len) {
  if (!origin || !origin_len || origin_len > BWV_MAX_ORIGIN) {
    return BWV_E_ARG;
  }
  queued_t q;
  memset(&q, 0, sizeof(q));
  memcpy(q.id, entry_id, BWV_ENTRY_ID_BYTES);
  uint8_t ad[BWV_ENTRY_ID_BYTES + BWV_MAX_ORIGIN];
  size_t ad_len = queue_ad(entry_id, origin, origin_len, ad);
  bwv_status st = bwv_box_seal(s->session_key, ad, ad_len, secret, secret_len,
                               &q.box, &q.box_len);
  q.origin = (char*)malloc(origin_len);
  q.patch = (uint8_t*)sodium_malloc(patch_len ? patch_len : 1);
  queued_t* grown = (queued_t*)realloc(s->queue, (s->queue_len + 1) * sizeof(queued_t));
  if (grown) {
    s->queue = grown;
  }
  if (st != BWV_OK || !q.origin || !q.patch || !grown) {
    free_queued(&q);
    return st != BWV_OK ? st : BWV_E_NOMEM;
  }
  memcpy(q.origin, origin, origin_len);
  q.origin_len = origin_len;
  if (patch_len) {
    memcpy(q.patch, patch, patch_len);
  }
  q.patch_len = patch_len;
  s->queue[s->queue_len++] = q;
  return BWV_OK;
}

size_t bwt_queue_length(const bwt_session* s) { return s->queue_len; }

bwv_status bwt_queue_apply(bwt_session* s, bwt_patch_fn apply_patch, void* ctx) {
  if (!s->vault) {
    return BWV_E_STATE;
  }
  if (s->busy) {
    return BWV_E_BUSY;
  }
  if (!s->queue_len) {
    return BWV_OK;
  }
  /* Applying is idempotent (a password replaces the entry's; patches are
   * by entry), so after a failure the whole queue is simply applied again
   * next time. Nothing is removed until it has been saved. */
  bwv_status st = BWV_OK;
  for (size_t i = 0; i < s->queue_len && st == BWV_OK; i++) {
    queued_t* q = &s->queue[i];
    uint8_t ad[BWV_ENTRY_ID_BYTES + BWV_MAX_ORIGIN];
    size_t ad_len = queue_ad(q->id, q->origin, q->origin_len, ad);
    uint8_t* secret = NULL;
    size_t secret_len = 0;
    st = DO_STEP("queue:apply", bwv_box_open(s->session_key, ad, ad_len, q->box,
                                             q->box_len, &secret, &secret_len));
    if (st == BWV_OK) {
      st = bwv_set_secret(s->vault, q->id, q->origin, q->origin_len, secret, secret_len);
      bwv_secret_free(secret);
    }
    if (st == BWV_OK) {
      st = apply_patch(ctx, s->vault, q->patch, q->patch_len);
    }
  }
  if (st == BWV_OK) {
    st = DO_STEP("queue:save", bwt_save(s));
  }
  if (st != BWV_OK) {
    return st;
  }
  for (size_t i = 0; i < s->queue_len; i++) {
    free_queued(&s->queue[i]);
  }
  free(s->queue);
  s->queue = NULL;
  s->queue_len = 0;
  return BWV_OK;
}
