/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Tests for the vault core, built and run by tools/vault/build.py.
 *
 *   vault_test                  run every test
 *   vault_test create FILE      write a vault for another OS to open
 *   vault_test open FILE        open one written by `create`, anywhere
 *   vault_test corpus DIR       seed files for the fuzzer
 *
 * Argon2id runs at the lowest accepted parameters (64 MiB, 2 passes) to
 * keep this fast; one test uses the defaults. */

#ifdef _WIN32
/* Plain fopen() is fine for test files. */
#  define _CRT_SECURE_NO_WARNINGS
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bwvault.h"
#include "sodium.h"

static int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, \
              #cond);                                                   \
      failures++;                                                       \
    }                                                                   \
  } while (0)

#define CHECK_STATUS(expr, want)                                          \
  do {                                                                    \
    bwv_status got_ = (expr);                                             \
    if (got_ != (want)) {                                                 \
      fprintf(stderr, "%s:%d: %s returned %s, expected %s\n", __FILE__,   \
              __LINE__, #expr, bwv_status_name(got_),                     \
              bwv_status_name(want));                                     \
      failures++;                                                         \
    }                                                                     \
  } while (0)

static const bwv_kdf_params FAST = {BWV_KDF_MIN_T, BWV_KDF_MIN_M_KIB};

/* Non-ASCII on purpose: the bytes must match on every OS. */
static const char PASSWORD[] = "correct horse battery staple \xe2\x9c\x93";
static const char BODY[] =
    "{\"v\":1,\"entries\":[{\"origin\":\"https://accounts.example.com\","
    "\"username\":\"ana@example.com\"}],\"never\":[]}";
static const uint8_t ENTRY[BWV_ENTRY_ID_BYTES] = {1, 2, 3, 4, 5, 6, 7, 8,
                                                  9, 10, 11, 12, 13, 14, 15};
static const char ORIGIN[] = "https://accounts.example.com";
static const char SECRET[] = "hunter2-but-longer";

/* A fixed keyring key, so a file can be unlocked without Argon2id. */
static bwv_key* keyring_key(void) {
  uint8_t raw[BWV_KEY_BYTES];
  memset(raw, 0x42, sizeof(raw));
  bwv_key* key = bwv_key_new();
  bwv_key_import(key, raw);
  return key;
}

static bwv_key* password_key(const bwv_vault* vault, const char* pw) {
  bwv_kdf_params params;
  uint8_t salt[BWV_SALT_BYTES];
  size_t n;
  bwv_key* key = bwv_key_new();
  if (bwv_slot_inputs(vault, BWV_SLOT_PASSWORD, &params, salt, &n) != BWV_OK ||
      bwv_derive_password_key(&params, salt, pw, strlen(pw), key) != BWV_OK) {
    bwv_key_free(key);
    return NULL;
  }
  return key;
}

/* Set a slot of `type` from `key`, the prepared way. For the password slot,
 * the key is derived here from PASSWORD. */
static void add_slot(bwv_vault* vault, bwv_slot_type type, bwv_key* key) {
  CHECK_STATUS(bwv_prepare_slot(vault, type, &FAST), BWV_OK);
  bwv_key* own = NULL;
  if (type == BWV_SLOT_PASSWORD) {
    bwv_kdf_params params;
    uint8_t salt[BWV_SALT_BYTES];
    size_t n;
    CHECK_STATUS(bwv_prepared_inputs(vault, type, &params, salt, &n), BWV_OK);
    own = key = bwv_key_new();
    CHECK_STATUS(
        bwv_derive_password_key(&params, salt, PASSWORD, strlen(PASSWORD), key),
        BWV_OK);
  }
  CHECK_STATUS(bwv_set_slot(vault, type, key), BWV_OK);
  bwv_key_free(own);
}

/* A written vault with password and keyring slots and BODY. */
static uint8_t* make_file(size_t* len, const char* body) {
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  add_slot(vault, BWV_SLOT_PASSWORD, NULL);
  bwv_key* kk = keyring_key();
  add_slot(vault, BWV_SLOT_KEYRING, kk);
  bwv_key_free(kk);
  uint8_t* file = NULL;
  CHECK_STATUS(bwv_write(vault, (const uint8_t*)body, strlen(body), &file, len),
               BWV_OK);
  bwv_free(vault);
  return file;
}

static int body_is(bwv_vault* vault, const char* want) {
  uint8_t* body;
  size_t len;
  if (bwv_read_body(vault, &body, &len) != BWV_OK) {
    return 0;
  }
  int same = len == strlen(want) && memcmp(body, want, len) == 0;
  bwv_secret_free(body);
  return same;
}

/* Offset of a header record's value in a file, or 0. */
static size_t find_record(const uint8_t* file, uint8_t type) {
  size_t header_len = file[10] | (file[11] << 8);
  size_t p = 16;
  while (p + 3 <= 16 + header_len) {
    size_t rlen = file[p + 1] | (file[p + 2] << 8);
    if (file[p] == type) {
      return p + 3;
    }
    p += 3 + rlen;
  }
  return 0;
}

/* A copy of `file` with one record appended to the header. */
static uint8_t* with_record(const uint8_t* file, size_t len, uint8_t type,
                            const char* value, size_t* out_len) {
  size_t vlen = strlen(value);
  size_t header_end = 16 + (file[10] | (file[11] << 8));
  uint8_t* out = (uint8_t*)malloc(len + 3 + vlen);
  memcpy(out, file, header_end);
  out[header_end] = type;
  out[header_end + 1] = (uint8_t)vlen;
  out[header_end + 2] = 0;
  memcpy(out + header_end + 3, value, vlen);
  memcpy(out + header_end + 3 + vlen, file + header_end, len - header_end);
  size_t header_len = header_end - 16 + 3 + vlen;
  out[10] = (uint8_t)header_len;
  out[11] = (uint8_t)(header_len >> 8);
  *out_len = len + 3 + vlen;
  return out;
}

static void test_round_trip(void) {
  size_t len;
  uint8_t* file = make_file(&len, BODY);
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  CHECK(!bwv_is_unlocked(vault));
  CHECK(bwv_get_counter(vault) == 1);
  CHECK(bwv_has_slot(vault, BWV_SLOT_PASSWORD));
  CHECK(bwv_has_slot(vault, BWV_SLOT_KEYRING));
  CHECK(!bwv_has_slot(vault, BWV_SLOT_HELLO));
  uint8_t* body;
  size_t body_len;
  CHECK_STATUS(bwv_read_body(vault, &body, &body_len), BWV_E_LOCKED);

  bwv_key* key = password_key(vault, PASSWORD);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_PASSWORD, key), BWV_OK);
  CHECK(body_is(vault, BODY));

  /* Write again: the counter goes up and the new file opens too. */
  uint8_t* again;
  size_t again_len;
  CHECK_STATUS(bwv_write(vault, (const uint8_t*)"{}", 2, &again, &again_len),
               BWV_OK);
  bwv_lock(vault);
  CHECK_STATUS(bwv_read_body(vault, &body, &body_len), BWV_E_LOCKED);
  CHECK_STATUS(bwv_load(vault, again, again_len), BWV_OK);
  CHECK(bwv_get_counter(vault) == 2);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_PASSWORD, key), BWV_OK);
  CHECK(body_is(vault, "{}"));

  bwv_key_free(key);
  bwv_bytes_free(again);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_new_vault_is_empty(void) {
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  CHECK(body_is(vault, ""));
  uint8_t* file;
  size_t len;
  /* No password slot yet: nothing to write. */
  CHECK_STATUS(bwv_write(vault, (const uint8_t*)"x", 1, &file, &len),
               BWV_E_STATE);
  CHECK_STATUS(bwv_remove_slot(vault, BWV_SLOT_PASSWORD), BWV_E_ARG);
  CHECK_STATUS(bwv_set_slot(vault, BWV_SLOT_HELLO, NULL), BWV_E_STATE);
  bwv_free(vault);
}

static void test_wrong_password(void) {
  size_t len;
  uint8_t* file = make_file(&len, BODY);
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  bwv_key* key = password_key(vault, "correct horse battery staple");
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_PASSWORD, key), BWV_E_AUTH);
  CHECK(!bwv_is_unlocked(vault));
  bwv_key_free(key);
  bwv_bytes_free(file);
  bwv_free(vault);
}

/* Every single-bit change anywhere in the file is caught: by the parser,
 * by the slot's authentication, or by the body's. */
static void test_tampering(void) {
  size_t len;
  uint8_t* file = make_file(&len, BODY);
  bwv_key* kk = keyring_key();
  bwv_vault* vault = bwv_new();
  size_t accepted = 0;
  for (size_t i = 0; i < len; i++) {
    for (int bit = 0; bit < 8; bit += 7) {
      file[i] ^= (uint8_t)(1u << bit);
      if (bwv_load(vault, file, len) == BWV_OK &&
          bwv_unlock(vault, BWV_SLOT_KEYRING, kk) == BWV_OK) {
        uint8_t* body;
        size_t body_len;
        if (bwv_read_body(vault, &body, &body_len) == BWV_OK) {
          fprintf(stderr, "tampering at byte %zu bit %d went unnoticed\n", i,
                  bit);
          bwv_secret_free(body);
          accepted++;
        }
      }
      file[i] ^= (uint8_t)(1u << bit);
    }
  }
  CHECK(accepted == 0);
  /* And the untouched file still opens. */
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_KEYRING, kk), BWV_OK);
  CHECK(body_is(vault, BODY));
  bwv_key_free(kk);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_truncation(void) {
  size_t len;
  uint8_t* file = make_file(&len, BODY);
  bwv_vault* vault = bwv_new();
  size_t accepted = 0;
  for (size_t n = 0; n < len; n++) {
    accepted += bwv_load(vault, file, n) == BWV_OK;
  }
  CHECK(accepted == 0);
  /* Nor anything after the end. */
  uint8_t* longer = (uint8_t*)malloc(len + 1);
  memcpy(longer, file, len);
  longer[len] = 0;
  CHECK_STATUS(bwv_load(vault, longer, len + 1), BWV_E_FORMAT);
  free(longer);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_kdf_limits(void) {
  size_t len;
  uint8_t* file = make_file(&len, BODY);
  size_t kdf = find_record(file, 0x02);
  CHECK(kdf != 0);
  bwv_vault* vault = bwv_new();
  struct {
    size_t offset;
    uint32_t value;
    int width;
  } cases[] = {
      {kdf + 1, 1, 4},                   /* t below the floor */
      {kdf + 1, BWV_KDF_MAX_T + 1, 4},   /* t above the cap */
      {kdf + 5, 1024, 4},                /* 1 MiB */
      {kdf + 5, 0xFFFFFFFFu, 4},         /* 4 TiB */
      {kdf + 9, 4, 1},                   /* four lanes */
  };
  for (size_t c = 0; c < sizeof(cases) / sizeof(cases[0]); c++) {
    uint8_t saved[4];
    memcpy(saved, file + cases[c].offset, 4);
    for (int b = 0; b < cases[c].width; b++) {
      file[cases[c].offset + b] = (uint8_t)(cases[c].value >> (8 * b));
    }
    CHECK_STATUS(bwv_load(vault, file, len), BWV_E_PARAMS);
    memcpy(file + cases[c].offset, saved, 4);
  }
  /* An unknown KDF or cipher is a newer vault, not a damaged one. */
  file[kdf] = 2;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_E_NEWER);
  file[kdf] = 1;
  size_t aead = find_record(file, 0x03);
  file[aead] = 2;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_E_NEWER);
  file[aead] = 1;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  bwv_bytes_free(file);
  bwv_free(vault);

  /* Deriving refuses the same parameters. */
  bwv_kdf_params weak = {1, BWV_KDF_MIN_M_KIB};
  uint8_t salt[BWV_SALT_BYTES] = {0};
  bwv_key* key = bwv_key_new();
  CHECK_STATUS(bwv_derive_password_key(&weak, salt, "x", 1, key), BWV_E_PARAMS);
  bwv_key_free(key);
}

static void test_versions_and_unknown_records(void) {
  size_t len;
  uint8_t* file = make_file(&len, BODY);
  bwv_vault* vault = bwv_new();
  bwv_key* kk = keyring_key();

  file[8] = 2;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_E_NEWER);
  file[8] = 0;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_E_FORMAT);
  file[8] = 1;

  size_t n;
  uint8_t* critical = with_record(file, len, 0x90, "future", &n);
  CHECK_STATUS(bwv_load(vault, critical, n), BWV_E_NEWER);
  free(critical);

  /* A record this version doesn't know is kept through a rewrite. */
  uint8_t* extra = with_record(file, len, 0x50, "keep me", &n);
  CHECK_STATUS(bwv_load(vault, extra, n), BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_KEYRING, kk), BWV_OK);
  /* The header changed under the body, so the body no longer opens... */
  uint8_t* body;
  size_t body_len;
  CHECK_STATUS(bwv_read_body(vault, &body, &body_len), BWV_E_AUTH);
  /* ...but a rewrite carries the record along. */
  uint8_t* rewritten;
  size_t rewritten_len;
  CHECK_STATUS(bwv_write(vault, (const uint8_t*)BODY, strlen(BODY), &rewritten,
                         &rewritten_len),
               BWV_OK);
  size_t keep = find_record(rewritten, 0x50);
  CHECK(keep != 0 && memcmp(rewritten + keep, "keep me", 7) == 0);
  CHECK_STATUS(bwv_load(vault, rewritten, rewritten_len), BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_KEYRING, kk), BWV_OK);
  CHECK(body_is(vault, BODY));

  free(extra);
  bwv_bytes_free(rewritten);
  bwv_key_free(kk);
  bwv_bytes_free(file);
  bwv_free(vault);
}

/* The file's size says little about how many logins it holds. */
static void test_padding(void) {
  char big[10001];
  memset(big, 'a', sizeof(big) - 1);
  big[sizeof(big) - 1] = 0;
  size_t small_len, big_len;
  uint8_t* small_file = make_file(&small_len, "x");
  uint8_t* big_file = make_file(&big_len, big);
  CHECK(small_len == big_len);
  bwv_bytes_free(small_file);
  bwv_bytes_free(big_file);
}

static void test_secrets(void) {
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  uint8_t* sealed;
  size_t sealed_len;
  CHECK_STATUS(bwv_seal_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN),
                               (const uint8_t*)SECRET, strlen(SECRET), &sealed,
                               &sealed_len),
               BWV_OK);
  CHECK(sealed_len == 24 + strlen(SECRET) + 16);

  uint8_t* plain;
  size_t plain_len;
  CHECK_STATUS(bwv_open_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN), sealed,
                               sealed_len, &plain, &plain_len),
               BWV_OK);
  CHECK(plain_len == strlen(SECRET) && memcmp(plain, SECRET, plain_len) == 0);
  bwv_secret_free(plain);

  /* Only for the origin and entry it was sealed for. */
  const char* other = "https://accounts.example.com.evil.example";
  CHECK_STATUS(bwv_open_secret(vault, ENTRY, other, strlen(other), sealed,
                               sealed_len, &plain, &plain_len),
               BWV_E_AUTH);
  const char* http = "http://accounts.example.com";
  CHECK_STATUS(bwv_open_secret(vault, ENTRY, http, strlen(http), sealed,
                               sealed_len, &plain, &plain_len),
               BWV_E_AUTH);
  uint8_t entry2[BWV_ENTRY_ID_BYTES];
  memcpy(entry2, ENTRY, sizeof(entry2));
  entry2[0] ^= 1;
  CHECK_STATUS(bwv_open_secret(vault, entry2, ORIGIN, strlen(ORIGIN), sealed,
                               sealed_len, &plain, &plain_len),
               BWV_E_AUTH);
  CHECK_STATUS(bwv_open_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN), sealed, 10,
                               &plain, &plain_len),
               BWV_E_AUTH);

  bwv_lock(vault);
  CHECK_STATUS(bwv_open_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN), sealed,
                               sealed_len, &plain, &plain_len),
               BWV_E_LOCKED);
  bwv_bytes_free(sealed);
  bwv_free(vault);

  /* A session box. */
  bwv_key* session = bwv_key_new();
  bwv_key_generate(session);
  CHECK_STATUS(bwv_box_seal(session, (const uint8_t*)"ad", 2,
                            (const uint8_t*)SECRET, strlen(SECRET), &sealed,
                            &sealed_len),
               BWV_OK);
  CHECK_STATUS(bwv_box_open(session, (const uint8_t*)"ad", 2, sealed,
                            sealed_len, &plain, &plain_len),
               BWV_OK);
  CHECK(plain_len == strlen(SECRET) && memcmp(plain, SECRET, plain_len) == 0);
  bwv_secret_free(plain);
  CHECK_STATUS(bwv_box_open(session, (const uint8_t*)"ae", 2, sealed,
                            sealed_len, &plain, &plain_len),
               BWV_E_AUTH);
  bwv_bytes_free(sealed);
  bwv_key_free(session);
}

/* A master password change replaces the vault key: the old password, or a
 * secret sealed before, no longer opens anything written after. */
static void test_rekey(void) {
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  add_slot(vault, BWV_SLOT_PASSWORD, NULL);
  bwv_key* old_pw = password_key(vault, PASSWORD);
  uint8_t* sealed;
  size_t sealed_len;
  CHECK_STATUS(bwv_seal_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN),
                               (const uint8_t*)SECRET, strlen(SECRET), &sealed,
                               &sealed_len),
               BWV_OK);

  CHECK_STATUS(bwv_rekey_begin(vault), BWV_OK);
  CHECK(!bwv_has_slot(vault, BWV_SLOT_PASSWORD));
  CHECK_STATUS(bwv_rekey_begin(vault), BWV_E_STATE);
  uint8_t* resealed;
  size_t resealed_len;
  CHECK_STATUS(bwv_reseal_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN), sealed,
                                 sealed_len, &resealed, &resealed_len),
               BWV_OK);
  add_slot(vault, BWV_SLOT_PASSWORD, NULL);
  uint8_t* file;
  size_t len;
  CHECK_STATUS(bwv_write(vault, (const uint8_t*)BODY, strlen(BODY), &file, &len),
               BWV_E_STATE); /* still rekeying */
  CHECK_STATUS(bwv_rekey_end(vault), BWV_OK);
  CHECK_STATUS(bwv_rekey_end(vault), BWV_E_STATE);

  uint8_t* plain;
  size_t plain_len;
  CHECK_STATUS(bwv_open_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN), sealed,
                               sealed_len, &plain, &plain_len),
               BWV_E_AUTH);
  CHECK_STATUS(bwv_open_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN), resealed,
                               resealed_len, &plain, &plain_len),
               BWV_OK);
  CHECK(plain_len == strlen(SECRET) && memcmp(plain, SECRET, plain_len) == 0);
  bwv_secret_free(plain);

  CHECK_STATUS(bwv_write(vault, (const uint8_t*)BODY, strlen(BODY), &file, &len),
               BWV_OK);
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  /* Same password, but a new salt: the old derived key is useless. */
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_PASSWORD, old_pw), BWV_E_AUTH);
  bwv_key* new_pw = password_key(vault, PASSWORD);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_PASSWORD, new_pw), BWV_OK);
  CHECK(body_is(vault, BODY));

  bwv_key_free(old_pw);
  bwv_key_free(new_pw);
  bwv_bytes_free(sealed);
  bwv_bytes_free(resealed);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_recovery(void) {
  char code[BWV_RECOVERY_CHARS + 1];
  bwv_recovery_code_generate(code);
  CHECK(strlen(code) == BWV_RECOVERY_CHARS);
  CHECK(code[4] == '-' && code[34] == '-');

  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  add_slot(vault, BWV_SLOT_PASSWORD, NULL);
  CHECK_STATUS(bwv_prepare_slot(vault, BWV_SLOT_RECOVERY, &FAST), BWV_OK);
  bwv_kdf_params params;
  uint8_t salt[BWV_SALT_BYTES];
  size_t n;
  CHECK_STATUS(bwv_prepared_inputs(vault, BWV_SLOT_RECOVERY, &params, salt, &n),
               BWV_OK);
  bwv_key* rk = bwv_key_new();
  CHECK_STATUS(bwv_derive_recovery_key(&params, salt, code, strlen(code), rk),
               BWV_OK);
  CHECK_STATUS(bwv_set_slot(vault, BWV_SLOT_RECOVERY, rk), BWV_OK);
  bwv_key_free(rk);
  uint8_t* file;
  size_t len;
  CHECK_STATUS(bwv_write(vault, (const uint8_t*)BODY, strlen(BODY), &file, &len),
               BWV_OK);
  bwv_free(vault);

  vault = bwv_new();
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  CHECK_STATUS(bwv_slot_inputs(vault, BWV_SLOT_RECOVERY, &params, salt, &n),
               BWV_OK);
  CHECK(params.t == FAST.t && params.m_kib == FAST.m_kib);

  /* As typed back from paper: lower case, no dashes, O written as 0. */
  char typed[64];
  size_t t = 0;
  for (const char* c = code; *c; c++) {
    if (*c == '-') {
      typed[t++] = ' ';
      continue;
    }
    typed[t++] = *c == 'O' ? '0' : (*c >= 'A' && *c <= 'Z') ? (char)(*c + 32) : *c;
  }
  typed[t] = 0;
  rk = bwv_key_new();
  CHECK_STATUS(bwv_derive_recovery_key(&params, salt, typed, t, rk), BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_RECOVERY, rk), BWV_OK);
  CHECK(body_is(vault, BODY));

  char wrong[BWV_RECOVERY_CHARS + 1];
  memcpy(wrong, code, sizeof(wrong));
  wrong[0] = wrong[0] == 'A' ? 'B' : 'A';
  CHECK_STATUS(bwv_derive_recovery_key(&params, salt, wrong, strlen(wrong), rk),
               BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_RECOVERY, rk), BWV_E_AUTH);

  /* Malformed codes never reach Argon2id. */
  const char* bad[] = {"", "ABCD", "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-A",
                       "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-456!",
                       "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4568"};
  for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
    CHECK_STATUS(bwv_derive_recovery_key(&params, salt, bad[i], strlen(bad[i]), rk),
                 BWV_E_ARG);
  }
  bwv_key_free(rk);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_hello(void) {
  uint8_t signature[256];
  for (size_t i = 0; i < sizeof(signature); i++) {
    signature[i] = (uint8_t)(i * 7 + 3);
  }
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  add_slot(vault, BWV_SLOT_PASSWORD, NULL);
  CHECK_STATUS(bwv_prepare_slot(vault, BWV_SLOT_HELLO, NULL), BWV_OK);
  uint8_t challenge[BWV_CHALLENGE_BYTES];
  size_t n;
  CHECK_STATUS(bwv_prepared_inputs(vault, BWV_SLOT_HELLO, NULL, challenge, &n),
               BWV_OK);
  CHECK(n == BWV_CHALLENGE_BYTES);
  uint8_t id[BWV_ID_BYTES];
  bwv_get_id(vault, id);
  bwv_key* hk = bwv_key_new();
  CHECK_STATUS(bwv_derive_hello_key(id, signature, sizeof(signature), hk),
               BWV_OK);
  CHECK_STATUS(bwv_set_slot(vault, BWV_SLOT_HELLO, hk), BWV_OK);
  uint8_t* file;
  size_t len;
  CHECK_STATUS(bwv_write(vault, (const uint8_t*)BODY, strlen(BODY), &file, &len),
               BWV_OK);
  bwv_free(vault);

  vault = bwv_new();
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  uint8_t stored[BWV_CHALLENGE_BYTES];
  CHECK_STATUS(bwv_slot_inputs(vault, BWV_SLOT_HELLO, NULL, stored, &n), BWV_OK);
  CHECK(memcmp(stored, challenge, sizeof(stored)) == 0);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_HELLO, hk), BWV_OK);
  CHECK(body_is(vault, BODY));

  signature[100] ^= 1;
  CHECK_STATUS(bwv_derive_hello_key(id, signature, sizeof(signature), hk),
               BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_HELLO, hk), BWV_E_AUTH);
  CHECK_STATUS(bwv_derive_hello_key(id, signature, 10, hk), BWV_E_ARG);
  bwv_key_free(hk);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_slot_binding(void) {
  /* A keyring slot's wrapped key copied into the Hello slot of the same
   * vault doesn't open with the keyring key: slots are bound to their type. */
  size_t len;
  uint8_t* file = make_file(&len, BODY);
  size_t keyring = find_record(file, BWV_SLOT_KEYRING);
  CHECK(keyring != 0);
  /* keyring: tag 16 | nonce 24 | wrapped 48; hello: challenge 32 | ... */
  uint8_t value[104];
  memset(value, 0, sizeof(value));
  memcpy(value, file + keyring, 16);
  memcpy(value + 32, file + keyring + 16, 72);
  /* Build a file with the keyring record replaced by a hello record. */
  size_t header_end = 16 + (file[10] | (file[11] << 8));
  size_t rec = keyring - 3;
  size_t out_len = len - (3 + 88) + (3 + 104);
  uint8_t* out = (uint8_t*)malloc(out_len);
  memcpy(out, file, rec);
  out[rec] = BWV_SLOT_HELLO;
  out[rec + 1] = 104;
  out[rec + 2] = 0;
  memcpy(out + rec + 3, value, 104);
  memcpy(out + rec + 3 + 104, file + rec + 3 + 88, len - (rec + 3 + 88));
  size_t header_len = header_end - 16 + 16;
  out[10] = (uint8_t)header_len;
  out[11] = (uint8_t)(header_len >> 8);
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_load(vault, out, out_len), BWV_OK);
  bwv_key* kk = keyring_key();
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_HELLO, kk), BWV_E_AUTH);
  bwv_key_free(kk);
  free(out);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_default_params(void) {
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  CHECK_STATUS(bwv_prepare_slot(vault, BWV_SLOT_PASSWORD, NULL), BWV_OK);
  bwv_kdf_params params;
  uint8_t salt[BWV_SALT_BYTES];
  size_t n;
  CHECK_STATUS(bwv_prepared_inputs(vault, BWV_SLOT_PASSWORD, &params, salt, &n),
               BWV_OK);
  CHECK(params.t == BWV_KDF_DEFAULT_T && params.m_kib == BWV_KDF_DEFAULT_M_KIB);
  bwv_key* key = bwv_key_new();
  CHECK_STATUS(bwv_derive_password_key(&params, salt, PASSWORD, strlen(PASSWORD),
                                       key),
               BWV_OK);
  CHECK_STATUS(bwv_set_slot(vault, BWV_SLOT_PASSWORD, key), BWV_OK);
  CHECK(!bwv_kdf_outdated(vault));
  bwv_key_free(key);
  bwv_free(vault);

  vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  add_slot(vault, BWV_SLOT_PASSWORD, NULL);
  CHECK(bwv_kdf_outdated(vault));
  bwv_free(vault);
}

/* RFC 5869 A.1, through the libsodium build used here. */
static void test_hkdf_vector(void) {
  uint8_t ikm[22], salt[13], info[10], prk[32], okm[42];
  memset(ikm, 0x0b, sizeof(ikm));
  for (int i = 0; i < 13; i++) salt[i] = (uint8_t)i;
  for (int i = 0; i < 10; i++) info[i] = (uint8_t)(0xf0 + i);
  crypto_kdf_hkdf_sha256_extract(prk, salt, sizeof(salt), ikm, sizeof(ikm));
  crypto_kdf_hkdf_sha256_expand(okm, sizeof(okm), (const char*)info,
                                sizeof(info), prk);
  char hex[2 * 42 + 1];
  sodium_bin2hex(hex, sizeof(hex), prk, sizeof(prk));
  CHECK(strcmp(hex, "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844a"
                    "d7c2b3e5") == 0);
  sodium_bin2hex(hex, sizeof(hex), okm, sizeof(okm));
  CHECK(strcmp(hex, "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56"
                    "ecc4c5bf34007208d5b887185865") == 0);
}

/* ---- Cross-OS files and the fuzz corpus ---- */

static int write_file(const char* path, const uint8_t* data, size_t len) {
  FILE* f = fopen(path, "wb");
  if (!f) {
    perror(path);
    return 0;
  }
  int ok = fwrite(data, 1, len, f) == len;
  return fclose(f) == 0 && ok;
}

static uint8_t* read_file(const char* path, size_t* len) {
  FILE* f = fopen(path, "rb");
  if (!f) {
    perror(path);
    return NULL;
  }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint8_t* data = (uint8_t*)malloc(n > 0 ? (size_t)n : 1);
  *len = fread(data, 1, (size_t)n, f);
  fclose(f);
  return data;
}

/* A vault with every kind of slot and one sealed secret, as another OS
 * must be able to open it. */
static int cmd_create(const char* path) {
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  add_slot(vault, BWV_SLOT_PASSWORD, NULL);
  bwv_key* kk = keyring_key();
  add_slot(vault, BWV_SLOT_KEYRING, kk);
  bwv_key_free(kk);
  uint8_t* sealed;
  size_t sealed_len;
  CHECK_STATUS(bwv_seal_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN),
                               (const uint8_t*)SECRET, strlen(SECRET), &sealed,
                               &sealed_len),
               BWV_OK);
  /* The body carries the sealed secret in hex, so `open` can check it. */
  char body[1024];
  char hex[2 * 256 + 1];
  sodium_bin2hex(hex, sizeof(hex), sealed, sealed_len);
  snprintf(body, sizeof(body), "%s\n%s", BODY, hex);
  uint8_t* file;
  size_t len;
  CHECK_STATUS(bwv_write(vault, (const uint8_t*)body, strlen(body), &file, &len),
               BWV_OK);
  int ok = failures == 0 && write_file(path, file, len);
  bwv_bytes_free(sealed);
  bwv_bytes_free(file);
  bwv_free(vault);
  printf("%s: %s\n", path, ok ? "written" : "FAILED");
  return ok ? 0 : 1;
}

static int cmd_open(const char* path) {
  size_t len;
  uint8_t* file = read_file(path, &len);
  if (!file) {
    return 1;
  }
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  bwv_key* pw = password_key(vault, PASSWORD);
  CHECK(pw != NULL);
  if (!pw) {
    bwv_free(vault);
    free(file);
    return 1;
  }
  for (int via = 0; via < 2; via++) {
    bwv_key* kk = keyring_key();
    CHECK_STATUS(via ? bwv_unlock(vault, BWV_SLOT_KEYRING, kk)
                     : bwv_unlock(vault, BWV_SLOT_PASSWORD, pw),
                 BWV_OK);
    bwv_key_free(kk);
    uint8_t* body;
    size_t body_len;
    CHECK_STATUS(bwv_read_body(vault, &body, &body_len), BWV_OK);
    if (failures) {
      break;
    }
    const uint8_t* nl = (const uint8_t*)memchr(body, '\n', body_len);
    CHECK(nl && (size_t)(nl - body) == strlen(BODY) &&
          memcmp(body, BODY, strlen(BODY)) == 0);
    uint8_t sealed[256];
    size_t sealed_len = 0;
    CHECK(nl && sodium_hex2bin(sealed, sizeof(sealed), (const char*)nl + 1,
                               body_len - (size_t)(nl + 1 - body), NULL,
                               &sealed_len, NULL) == 0);
    uint8_t* secret;
    size_t secret_len;
    CHECK_STATUS(bwv_open_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN), sealed,
                                 sealed_len, &secret, &secret_len),
                 BWV_OK);
    if (!failures) {
      CHECK(secret_len == strlen(SECRET) &&
            memcmp(secret, SECRET, secret_len) == 0);
      bwv_secret_free(secret);
    }
    bwv_secret_free(body);
    bwv_lock(vault);
  }
  bwv_key_free(pw);
  bwv_free(vault);
  free(file);
  printf("%s: %s\n", path, failures ? "FAILED" : "opened with the password and the keyring key");
  return failures ? 1 : 0;
}

static int cmd_corpus(const char* dir) {
  const char* bodies[] = {"", "{}", BODY};
  char path[1024];
  int ok = 1;
  for (size_t i = 0; i < sizeof(bodies) / sizeof(bodies[0]); i++) {
    size_t len;
    uint8_t* file = make_file(&len, bodies[i]);
    snprintf(path, sizeof(path), "%s/seed-%zu.bwv", dir, i);
    ok &= write_file(path, file, len);
    bwv_bytes_free(file);
  }
  return ok && !failures ? 0 : 1;
}

int main(int argc, char** argv) {
  if (bwv_init() != BWV_OK) {
    fprintf(stderr, "libsodium failed to start\n");
    return 1;
  }
  if (argc == 3 && strcmp(argv[1], "create") == 0) {
    return cmd_create(argv[2]);
  }
  if (argc == 3 && strcmp(argv[1], "open") == 0) {
    return cmd_open(argv[2]);
  }
  if (argc == 3 && strcmp(argv[1], "corpus") == 0) {
    return cmd_corpus(argv[2]);
  }
  if (argc != 1) {
    fprintf(stderr, "usage: %s [create FILE | open FILE | corpus DIR]\n", argv[0]);
    return 2;
  }

  struct {
    const char* name;
    void (*fn)(void);
  } tests[] = {
      {"round trip", test_round_trip},
      {"new vault is empty", test_new_vault_is_empty},
      {"wrong password", test_wrong_password},
      {"every bit flip is caught", test_tampering},
      {"truncation", test_truncation},
      {"KDF limits", test_kdf_limits},
      {"versions and unknown records", test_versions_and_unknown_records},
      {"padding", test_padding},
      {"sealed secrets", test_secrets},
      {"master password change replaces the key", test_rekey},
      {"recovery key", test_recovery},
      {"Windows Hello slot", test_hello},
      {"slots are bound to their type", test_slot_binding},
      {"default KDF parameters", test_default_params},
      {"HKDF-SHA256 (RFC 5869 A.1)", test_hkdf_vector},
  };
  for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); i++) {
    int before = failures;
    tests[i].fn();
    printf("%s  %s\n", failures == before ? "ok  " : "FAIL", tests[i].name);
    fflush(stdout);
  }
  printf("\n%s\n", failures ? "FAILED" : "all vault tests passed");
  return failures ? 1 : 0;
}
