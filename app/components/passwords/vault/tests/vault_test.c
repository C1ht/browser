/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Tests for the vault core, store and transactions, built with BWV_TESTING
 * and run by tools/vault/build.py.
 *
 *   vault_test                       run every test
 *   vault_test create FILE           write a vault for another OS to open
 *   vault_test open FILE             open one written by `create`
 *   vault_test older FILE            check FILE is refused as BWV_E_OLDER
 *   vault_test corpus DIR            seed files for the fuzzer
 *   vault_test txn-child DIR FLOW    run FLOW (change, replace) on the vault
 *                                    in DIR; the crash tests start this with
 *                                    BWV_CRASH_AT set, so it dies mid-way
 *
 * Argon2id runs at the lowest accepted parameters (64 MiB, 2 passes) to
 * keep this fast; one test uses the defaults. */

#ifdef _WIN32
/* Plain fopen(), getenv() and friends are fine for test files. */
#  define _CRT_SECURE_NO_WARNINGS
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#  include <direct.h>
#  include <process.h>
#  include <windows.h>
#  include <aclapi.h>
#else
#  include <dirent.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <sys/wait.h>
#  include <unistd.h>
#endif

#include "bwvault.h"
#include "bwvstore.h"
#include "bwvtxn.h"
#include "sodium.h"

static int failures = 0;
static const char* self_path = NULL;

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
static const char PASSWORD2[] = "a different, longer passphrase \xc3\xa9";
static const char INDEX[] =
    "{\"v\":1,\"entries\":[{\"id\":\"AQIDBAUGBwgJCgsMDQ4PAA\","
    "\"origin\":\"https://accounts.example.com\","
    "\"username\":\"ana@example.com\"}],\"never\":[]}";
static const uint8_t ENTRY[BWV_ENTRY_ID_BYTES] = {1, 2, 3, 4, 5, 6, 7, 8,
                                                  9, 10, 11, 12, 13, 14, 15};
static const uint8_t ENTRY2[BWV_ENTRY_ID_BYTES] = {9, 9, 9, 9, 9, 9, 9, 9,
                                                   9, 9, 9, 9, 9, 9, 9, 9};
static const char ORIGIN[] = "https://accounts.example.com";
static const char ORIGIN2[] = "https://mail.example.org:8443";
static const char SECRET[] = "hunter2-but-longer";
static const char SECRET2[] = "\xe2\x80\x94 another \xe2\x80\x94";

/* ======================================================================
 * Small helpers
 * ====================================================================== */

static int write_file(const char* path, const void* data, size_t len) {
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

static void make_dir(const char* path) {
#ifdef _WIN32
  _mkdir(path);
#else
  mkdir(path, 0700);
#endif
}

/* Empty a directory (one level), then remove it. */
static void remove_dir(const char* dir) {
  char path[1024];
#ifdef _WIN32
  WIN32_FIND_DATAA fd;
  snprintf(path, sizeof(path), "%s\\*", dir);
  HANDLE h = FindFirstFileA(path, &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (strcmp(fd.cFileName, ".") && strcmp(fd.cFileName, "..")) {
        snprintf(path, sizeof(path), "%s\\%s", dir, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
          remove_dir(path);
        } else {
          DeleteFileA(path);
        }
      }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
  }
  RemoveDirectoryA(dir);
#else
  DIR* d = opendir(dir);
  if (d) {
    struct dirent* e;
    while ((e = readdir(d))) {
      if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) {
        snprintf(path, sizeof(path), "%s/%s", dir, e->d_name);
        struct stat st;
        if (lstat(path, &st) == 0 && S_ISDIR(st.st_mode)) {
          remove_dir(path);
        } else {
          unlink(path);
        }
      }
    }
    closedir(d);
  }
  rmdir(dir);
#endif
}

static void join(char* out, size_t n, const char* dir, const char* name) {
  snprintf(out, n, "%s/%s", dir, name);
}

static int file_exists(const char* dir, const char* name) {
  char path[1024];
  join(path, sizeof(path), dir, name);
  FILE* f = fopen(path, "rb");
  if (f) {
    fclose(f);
  }
  return f != NULL;
}

static int same_file(const char* dir, const char* name, const uint8_t* data,
                     size_t len) {
  char path[1024];
  join(path, sizeof(path), dir, name);
  size_t n;
  uint8_t* got = read_file(path, &n);
  int same = got && n == len && memcmp(got, data, len) == 0;
  free(got);
  return same;
}

static bwv_key* key_from_bytes(uint8_t byte) {
  uint8_t raw[BWV_KEY_BYTES];
  memset(raw, byte, sizeof(raw));
  bwv_key* key = bwv_key_new();
  bwv_key_import(key, raw);
  return key;
}

/* A fixed keyring key for the core tests, so a file can be unlocked
 * without Argon2id. */
static bwv_key* keyring_key(void) { return key_from_bytes(0x42); }

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

static void fill(bwv_vault* vault, const char* index) {
  CHECK_STATUS(bwv_set_index(vault, (const uint8_t*)index, strlen(index)), BWV_OK);
  CHECK_STATUS(bwv_set_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN),
                              (const uint8_t*)SECRET, strlen(SECRET)),
               BWV_OK);
  CHECK_STATUS(bwv_set_secret(vault, ENTRY2, ORIGIN2, strlen(ORIGIN2),
                              (const uint8_t*)SECRET2, strlen(SECRET2)),
               BWV_OK);
}

/* A written vault with password and keyring slots, `index` and two
 * passwords. */
static uint8_t* make_file(size_t* len, const char* index) {
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  add_slot(vault, BWV_SLOT_PASSWORD, NULL);
  bwv_key* kk = keyring_key();
  add_slot(vault, BWV_SLOT_KEYRING, kk);
  bwv_key_free(kk);
  fill(vault, index);
  uint8_t* file = NULL;
  CHECK_STATUS(bwv_serialize(vault, &file, len), BWV_OK);
  bwv_free(vault);
  return file;
}

static int index_is(const bwv_vault* vault, const char* want) {
  uint8_t* index;
  size_t len;
  if (bwv_get_index(vault, &index, &len) != BWV_OK) {
    return 0;
  }
  int same = len == strlen(want) && memcmp(index, want, len) == 0;
  bwv_secret_free(index);
  return same;
}

static int secret_is(const bwv_vault* vault, const uint8_t* id,
                     const char* origin, const char* want) {
  uint8_t* got;
  size_t len;
  if (bwv_get_secret(vault, id, origin, strlen(origin), &got, &len) != BWV_OK) {
    return 0;
  }
  int same = len == strlen(want) && memcmp(got, want, len) == 0;
  bwv_secret_free(got);
  return same;
}

/* Offset of a header record's value in a file, or 0. */
static size_t find_header_record(const uint8_t* file, uint8_t type) {
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

/* ======================================================================
 * The core
 * ====================================================================== */

static void test_round_trip(void) {
  size_t len;
  uint8_t* file = make_file(&len, INDEX);
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  CHECK(!bwv_is_unlocked(vault));
  CHECK(bwv_get_counter(vault) == 1);
  CHECK(bwv_has_slot(vault, BWV_SLOT_PASSWORD));
  CHECK(bwv_has_slot(vault, BWV_SLOT_KEYRING));
  CHECK(!bwv_has_slot(vault, BWV_SLOT_HELLO));
  CHECK_STATUS(bwv_open_body(vault), BWV_E_LOCKED);

  bwv_key* key = password_key(vault, PASSWORD);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_PASSWORD, key), BWV_OK);
  uint8_t* index;
  size_t index_len;
  CHECK_STATUS(bwv_get_index(vault, &index, &index_len), BWV_E_LOCKED);
  CHECK_STATUS(bwv_open_body(vault), BWV_OK);
  CHECK(index_is(vault, INDEX));
  CHECK(bwv_secret_count(vault) == 2);
  CHECK(secret_is(vault, ENTRY, ORIGIN, SECRET));
  CHECK(secret_is(vault, ENTRY2, ORIGIN2, SECRET2));

  /* Change, write again: the counter goes up and the new file opens too. */
  CHECK_STATUS(bwv_set_index(vault, (const uint8_t*)"{}", 2), BWV_OK);
  CHECK_STATUS(bwv_remove_secret(vault, ENTRY2), BWV_OK);
  CHECK_STATUS(bwv_remove_secret(vault, ENTRY2), BWV_E_NOT_FOUND);
  uint8_t* again;
  size_t again_len;
  CHECK_STATUS(bwv_serialize(vault, &again, &again_len), BWV_OK);
  bwv_lock(vault);
  CHECK_STATUS(bwv_get_index(vault, &index, &index_len), BWV_E_LOCKED);
  CHECK_STATUS(bwv_load(vault, again, again_len), BWV_OK);
  CHECK(bwv_get_counter(vault) == 2);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_PASSWORD, key), BWV_OK);
  CHECK_STATUS(bwv_open_body(vault), BWV_OK);
  CHECK(index_is(vault, "{}"));
  CHECK(bwv_secret_count(vault) == 1);
  CHECK(secret_is(vault, ENTRY, ORIGIN, SECRET));

  bwv_key_free(key);
  bwv_bytes_free(again);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_new_vault_is_empty(void) {
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  CHECK(index_is(vault, ""));
  CHECK(bwv_secret_count(vault) == 0);
  uint8_t* file;
  size_t len;
  /* No password slot yet: nothing to write. */
  CHECK_STATUS(bwv_serialize(vault, &file, &len), BWV_E_STATE);
  CHECK_STATUS(bwv_remove_slot(vault, BWV_SLOT_PASSWORD), BWV_E_ARG);
  CHECK_STATUS(bwv_set_slot(vault, BWV_SLOT_HELLO, NULL), BWV_E_STATE);
  bwv_free(vault);
}

static void test_wrong_password(void) {
  size_t len;
  uint8_t* file = make_file(&len, INDEX);
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
  uint8_t* file = make_file(&len, INDEX);
  bwv_key* kk = keyring_key();
  bwv_vault* vault = bwv_new();
  size_t accepted = 0;
  for (size_t i = 0; i < len; i++) {
    for (int bit = 0; bit < 8; bit += 7) {
      file[i] ^= (uint8_t)(1u << bit);
      if (bwv_load(vault, file, len) == BWV_OK &&
          bwv_unlock(vault, BWV_SLOT_KEYRING, kk) == BWV_OK &&
          bwv_open_body(vault) == BWV_OK) {
        fprintf(stderr, "tampering at byte %zu bit %d went unnoticed\n", i, bit);
        accepted++;
      }
      file[i] ^= (uint8_t)(1u << bit);
    }
  }
  CHECK(accepted == 0);
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_KEYRING, kk), BWV_OK);
  CHECK_STATUS(bwv_open_body(vault), BWV_OK);
  CHECK(index_is(vault, INDEX));
  bwv_key_free(kk);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_truncation(void) {
  size_t len;
  uint8_t* file = make_file(&len, INDEX);
  bwv_vault* vault = bwv_new();
  size_t accepted = 0;
  for (size_t n = 0; n < len; n++) {
    accepted += bwv_load(vault, file, n) == BWV_OK;
  }
  CHECK(accepted == 0);
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
  uint8_t* file = make_file(&len, INDEX);
  size_t kdf = find_header_record(file, 0x02);
  CHECK(kdf != 0);
  bwv_vault* vault = bwv_new();
  struct {
    size_t offset;
    uint32_t value;
    int width;
  } cases[] = {
      {kdf + 1, 1, 4},                 /* t below the floor */
      {kdf + 1, BWV_KDF_MAX_T + 1, 4}, /* t above the cap */
      {kdf + 5, 1024, 4},              /* 1 MiB */
      {kdf + 5, 0xFFFFFFFFu, 4},       /* 4 TiB */
      {kdf + 9, 4, 1},                 /* four lanes */
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
  file[kdf] = 2;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_E_NEWER);
  file[kdf] = 1;
  size_t aead = find_header_record(file, 0x03);
  file[aead] = 2;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_E_NEWER);
  file[aead] = 1;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  bwv_bytes_free(file);
  bwv_free(vault);

  bwv_kdf_params weak = {1, BWV_KDF_MIN_M_KIB};
  uint8_t salt[BWV_SALT_BYTES] = {0};
  bwv_key* key = bwv_key_new();
  CHECK_STATUS(bwv_derive_password_key(&weak, salt, "x", 1, key), BWV_E_PARAMS);
  bwv_key_free(key);
}

static void test_versions_and_unknown_records(void) {
  size_t len;
  uint8_t* file = make_file(&len, INDEX);
  bwv_vault* vault = bwv_new();
  bwv_key* kk = keyring_key();

  file[8] = 3;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_E_NEWER);
  file[8] = 1; /* the first development format */
  CHECK_STATUS(bwv_load(vault, file, len), BWV_E_OLDER);
  file[8] = 0;
  CHECK_STATUS(bwv_load(vault, file, len), BWV_E_FORMAT);
  file[8] = 2;

  size_t n;
  uint8_t* critical = with_record(file, len, 0x90, "future", &n);
  CHECK_STATUS(bwv_load(vault, critical, n), BWV_E_NEWER);
  free(critical);

  /* A record added to the header by someone else: the header is
   * authenticated, so the body no longer opens. */
  uint8_t* extra = with_record(file, len, 0x50, "keep me", &n);
  CHECK_STATUS(bwv_load(vault, extra, n), BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_KEYRING, kk), BWV_OK);
  CHECK_STATUS(bwv_open_body(vault), BWV_E_AUTH);
  free(extra);
  bwv_key_free(kk);
  bwv_bytes_free(file);
  bwv_free(vault);
}

/* A record a newer version wrote is kept, byte for byte, when this version
 * rewrites the file. */
static void test_unknown_record_kept(void) {
  bwv_vault* v = bwv_new();
  CHECK_STATUS(bwv_create(v), BWV_OK);
  add_slot(v, BWV_SLOT_PASSWORD, NULL);
  bwv_key* kk = keyring_key();
  add_slot(v, BWV_SLOT_KEYRING, kk);
  fill(v, INDEX);
  CHECK_STATUS(bwv_test_add_unknown(v, 0x50, (const uint8_t*)"keep me", 7), BWV_OK);
  uint8_t* first;
  size_t first_len;
  CHECK_STATUS(bwv_serialize(v, &first, &first_len), BWV_OK);
  bwv_free(v);

  v = bwv_new();
  CHECK_STATUS(bwv_load(v, first, first_len), BWV_OK);
  CHECK_STATUS(bwv_unlock(v, BWV_SLOT_KEYRING, kk), BWV_OK);
  CHECK_STATUS(bwv_open_body(v), BWV_OK);
  uint8_t* second;
  size_t second_len;
  CHECK_STATUS(bwv_serialize(v, &second, &second_len), BWV_OK);
  size_t at = find_header_record(second, 0x50);
  CHECK(at != 0 && second[at - 2] == 7 && memcmp(second + at, "keep me", 7) == 0);
  CHECK_STATUS(bwv_load(v, second, second_len), BWV_OK);
  CHECK_STATUS(bwv_unlock(v, BWV_SLOT_KEYRING, kk), BWV_OK);
  CHECK_STATUS(bwv_open_body(v), BWV_OK);
  CHECK(index_is(v, INDEX));
  bwv_bytes_free(first);
  bwv_bytes_free(second);
  bwv_key_free(kk);
  bwv_free(v);
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
  CHECK_STATUS(bwv_set_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN),
                              (const uint8_t*)SECRET, strlen(SECRET)),
               BWV_OK);
  CHECK(secret_is(vault, ENTRY, ORIGIN, SECRET));
  /* Setting again replaces. */
  CHECK_STATUS(bwv_set_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN),
                              (const uint8_t*)SECRET2, strlen(SECRET2)),
               BWV_OK);
  CHECK(bwv_secret_count(vault) == 1);
  CHECK(secret_is(vault, ENTRY, ORIGIN, SECRET2));

  /* Only for the origin and entry it was saved for. */
  uint8_t* plain;
  size_t plain_len;
  const char* others[] = {"https://accounts.example.com.evil.example",
                          "http://accounts.example.com",
                          "https://accounts.example.com:444"};
  for (size_t i = 0; i < 3; i++) {
    CHECK_STATUS(bwv_get_secret(vault, ENTRY, others[i], strlen(others[i]),
                                &plain, &plain_len),
                 BWV_E_AUTH);
  }
  CHECK_STATUS(bwv_get_secret(vault, ENTRY2, ORIGIN, strlen(ORIGIN), &plain,
                              &plain_len),
               BWV_E_NOT_FOUND);
  CHECK_STATUS(bwv_get_secret(vault, ENTRY, "", 0, &plain, &plain_len), BWV_E_ARG);

  bwv_lock(vault);
  CHECK_STATUS(bwv_get_secret(vault, ENTRY, ORIGIN, strlen(ORIGIN), &plain,
                              &plain_len),
               BWV_E_LOCKED);
  bwv_free(vault);

  /* A session box. */
  bwv_key* session = bwv_key_new();
  bwv_key_generate(session);
  uint8_t* sealed;
  size_t sealed_len;
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

/* bwv_replace_key on its own: new key, same contents, slots gone, the old
 * key can't read the new file. */
static void test_replace_key_core(void) {
  size_t len;
  uint8_t* file = make_file(&len, INDEX);
  bwv_vault* vault = bwv_new();
  bwv_key* kk = keyring_key();
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_KEYRING, kk), BWV_OK);
  CHECK_STATUS(bwv_open_body(vault), BWV_OK);
  bwv_vault* copy = bwv_clone(vault);
  CHECK(copy != NULL);
  uint8_t before[32], after[32];
  bwv_test_key_fingerprint(copy, before);
  CHECK_STATUS(bwv_replace_key(copy), BWV_OK);
  bwv_test_key_fingerprint(copy, after);
  CHECK(memcmp(before, after, 32) != 0);
  CHECK(!bwv_has_slot(copy, BWV_SLOT_PASSWORD));
  CHECK(bwv_contents_equal(copy, vault));
  add_slot(copy, BWV_SLOT_PASSWORD, NULL);
  uint8_t* fresh;
  size_t fresh_len;
  CHECK_STATUS(bwv_serialize(copy, &fresh, &fresh_len), BWV_OK);
  bwv_vault* reread = bwv_new();
  CHECK_STATUS(bwv_load(reread, fresh, fresh_len), BWV_OK);
  CHECK_STATUS(bwv_test_adopt_keys(reread, vault), BWV_OK);
  CHECK_STATUS(bwv_open_body(reread), BWV_E_AUTH);
  bwv_free(reread);
  bwv_bytes_free(fresh);
  bwv_free(copy);
  bwv_free(vault);
  bwv_key_free(kk);
  bwv_bytes_free(file);
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
  fill(vault, INDEX);
  uint8_t* file;
  size_t len;
  CHECK_STATUS(bwv_serialize(vault, &file, &len), BWV_OK);
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
  CHECK_STATUS(bwv_open_body(vault), BWV_OK);
  CHECK(index_is(vault, INDEX));

  char wrong[BWV_RECOVERY_CHARS + 1];
  memcpy(wrong, code, sizeof(wrong));
  wrong[0] = wrong[0] == 'A' ? 'B' : 'A';
  CHECK_STATUS(bwv_derive_recovery_key(&params, salt, wrong, strlen(wrong), rk),
               BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_RECOVERY, rk), BWV_E_AUTH);

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
  CHECK_STATUS(bwv_derive_hello_key(id, signature, sizeof(signature), hk), BWV_OK);
  CHECK_STATUS(bwv_set_slot(vault, BWV_SLOT_HELLO, hk), BWV_OK);
  uint8_t* file;
  size_t len;
  CHECK_STATUS(bwv_serialize(vault, &file, &len), BWV_OK);
  bwv_free(vault);

  vault = bwv_new();
  CHECK_STATUS(bwv_load(vault, file, len), BWV_OK);
  uint8_t stored[BWV_CHALLENGE_BYTES];
  CHECK_STATUS(bwv_slot_inputs(vault, BWV_SLOT_HELLO, NULL, stored, &n), BWV_OK);
  CHECK(memcmp(stored, challenge, sizeof(stored)) == 0);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_HELLO, hk), BWV_OK);

  signature[100] ^= 1;
  CHECK_STATUS(bwv_derive_hello_key(id, signature, sizeof(signature), hk), BWV_OK);
  CHECK_STATUS(bwv_unlock(vault, BWV_SLOT_HELLO, hk), BWV_E_AUTH);
  CHECK_STATUS(bwv_derive_hello_key(id, signature, 10, hk), BWV_E_ARG);
  bwv_key_free(hk);
  bwv_bytes_free(file);
  bwv_free(vault);
}

static void test_slot_binding(void) {
  /* A keyring slot's wrapped key moved into a Hello slot doesn't open with
   * the keyring key: slots are bound to their type. */
  size_t len;
  uint8_t* file = make_file(&len, INDEX);
  size_t keyring = find_header_record(file, BWV_SLOT_KEYRING);
  CHECK(keyring != 0);
  uint8_t value[104];
  memset(value, 0, sizeof(value));
  memcpy(value, file + keyring, 16);
  memcpy(value + 32, file + keyring + 16, 72);
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
  CHECK_STATUS(bwv_derive_password_key(&params, salt, PASSWORD, strlen(PASSWORD), key),
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

/* ======================================================================
 * Fake keyring and Windows Hello, kept in files so they outlive a killed
 * process
 * ====================================================================== */

typedef struct {
  char dir[512];
  int sign_calls;
  int hello_cancel;   /* the first prompt is cancelled */
  int hello_unstable; /* the second signature differs */
} fake_t;

static fake_t FAKE;

static void keyring_path(char* out, size_t n, const fake_t* f, const uint8_t* id,
                         const uint8_t* gen) {
  char idhex[2 * BWV_ID_BYTES + 1], genhex[2 * BWV_ITEM_TAG_BYTES + 1];
  sodium_bin2hex(idhex, sizeof(idhex), id, BWV_ID_BYTES);
  sodium_bin2hex(genhex, sizeof(genhex), gen, BWV_ITEM_TAG_BYTES);
  snprintf(out, n, "%s/keyring/%s-%s.key", f->dir, idhex, genhex);
}

static bwv_status fake_store(void* ctx, const uint8_t* id, const uint8_t* gen,
                             const uint8_t* key) {
  char path[1024];
  keyring_path(path, sizeof(path), (fake_t*)ctx, id, gen);
  return write_file(path, key, BWV_KEY_BYTES) ? BWV_OK : BWV_E_PROVIDER;
}

static bwv_status fake_lookup(void* ctx, const uint8_t* id, const uint8_t* gen,
                              uint8_t* key) {
  char path[1024];
  keyring_path(path, sizeof(path), (fake_t*)ctx, id, gen);
  size_t n;
  uint8_t* data = read_file(path, &n);
  if (!data || n != BWV_KEY_BYTES) {
    free(data);
    return BWV_E_NOT_FOUND;
  }
  memcpy(key, data, BWV_KEY_BYTES);
  free(data);
  return BWV_OK;
}

/* The generation tags (hex) of this vault's entries. */
static int keyring_gens(const fake_t* f, const uint8_t* id, char gens[8][33]) {
  char idhex[2 * BWV_ID_BYTES + 1], dir[600];
  sodium_bin2hex(idhex, sizeof(idhex), id, BWV_ID_BYTES);
  snprintf(dir, sizeof(dir), "%s/keyring", f->dir);
  int n = 0;
#ifdef _WIN32
  char pattern[700];
  snprintf(pattern, sizeof(pattern), "%s\\%s-*.key", dir, idhex);
  WIN32_FIND_DATAA fd;
  HANDLE h = FindFirstFileA(pattern, &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (n < 8 && strlen(fd.cFileName) == 32 + 1 + 32 + 4) {
        memcpy(gens[n], fd.cFileName + 33, 32);
        gens[n++][32] = 0;
      }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
  }
#else
  DIR* d = opendir(dir);
  if (d) {
    struct dirent* e;
    while ((e = readdir(d))) {
      if (n < 8 && strncmp(e->d_name, idhex, 32) == 0 &&
          strlen(e->d_name) == 32 + 1 + 32 + 4) {
        memcpy(gens[n], e->d_name + 33, 32);
        gens[n++][32] = 0;
      }
    }
    closedir(d);
  }
#endif
  return n;
}

static bwv_status fake_delete_except(void* ctx, const uint8_t* id,
                                     const uint8_t* keep) {
  fake_t* f = (fake_t*)ctx;
  char gens[8][33], keephex[33] = "";
  if (keep) {
    sodium_bin2hex(keephex, sizeof(keephex), keep, BWV_ITEM_TAG_BYTES);
  }
  int n = keyring_gens(f, id, gens);
  for (int i = 0; i < n; i++) {
    if (strcmp(gens[i], keephex) != 0) {
      char idhex[33], path[1024];
      sodium_bin2hex(idhex, sizeof(idhex), id, BWV_ID_BYTES);
      snprintf(path, sizeof(path), "%s/keyring/%s-%s.key", f->dir, idhex, gens[i]);
      if (remove(path) != 0) {
        return BWV_E_PROVIDER;
      }
    }
  }
  return BWV_OK;
}

/* A "signature": BLAKE2b-512 of id and challenge, keyed with a device key
 * kept in a file (the TPM, for these tests). */
static bwv_status fake_sign(void* ctx, const uint8_t* id, const uint8_t* challenge,
                            uint8_t* sig, size_t* len) {
  fake_t* f = (fake_t*)ctx;
  f->sign_calls++;
  if (f->hello_cancel) {
    return BWV_E_CANCELLED;
  }
  char path[1024];
  join(path, sizeof(path), f->dir, "hello-device.key");
  size_t n;
  uint8_t* device = read_file(path, &n);
  if (!device || n != 32 || *len < 64) {
    free(device);
    return BWV_E_PROVIDER;
  }
  uint8_t msg[BWV_ID_BYTES + BWV_CHALLENGE_BYTES];
  memcpy(msg, id, BWV_ID_BYTES);
  memcpy(msg + BWV_ID_BYTES, challenge, BWV_CHALLENGE_BYTES);
  crypto_generichash(sig, 64, msg, sizeof(msg), device, 32);
  if (f->hello_unstable && f->sign_calls % 2 == 0) {
    sig[0] ^= 1;
  }
  free(device);
  *len = 64;
  return BWV_OK;
}

static bwt_providers fake_providers(void) {
  bwt_providers p = {&FAKE, fake_store, fake_lookup, fake_delete_except, fake_sign};
  return p;
}

/* ======================================================================
 * Store and transactions
 * ====================================================================== */

#define TXN_ROOT "txn-tests"

/* What a fresh test directory starts with: a saved vault with every kind
 * of slot. These are what must keep working when a change fails. */
typedef struct {
  char dir[512];
  uint8_t* file; /* vault.bwv as written */
  size_t file_len;
  char code[BWV_RECOVERY_CHARS + 1];
  uint8_t id[BWV_ID_BYTES];
  uint8_t gen[BWV_ITEM_TAG_BYTES];
  uint8_t challenge[BWV_CHALLENGE_BYTES];
  uint8_t fingerprint[32];
  bwv_kdf_params pw_params, rec_params;
} initial_t;

static void set_fake_dir(const char* dir) {
  memset(&FAKE, 0, sizeof(FAKE));
  snprintf(FAKE.dir, sizeof(FAKE.dir), "%s", dir);
}

/* Directory `name` under TXN_ROOT, emptied, with a vault: password,
 * recovery key, keyring (generation 1) and Hello, the index and two
 * passwords. */
static void setup(initial_t* in, const char* name) {
  memset(in, 0, sizeof(*in));
  make_dir(TXN_ROOT);
  snprintf(in->dir, sizeof(in->dir), "%s/%s", TXN_ROOT, name);
  remove_dir(in->dir);
  make_dir(in->dir);
  char path[1024];
  snprintf(path, sizeof(path), "%s/keyring", in->dir);
  make_dir(path);
  uint8_t device[32];
  randombytes_buf(device, sizeof(device));
  join(path, sizeof(path), in->dir, "hello-device.key");
  write_file(path, device, sizeof(device));
  set_fake_dir(in->dir);
  bwt_providers p = fake_providers();

  bwv_vault* v = bwv_new();
  CHECK_STATUS(bwv_create(v), BWV_OK);
  add_slot(v, BWV_SLOT_PASSWORD, NULL);
  bwv_key* key = bwv_key_new();
  /* Recovery */
  bwv_recovery_code_generate(in->code);
  uint8_t salt[BWV_SALT_BYTES];
  bwv_kdf_params params;
  CHECK_STATUS(bwv_prepare_slot(v, BWV_SLOT_RECOVERY, &FAST), BWV_OK);
  CHECK_STATUS(bwv_prepared_inputs(v, BWV_SLOT_RECOVERY, &params, salt, NULL), BWV_OK);
  CHECK_STATUS(bwv_derive_recovery_key(&params, salt, in->code, strlen(in->code), key),
               BWV_OK);
  CHECK_STATUS(bwv_set_slot(v, BWV_SLOT_RECOVERY, key), BWV_OK);
  /* Keyring */
  uint8_t raw[BWV_KEY_BYTES];
  bwv_get_id(v, in->id);
  CHECK_STATUS(bwv_prepare_slot(v, BWV_SLOT_KEYRING, NULL), BWV_OK);
  CHECK_STATUS(bwv_prepared_inputs(v, BWV_SLOT_KEYRING, NULL, in->gen, NULL), BWV_OK);
  bwv_key_generate(key);
  bwv_key_export(key, raw);
  CHECK_STATUS(p.keyring_store(p.ctx, in->id, in->gen, raw), BWV_OK);
  CHECK_STATUS(bwv_set_slot(v, BWV_SLOT_KEYRING, key), BWV_OK);
  /* Hello */
  uint8_t sig[BWT_MAX_SIGNATURE];
  size_t sig_len = sizeof(sig);
  CHECK_STATUS(bwv_prepare_slot(v, BWV_SLOT_HELLO, NULL), BWV_OK);
  CHECK_STATUS(bwv_prepared_inputs(v, BWV_SLOT_HELLO, NULL, in->challenge, NULL), BWV_OK);
  CHECK_STATUS(p.hello_sign(p.ctx, in->id, in->challenge, sig, &sig_len), BWV_OK);
  CHECK_STATUS(bwv_derive_hello_key(in->id, sig, sig_len, key), BWV_OK);
  CHECK_STATUS(bwv_set_slot(v, BWV_SLOT_HELLO, key), BWV_OK);
  bwv_key_free(key);
  FAKE.sign_calls = 0;

  fill(v, INDEX);
  bwv_slot_inputs(v, BWV_SLOT_PASSWORD, &in->pw_params, NULL, NULL);
  bwv_slot_inputs(v, BWV_SLOT_RECOVERY, &in->rec_params, NULL, NULL);
  bwv_test_key_fingerprint(v, in->fingerprint);
  CHECK_STATUS(bwv_serialize(v, &in->file, &in->file_len), BWV_OK);
  join(path, sizeof(path), in->dir, BWS_VAULT);
  CHECK(write_file(path, in->file, in->file_len));
  bwv_free(v);
}

static void teardown(initial_t* in) {
  bwv_bytes_free(in->file);
  remove_dir(in->dir);
}

/* Open the store and session as the browser does at start: recovery, then
 * the vault unlocked with `pw` and attached. */
static bwt_session* start(const char* dir, bws_store** store, const char* pw,
                          bwv_status* recovered) {
  int fixed;
  bwv_status st = bws_open(dir, store, &fixed);
  if (st != BWV_OK) {
    fprintf(stderr, "bws_open(%s): %s\n", dir, bwv_status_name(st));
    failures++;
    return NULL;
  }
  bwt_providers p = fake_providers();
  bwt_session* s = bwt_session_new(*store, &p);
  bwv_status r = bwt_recover(s);
  if (recovered) {
    *recovered = r;
  }
  uint8_t* data;
  size_t len;
  if (pw && bws_read(*store, BWS_VAULT, &data, &len) == BWV_OK) {
    bwv_vault* v = bwv_new();
    bwv_key* key = NULL;
    if (bwv_load(v, data, len) == BWV_OK && (key = password_key(v, pw)) &&
        bwv_unlock(v, BWV_SLOT_PASSWORD, key) == BWV_OK &&
        bwv_open_body(v) == BWV_OK) {
      bwt_attach(s, v);
    } else {
      bwv_free(v);
    }
    bwv_key_free(key);
    bwv_bytes_free(data);
  }
  return s;
}

static void stop(bwt_session* s, bws_store* store) {
  bwt_session_free(s);
  bws_close(store);
}

/* Does vault.bwv in `dir` open with each of these? */
typedef struct {
  int password;     /* PASSWORD */
  int password2;    /* PASSWORD2 */
  int old_code;     /* the initial recovery key */
  int new_code;     /* new-code.txt */
  int keyring;      /* the generation in the header, looked up afresh */
  int old_keyring;  /* the initial generation's entry */
  int hello;        /* a signature over the header's challenge */
  int old_hello;    /* a signature over the initial challenge */
  int contents;     /* the index and both passwords as at setup */
  int same_key;     /* the initial vault key */
  int params_kept;  /* KDF parameters as at setup */
  int only_one_gen; /* exactly one keyring generation remains */
  int backup_same;  /* vault.bwv.bak equals vault.bwv */
  int tidy;         /* no staged file, no marker */
} state_t;

static int unlocks(bwv_vault* v, bwv_slot_type type, bwv_key* key) {
  return key && bwv_unlock(v, type, key) == BWV_OK;
}

static state_t inspect(const initial_t* in) {
  state_t s;
  memset(&s, 0, sizeof(s));
  char path[1024];
  join(path, sizeof(path), in->dir, BWS_VAULT);
  size_t len;
  uint8_t* data = read_file(path, &len);
  bwv_vault* v = bwv_new();
  if (!data || bwv_load(v, data, len) != BWV_OK) {
    free(data);
    bwv_free(v);
    return s;
  }
  bwv_key* key = password_key(v, PASSWORD);
  s.password = unlocks(v, BWV_SLOT_PASSWORD, key);
  if (s.password) {
    uint8_t fp[32];
    bwv_test_key_fingerprint(v, fp);
    s.same_key = memcmp(fp, in->fingerprint, 32) == 0;
    s.contents = bwv_open_body(v) == BWV_OK && index_is(v, INDEX) &&
                 bwv_secret_count(v) == 2 && secret_is(v, ENTRY, ORIGIN, SECRET) &&
                 secret_is(v, ENTRY2, ORIGIN2, SECRET2);
  }
  bwv_key_free(key);
  key = password_key(v, PASSWORD2);
  s.password2 = unlocks(v, BWV_SLOT_PASSWORD, key);
  if (s.password2 && !s.password) {
    uint8_t fp[32];
    bwv_test_key_fingerprint(v, fp);
    s.same_key = memcmp(fp, in->fingerprint, 32) == 0;
    s.contents = bwv_open_body(v) == BWV_OK && index_is(v, INDEX) &&
                 bwv_secret_count(v) == 2 && secret_is(v, ENTRY, ORIGIN, SECRET) &&
                 secret_is(v, ENTRY2, ORIGIN2, SECRET2);
  }
  bwv_key_free(key);

  bwv_kdf_params p, rp;
  uint8_t salt[BWV_SALT_BYTES];
  s.params_kept =
      bwv_slot_inputs(v, BWV_SLOT_PASSWORD, &p, NULL, NULL) == BWV_OK &&
      bwv_slot_inputs(v, BWV_SLOT_RECOVERY, &rp, salt, NULL) == BWV_OK &&
      p.t == in->pw_params.t && p.m_kib == in->pw_params.m_kib &&
      rp.t == in->rec_params.t && rp.m_kib == in->rec_params.m_kib;

  if (bwv_slot_inputs(v, BWV_SLOT_RECOVERY, &rp, salt, NULL) == BWV_OK) {
    key = bwv_key_new();
    s.old_code = bwv_derive_recovery_key(&rp, salt, in->code, strlen(in->code), key) == BWV_OK &&
                 unlocks(v, BWV_SLOT_RECOVERY, key);
    char code_path[1024];
    join(code_path, sizeof(code_path), in->dir, "new-code.txt");
    size_t clen;
    uint8_t* code = read_file(code_path, &clen);
    s.new_code = code && clen &&
                 bwv_derive_recovery_key(&rp, salt, (const char*)code, clen, key) == BWV_OK &&
                 unlocks(v, BWV_SLOT_RECOVERY, key);
    free(code);
    bwv_key_free(key);
  }

  uint8_t gen[BWV_ITEM_TAG_BYTES], raw[BWV_KEY_BYTES];
  if (bwv_slot_inputs(v, BWV_SLOT_KEYRING, NULL, gen, NULL) == BWV_OK &&
      fake_lookup(&FAKE, in->id, gen, raw) == BWV_OK) {
    key = bwv_key_new();
    bwv_key_import(key, raw);
    s.keyring = unlocks(v, BWV_SLOT_KEYRING, key);
    bwv_key_free(key);
  }
  if (fake_lookup(&FAKE, in->id, in->gen, raw) == BWV_OK) {
    key = bwv_key_new();
    bwv_key_import(key, raw);
    s.old_keyring = unlocks(v, BWV_SLOT_KEYRING, key);
    bwv_key_free(key);
  }
  char gens[8][33];
  s.only_one_gen = keyring_gens(&FAKE, in->id, gens) == 1;

  uint8_t challenge[BWV_CHALLENGE_BYTES], sig[BWT_MAX_SIGNATURE];
  size_t sig_len;
  int calls = FAKE.sign_calls;
  if (bwv_slot_inputs(v, BWV_SLOT_HELLO, NULL, challenge, NULL) == BWV_OK) {
    sig_len = sizeof(sig);
    key = bwv_key_new();
    s.hello = fake_sign(&FAKE, in->id, challenge, sig, &sig_len) == BWV_OK &&
              bwv_derive_hello_key(in->id, sig, sig_len, key) == BWV_OK &&
              unlocks(v, BWV_SLOT_HELLO, key);
    sig_len = sizeof(sig);
    s.old_hello = fake_sign(&FAKE, in->id, in->challenge, sig, &sig_len) == BWV_OK &&
                  bwv_derive_hello_key(in->id, sig, sig_len, key) == BWV_OK &&
                  unlocks(v, BWV_SLOT_HELLO, key);
    bwv_key_free(key);
  }
  FAKE.sign_calls = calls;

  s.backup_same = same_file(in->dir, BWS_BACKUP, data, len);
  s.tidy = !file_exists(in->dir, BWS_STAGED) && !file_exists(in->dir, BWS_CLEANUP_MARKER);
  bwv_free(v);
  free(data);
  return s;
}

/* The old vault, exactly as it was, and every old way in. */
static int old_intact(const initial_t* in, const state_t* s) {
  return same_file(in->dir, BWS_VAULT, in->file, in->file_len) && s->password &&
         !s->password2 && s->old_code && s->keyring && s->old_keyring &&
         s->hello && s->old_hello && s->contents && s->same_key &&
         s->params_kept && s->only_one_gen && s->tidy;
}

/* After a replacement from Settings (same password). */
static int replaced(const state_t* s) {
  return s->password && !s->old_code && s->new_code && s->keyring &&
         !s->old_keyring && s->hello && !s->old_hello && s->contents &&
         !s->same_key && s->params_kept && s->only_one_gen && s->backup_same &&
         s->tidy;
}

/* After a password change. */
static int changed(const state_t* s) {
  return !s->password && s->password2 && s->old_code && s->keyring &&
         s->old_keyring && s->hello && s->old_hello && s->contents &&
         s->same_key && s->params_kept && s->only_one_gen && s->backup_same &&
         s->tidy;
}

static void print_state(const char* label, const state_t* s) {
  fprintf(stderr,
          "  %s: password=%d password2=%d old_code=%d new_code=%d keyring=%d "
          "old_keyring=%d hello=%d old_hello=%d contents=%d same_key=%d "
          "params_kept=%d one_gen=%d backup_same=%d tidy=%d\n",
          label, s->password, s->password2, s->old_code, s->new_code, s->keyring,
          s->old_keyring, s->hello, s->old_hello, s->contents, s->same_key,
          s->params_kept, s->only_one_gen, s->backup_same, s->tidy);
}

/* Steps, in order. Those before the promote leave the old vault. */
static const char* REPLACE_STEPS[] = {
    "replace:verify-current", "replace:clone",           "replace:rekey",
    "replace:password",       "replace:recovery",        "replace:keyring-store",
    "replace:hello-enrol",    "replace:serialize",       "replace:write-staged",
    "replace:verify-load",    "replace:verify-password", "replace:verify-recovery",
    "replace:verify-keyring", "replace:verify-hello",    "commit:marker",
    "commit:promote",         "commit:backup",           "commit:keyring-cleanup",
    "commit:marker-clear"};
#define REPLACE_PROMOTED_FROM 16 /* index of commit:backup */

static const char* CHANGE_STEPS[] = {
    "change:verify-current", "change:clone",          "change:password",
    "change:serialize",      "change:write-staged",   "change:verify",
    "change-commit:marker",  "change-commit:promote", "change-commit:backup",
    "change-commit:marker-clear"};
#define CHANGE_PROMOTED_FROM 8 /* index of change-commit:backup */

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

static void save_code(const initial_t* in, const char* code) {
  char path[1024];
  join(path, sizeof(path), in->dir, "new-code.txt");
  write_file(path, code, strlen(code));
}

/* Run a replacement from Settings to the end, or until a step fails. */
static bwv_status run_replace(const initial_t* in, bwt_session* s) {
  bwt_replacement* r = NULL;
  char code[BWV_RECOVERY_CHARS + 1];
  bwv_status st = bwt_replace_prepare(s, PASSWORD, strlen(PASSWORD), PASSWORD,
                                      strlen(PASSWORD), &r, code);
  if (st != BWV_OK) {
    return st;
  }
  save_code(in, code); /* "stored", as the user confirms */
  return bwt_replace_commit(s, r);
}

static void test_change_password(void) {
  initial_t in;
  setup(&in, "change");
  bws_store* store;
  bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
  CHECK_STATUS(bwt_change_password(s, "wrong", 5, PASSWORD2, strlen(PASSWORD2)),
               BWV_E_AUTH);
  CHECK_STATUS(bwt_change_password(s, PASSWORD, strlen(PASSWORD), PASSWORD2,
                                   strlen(PASSWORD2)),
               BWV_OK);
  CHECK(FAKE.sign_calls == 0); /* no Hello prompt */
  stop(s, store);
  state_t st = inspect(&in);
  CHECK(changed(&st));
  if (!changed(&st)) {
    print_state("after change", &st);
  }
  teardown(&in);
}

static void test_replace(void) {
  initial_t in;
  setup(&in, "replace");
  bws_store* store;
  bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
  CHECK(bwt_hello_prompts(s) == 2);
  CHECK_STATUS(run_replace(&in, s), BWV_OK);
  CHECK(FAKE.sign_calls == 2);
  /* The session now holds the new vault: saving works, and the fingerprint
   * is the new key's. */
  uint8_t fp[32];
  bwv_test_key_fingerprint(bwt_vault(s), fp);
  CHECK(memcmp(fp, in.fingerprint, 32) != 0);
  CHECK_STATUS(bwt_save(s), BWV_OK);
  stop(s, store);
  state_t st = inspect(&in);
  /* The save above refreshed the backup to the previous version. */
  st.backup_same = 1;
  CHECK(replaced(&st));
  if (!replaced(&st)) {
    print_state("after replace", &st);
  }

  /* An old copy of the file, opened with the old password, gives a key
   * that doesn't open the new file. */
  bwv_vault* old = bwv_new();
  CHECK_STATUS(bwv_load(old, in.file, in.file_len), BWV_OK);
  bwv_key* key = password_key(old, PASSWORD);
  CHECK_STATUS(bwv_unlock(old, BWV_SLOT_PASSWORD, key), BWV_OK);
  char path[1024];
  join(path, sizeof(path), in.dir, BWS_VAULT);
  size_t len;
  uint8_t* data = read_file(path, &len);
  bwv_vault* now = bwv_new();
  CHECK_STATUS(bwv_load(now, data, len), BWV_OK);
  CHECK_STATUS(bwv_test_adopt_keys(now, old), BWV_OK);
  CHECK_STATUS(bwv_open_body(now), BWV_E_AUTH);
  bwv_key_free(key);
  bwv_free(old);
  bwv_free(now);
  free(data);
  teardown(&in);
}

/* The checkbox: a new password and a new key, in one operation. */
static void test_change_with_replacement(void) {
  initial_t in;
  setup(&in, "change-replace");
  bws_store* store;
  bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
  bwt_replacement* r = NULL;
  char code[BWV_RECOVERY_CHARS + 1];
  CHECK_STATUS(bwt_replace_prepare(s, PASSWORD, strlen(PASSWORD), PASSWORD2,
                                   strlen(PASSWORD2), &r, code),
               BWV_OK);
  save_code(&in, code);
  CHECK_STATUS(bwt_replace_commit(s, r), BWV_OK);
  stop(s, store);
  state_t st = inspect(&in);
  CHECK(!st.password && st.password2 && !st.same_key && st.contents &&
        !st.old_code && st.new_code && st.keyring && !st.old_keyring &&
        st.hello && !st.old_hello && st.params_kept && st.only_one_gen &&
        st.backup_same && st.tidy);
  teardown(&in);
}

/* A failure at each step, by error return. */
static void test_replace_failures(void) {
  /* Every step is reached in a normal run. */
  initial_t in;
  setup(&in, "replace-steps");
  bws_store* store;
  bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
  bwv_test_reset_reached();
  CHECK_STATUS(run_replace(&in, s), BWV_OK);
  for (size_t i = 0; i < COUNT(REPLACE_STEPS); i++) {
    if (!bwv_test_reached(REPLACE_STEPS[i])) {
      fprintf(stderr, "  step never reached: %s\n", REPLACE_STEPS[i]);
      failures++;
    }
  }
  stop(s, store);
  teardown(&in);

  for (size_t i = 0; i < COUNT(REPLACE_STEPS); i++) {
    setup(&in, "replace-fail");
    s = start(in.dir, &store, PASSWORD, NULL);
    bwv_test_fail_at(REPLACE_STEPS[i]);
    bwv_status st = run_replace(&in, s);
    bwv_test_fail_at(NULL);
    int promoted = i >= REPLACE_PROMOTED_FROM;
    /* After a failure the session still works, unlocked, unbusied. */
    int usable = !bwt_busy(s) && index_is(bwt_vault(s), INDEX) &&
                 secret_is(bwt_vault(s), ENTRY, ORIGIN, SECRET);
    stop(s, store);
    /* As at the next start. */
    bwv_status rec;
    s = start(in.dir, &store, NULL, &rec);
    stop(s, store);
    state_t state = inspect(&in);
    int ok = usable && (promoted ? st == BWV_E_CLEANUP && replaced(&state)
                                 : st != BWV_OK && st != BWV_E_CLEANUP &&
                                       old_intact(&in, &state));
    printf("    fail at %-26s -> %-8s %s\n", REPLACE_STEPS[i], bwv_status_name(st),
           ok ? (promoted ? "new vault in use, tidied at next start"
                          : "old vault and every old way in still work")
              : "WRONG");
    if (!ok) {
      print_state(REPLACE_STEPS[i], &state);
      failures++;
    }
    teardown(&in);
  }
}

static void test_change_failures(void) {
  initial_t in;
  setup(&in, "change-steps");
  bws_store* store;
  bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
  bwv_test_reset_reached();
  CHECK_STATUS(bwt_change_password(s, PASSWORD, strlen(PASSWORD), PASSWORD2,
                                   strlen(PASSWORD2)),
               BWV_OK);
  for (size_t i = 0; i < COUNT(CHANGE_STEPS); i++) {
    if (!bwv_test_reached(CHANGE_STEPS[i])) {
      fprintf(stderr, "  step never reached: %s\n", CHANGE_STEPS[i]);
      failures++;
    }
  }
  stop(s, store);
  teardown(&in);

  for (size_t i = 0; i < COUNT(CHANGE_STEPS); i++) {
    setup(&in, "change-fail");
    s = start(in.dir, &store, PASSWORD, NULL);
    bwv_test_fail_at(CHANGE_STEPS[i]);
    bwv_status st = bwt_change_password(s, PASSWORD, strlen(PASSWORD), PASSWORD2,
                                        strlen(PASSWORD2));
    bwv_test_fail_at(NULL);
    stop(s, store);
    s = start(in.dir, &store, NULL, NULL);
    stop(s, store);
    int promoted = i >= CHANGE_PROMOTED_FROM;
    state_t state = inspect(&in);
    int ok = promoted ? st == BWV_E_CLEANUP && changed(&state)
                      : st != BWV_OK && st != BWV_E_CLEANUP && old_intact(&in, &state);
    printf("    fail at %-26s -> %-8s %s\n", CHANGE_STEPS[i], bwv_status_name(st),
           ok ? (promoted ? "new password in use, tidied at next start"
                          : "old vault and every old way in still work")
              : "WRONG");
    if (!ok) {
      print_state(CHANGE_STEPS[i], &state);
      failures++;
    }
    teardown(&in);
  }
}

static void test_hello_cancel_and_unstable(void) {
  for (int mode = 0; mode < 2; mode++) {
    initial_t in;
    setup(&in, "hello");
    bws_store* store;
    bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
    FAKE.hello_cancel = mode == 0;
    FAKE.hello_unstable = mode == 1;
    bwv_status st = run_replace(&in, s);
    CHECK_STATUS(st, mode == 0 ? BWV_E_CANCELLED : BWV_E_VERIFY);
    CHECK(FAKE.sign_calls == (mode == 0 ? 1 : 2));
    FAKE.hello_cancel = FAKE.hello_unstable = 0;
    CHECK(!bwt_busy(s));
    stop(s, store);
    state_t state = inspect(&in);
    CHECK(old_intact(&in, &state));
    printf("    Hello %-29s -> %-8s %s\n",
           mode == 0 ? "cancelled at the first prompt" : "second signature differs",
           bwv_status_name(st), old_intact(&in, &state) ? "old vault intact" : "WRONG");
    teardown(&in);
  }
}

/* Closing the dialog without confirming the new recovery key. */
static void test_abort(void) {
  initial_t in;
  setup(&in, "abort");
  bws_store* store;
  bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
  bwt_replacement* r = NULL;
  char code[BWV_RECOVERY_CHARS + 1];
  CHECK_STATUS(bwt_replace_prepare(s, PASSWORD, strlen(PASSWORD), PASSWORD,
                                   strlen(PASSWORD), &r, code),
               BWV_OK);
  CHECK(bwt_busy(s));
  CHECK(file_exists(in.dir, BWS_STAGED));
  bwt_replace_abort(s, r);
  CHECK(!bwt_busy(s));
  stop(s, store);
  state_t state = inspect(&in);
  CHECK(old_intact(&in, &state));
  teardown(&in);
}

/* A replacement when the vault had no recovery key makes none. */
static void test_no_recovery_key(void) {
  initial_t in;
  setup(&in, "no-recovery");
  bws_store* store;
  bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
  CHECK_STATUS(bwv_remove_slot(bwt_vault(s), BWV_SLOT_RECOVERY), BWV_OK);
  CHECK_STATUS(bwt_save(s), BWV_OK);
  bwt_replacement* r = NULL;
  char code[BWV_RECOVERY_CHARS + 1];
  CHECK_STATUS(bwt_replace_prepare(s, PASSWORD, strlen(PASSWORD), PASSWORD,
                                   strlen(PASSWORD), &r, code),
               BWV_OK);
  CHECK(code[0] == 0);
  CHECK_STATUS(bwt_replace_commit(s, r), BWV_OK);
  CHECK(!bwv_has_slot(bwt_vault(s), BWV_SLOT_RECOVERY));
  stop(s, store);
  teardown(&in);
}

/* ---- Crashes: the process killed at each step ---- */

static int run_child(const char* dir, const char* flow, const char* crash_at) {
#ifdef _WIN32
  _putenv_s("BWV_CRASH_AT", crash_at);
  const char* args[] = {self_path, "txn-child", dir, flow, NULL};
  int rc = (int)_spawnv(_P_WAIT, self_path, args);
  _putenv_s("BWV_CRASH_AT", "");
  return rc;
#else
  pid_t pid = fork();
  if (pid == 0) {
    setenv("BWV_CRASH_AT", crash_at, 1);
    execl(self_path, self_path, "txn-child", dir, flow, (char*)NULL);
    _exit(127);
  }
  int status = 0;
  waitpid(pid, &status, 0);
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
#endif
}

static void test_crashes(const char* flow, const char** steps, size_t n,
                         size_t promoted_from) {
  for (size_t i = 0; i < n; i++) {
    initial_t in;
    setup(&in, "crash");
    int rc = run_child(in.dir, flow, steps[i]);
    /* The next start: recovery, as the browser does it. */
    bws_store* store;
    bwv_status rec;
    bwt_session* s = start(in.dir, &store, NULL, &rec);
    stop(s, store);
    state_t state = inspect(&in);
    int promoted = i >= promoted_from;
    int ok = rc == 86 &&
             (promoted ? (strcmp(flow, "replace") == 0 ? replaced(&state) : changed(&state))
                       : old_intact(&in, &state));
    printf("    killed at %-26s -> exit %d, after restart: %s\n", steps[i], rc,
           ok ? (promoted ? (strcmp(flow, "replace") == 0
                                 ? "new vault, old recovery key and keyring entry gone"
                                 : "new password in use")
                          : "old vault and every old way in still work")
              : "WRONG");
    if (!ok) {
      print_state(steps[i], &state);
      failures++;
    }
    teardown(&in);
  }
}

static void test_replace_crashes(void) {
  test_crashes("replace", REPLACE_STEPS, COUNT(REPLACE_STEPS), REPLACE_PROMOTED_FROM);
}

static void test_change_crashes(void) {
  test_crashes("change", CHANGE_STEPS, COUNT(CHANGE_STEPS), CHANGE_PROMOTED_FROM);
}

static int cmd_txn_child(const char* dir, const char* flow) {
  set_fake_dir(dir);
  bws_store* store;
  bwt_session* s = start(dir, &store, PASSWORD, NULL);
  if (!s || !bwt_vault(s)) {
    return 2;
  }
  bwv_status st;
  if (strcmp(flow, "change") == 0) {
    st = bwt_change_password(s, PASSWORD, strlen(PASSWORD), PASSWORD2,
                             strlen(PASSWORD2));
  } else {
    initial_t in;
    memset(&in, 0, sizeof(in));
    snprintf(in.dir, sizeof(in.dir), "%s", dir);
    st = run_replace(&in, s);
  }
  stop(s, store);
  return st == BWV_OK ? 0 : 3;
}

/* ---- The queue ---- */

/* The index as lines, one per patch; applying a patch twice is harmless. */
static bwv_status add_line(void* ctx, bwv_vault* v, const uint8_t* patch, size_t len) {
  (void)ctx;
  uint8_t* index;
  size_t index_len;
  bwv_status st = bwv_get_index(v, &index, &index_len);
  if (st != BWV_OK) {
    return st;
  }
  char* both = (char*)malloc(index_len + len + 2);
  memcpy(both, index, index_len);
  both[index_len] = 0;
  char line[256];
  snprintf(line, sizeof(line), "%.*s\n", (int)len, (const char*)patch);
  if (!strstr(both, line)) {
    memcpy(both + index_len, line, strlen(line));
    index_len += strlen(line);
  }
  st = bwv_set_index(v, (const uint8_t*)both, index_len);
  free(both);
  bwv_secret_free(index);
  return st;
}

static const uint8_t Q1[16] = {0xA1}, Q2[16] = {0xA2}, Q3[16] = {0xA3};

static void queue_three(bwt_session* s) {
  CHECK_STATUS(bwt_queue_save(s, Q1, "https://one.example", 19, (const uint8_t*)"pw-one", 6,
                              (const uint8_t*)"one", 3),
               BWV_OK);
  CHECK_STATUS(bwt_queue_save(s, Q2, "https://two.example", 19, (const uint8_t*)"pw-two", 6,
                              (const uint8_t*)"two", 3),
               BWV_OK);
  CHECK_STATUS(bwt_queue_save(s, Q3, "https://three.example", 21,
                              (const uint8_t*)"pw-three", 8, (const uint8_t*)"three", 5),
               BWV_OK);
}

/* vault.bwv on disk has all three queued logins (read directly: a session
 * may hold the store's lock). */
static int has_queued_logins(const initial_t* in, const char* pw) {
  char path[1024];
  join(path, sizeof(path), in->dir, BWS_VAULT);
  size_t len;
  uint8_t* data = read_file(path, &len);
  bwv_vault* v = bwv_new();
  bwv_key* key = NULL;
  int ok = data && bwv_load(v, data, len) == BWV_OK && (key = password_key(v, pw)) &&
           bwv_unlock(v, BWV_SLOT_PASSWORD, key) == BWV_OK &&
           bwv_open_body(v) == BWV_OK &&
           secret_is(v, Q1, "https://one.example", "pw-one") &&
           secret_is(v, Q2, "https://two.example", "pw-two") &&
           secret_is(v, Q3, "https://three.example", "pw-three") &&
           secret_is(v, ENTRY, ORIGIN, SECRET);
  if (ok) {
    uint8_t* index;
    size_t index_len;
    ok = bwv_get_index(v, &index, &index_len) == BWV_OK;
    if (ok) {
      char* text = (char*)malloc(index_len + 1);
      memcpy(text, index, index_len);
      text[index_len] = 0;
      ok = strstr(text, "one\n") && strstr(text, "two\n") && strstr(text, "three\n");
      free(text);
      bwv_secret_free(index);
    }
  }
  bwv_key_free(key);
  bwv_free(v);
  free(data);
  return ok;
}

static void test_queue_during_replacement(void) {
  for (int commit = 0; commit < 2; commit++) {
    initial_t in;
    setup(&in, "queue");
    bws_store* store;
    bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
    bwt_replacement* r = NULL;
    char code[BWV_RECOVERY_CHARS + 1];
    CHECK_STATUS(bwt_replace_prepare(s, PASSWORD, strlen(PASSWORD), PASSWORD,
                                     strlen(PASSWORD), &r, code),
                 BWV_OK);
    /* Saves while the dialog is open: refused, so queued. */
    CHECK_STATUS(bwt_save(s), BWV_E_BUSY);
    CHECK_STATUS(bwt_queue_apply(s, add_line, NULL), BWV_E_BUSY);
    queue_three(s);
    if (commit) {
      save_code(&in, code);
      CHECK_STATUS(bwt_replace_commit(s, r), BWV_OK);
    } else {
      bwt_replace_abort(s, r);
    }
    CHECK_STATUS(bwt_queue_apply(s, add_line, NULL), BWV_OK);
    CHECK(bwt_queue_length(s) == 0);
    stop(s, store);
    int ok = has_queued_logins(&in, PASSWORD);
    CHECK(ok);
    printf("    3 saves queued during a replacement, then %-9s -> %s\n",
           commit ? "committed" : "aborted",
           ok ? "all three in the vault on disk" : "LOST");
    teardown(&in);
  }
}

/* Applying the queue fails: nothing is lost, and a retry saves all. */
static void test_queue_apply_failure(void) {
  const char* steps[] = {"queue:apply", "queue:save", "save:backup", "save:write"};
  for (size_t i = 0; i < COUNT(steps); i++) {
    initial_t in;
    setup(&in, "queue-fail");
    bws_store* store;
    bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
    queue_three(s);
    bwv_test_fail_at(steps[i]);
    bwv_status st = bwt_queue_apply(s, add_line, NULL);
    bwv_test_fail_at(NULL);
    size_t kept = bwt_queue_length(s);
    int disk_unchanged = same_file(in.dir, BWS_VAULT, in.file, in.file_len) ||
                         !has_queued_logins(&in, PASSWORD);
    bwv_status retry = bwt_queue_apply(s, add_line, NULL);
    size_t after = bwt_queue_length(s);
    stop(s, store);
    int saved = has_queued_logins(&in, PASSWORD);
    int ok = st != BWV_OK && kept == 3 && disk_unchanged && retry == BWV_OK &&
             after == 0 && saved;
    printf("    queue apply fails at %-12s -> %-6s queue kept %zu; retry %s -> %s\n",
           steps[i], bwv_status_name(st), kept, bwv_status_name(retry),
           ok ? "all three saved" : "WRONG");
    if (!ok) {
      failures++;
    }
    teardown(&in);
  }
}

static void test_second_instance(void) {
  initial_t in;
  setup(&in, "lock");
  bws_store *a, *b;
  int fixed;
  CHECK_STATUS(bws_open(in.dir, &a, &fixed), BWV_OK);
  CHECK_STATUS(bws_open(in.dir, &b, &fixed), BWV_E_IN_USE);
  bws_close(a);
  CHECK_STATUS(bws_open(in.dir, &b, &fixed), BWV_OK);
  bws_close(b);
  teardown(&in);
}

static void test_permissions(void) {
  initial_t in;
  setup(&in, "perms");
  char path[1024];
  join(path, sizeof(path), in.dir, BWS_VAULT);
  bws_store* store;
  int fixed = 0;
#ifdef _WIN32
  CHECK_STATUS(bws_open(in.dir, &store, &fixed), BWV_OK);
  /* One entry, the user's, not inherited. */
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  CHECK(GetNamedSecurityInfoA(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                              NULL, NULL, &dacl, NULL, &sd) == ERROR_SUCCESS);
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD rev;
  CHECK(dacl && dacl->AceCount == 1);
  CHECK(GetSecurityDescriptorControl(sd, &control, &rev) && (control & SE_DACL_PROTECTED));
  LocalFree(sd);
  bws_close(store);
#else
  chmod(path, 0644);
  chmod(in.dir, 0755);
  CHECK_STATUS(bws_open(in.dir, &store, &fixed), BWV_OK);
  CHECK(fixed);
  struct stat st;
  CHECK(stat(path, &st) == 0 && (st.st_mode & 0777) == 0600);
  CHECK(stat(in.dir, &st) == 0 && (st.st_mode & 0777) == 0700);
  /* New files are 0600 whatever the umask. */
  mode_t old = umask(0);
  CHECK_STATUS(bws_replace(store, "probe", (const uint8_t*)"x", 1), BWV_OK);
  umask(old);
  join(path, sizeof(path), in.dir, "probe");
  CHECK(stat(path, &st) == 0 && (st.st_mode & 0777) == 0600);
  bws_close(store);
  /* A symlink in the directory's place is refused. */
  char link_path[600];
  snprintf(link_path, sizeof(link_path), "%s/link", TXN_ROOT);
  unlink(link_path);
  CHECK(symlink("perms", link_path) == 0);
  CHECK_STATUS(bws_open(link_path, &store, &fixed), BWV_E_IO);
  unlink(link_path);
#endif
  teardown(&in);
}

/* A staged file left by a crash is removed, never promoted. */
static void test_staged_leftover(void) {
  initial_t in;
  setup(&in, "leftover");
  char path[1024];
  join(path, sizeof(path), in.dir, BWS_STAGED);
  write_file(path, "garbage", 7);
  bws_store* store;
  bwt_session* s = start(in.dir, &store, PASSWORD, NULL);
  CHECK(!file_exists(in.dir, BWS_STAGED));
  CHECK(bwt_vault(s) != NULL);
  stop(s, store);
  CHECK(same_file(in.dir, BWS_VAULT, in.file, in.file_len));
  teardown(&in);
}

/* ======================================================================
 * Cross-OS files and the fuzz corpus
 * ====================================================================== */

static int cmd_create(const char* path) {
  bwv_vault* vault = bwv_new();
  CHECK_STATUS(bwv_create(vault), BWV_OK);
  add_slot(vault, BWV_SLOT_PASSWORD, NULL);
  bwv_key* kk = keyring_key();
  add_slot(vault, BWV_SLOT_KEYRING, kk);
  bwv_key_free(kk);
  fill(vault, INDEX);
  uint8_t* file;
  size_t len;
  CHECK_STATUS(bwv_serialize(vault, &file, &len), BWV_OK);
  int ok = failures == 0 && write_file(path, file, len);
  bwv_bytes_free(file);
  bwv_free(vault);
  printf("%s: %s\n", path, ok ? "written" : "FAILED");
  return ok ? 0 : 1;
}

static int cmd_open(const char* path) {
  size_t len;
  uint8_t* file = read_file(path, &len);
  if (!file) {
    perror(path);
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
    CHECK_STATUS(bwv_open_body(vault), BWV_OK);
    CHECK(index_is(vault, INDEX));
    CHECK(secret_is(vault, ENTRY, ORIGIN, SECRET));
    CHECK(secret_is(vault, ENTRY2, ORIGIN2, SECRET2));
    bwv_lock(vault);
  }
  bwv_key_free(pw);
  bwv_free(vault);
  free(file);
  printf("%s: %s\n", path,
         failures ? "FAILED" : "opened with the password and the keyring key");
  return failures ? 1 : 0;
}

static int cmd_older(const char* path) {
  size_t len;
  uint8_t* file = read_file(path, &len);
  if (!file) {
    perror(path);
    return 1;
  }
  bwv_vault* vault = bwv_new();
  bwv_status st = bwv_load(vault, file, len);
  bwv_free(vault);
  free(file);
  printf("%s: %s\n", path,
         st == BWV_E_OLDER ? "refused as an older format (older)"
                           : bwv_status_name(st));
  return st == BWV_E_OLDER ? 0 : 1;
}

static int cmd_corpus(const char* dir) {
  const char* indexes[] = {"", "{}", INDEX};
  char path[1024];
  int ok = 1;
  for (size_t i = 0; i < sizeof(indexes) / sizeof(indexes[0]); i++) {
    size_t len;
    uint8_t* file = make_file(&len, indexes[i]);
    snprintf(path, sizeof(path), "%s/seed-%zu.bwv", dir, i);
    ok &= write_file(path, file, len);
    bwv_bytes_free(file);
  }
  return ok && !failures ? 0 : 1;
}

int main(int argc, char** argv) {
  self_path = argv[0];
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
  if (argc == 3 && strcmp(argv[1], "older") == 0) {
    return cmd_older(argv[2]);
  }
  if (argc == 3 && strcmp(argv[1], "corpus") == 0) {
    return cmd_corpus(argv[2]);
  }
  if (argc == 4 && strcmp(argv[1], "txn-child") == 0) {
    return cmd_txn_child(argv[2], argv[3]);
  }
  if (argc != 1) {
    fprintf(stderr, "usage: %s [create FILE | open FILE | older FILE | corpus DIR]\n",
            argv[0]);
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
      {"unknown records and keys", test_unknown_record_kept},
      {"padding", test_padding},
      {"passwords: entry and origin bound", test_secrets},
      {"replace_key: new key, same contents, old key useless", test_replace_key_core},
      {"recovery key", test_recovery},
      {"Windows Hello slot", test_hello},
      {"slots are bound to their type", test_slot_binding},
      {"default KDF parameters", test_default_params},
      {"HKDF-SHA256 (RFC 5869 A.1)", test_hkdf_vector},
      {"second instance refused", test_second_instance},
      {"owner-only permissions", test_permissions},
      {"staged leftover removed, not promoted", test_staged_leftover},
      {"password change keeps recovery, keyring, Hello", test_change_password},
      {"replacement: new key, old recovery and unlocks dead", test_replace},
      {"password change with replacement", test_change_with_replacement},
      {"replacement without a recovery key makes none", test_no_recovery_key},
      {"replacement aborted", test_abort},
      {"Hello cancelled / not reproducible", test_hello_cancel_and_unstable},
      {"replacement: failure at each step", test_replace_failures},
      {"password change: failure at each step", test_change_failures},
      {"replacement: process killed at each step", test_replace_crashes},
      {"password change: process killed at each step", test_change_crashes},
      {"saves queued during a replacement", test_queue_during_replacement},
      {"queue apply failure loses nothing", test_queue_apply_failure},
  };
  for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); i++) {
    int before = failures;
    printf("--- %s\n", tests[i].name);
    fflush(stdout);
    tests[i].fn();
    printf("%s  %s\n", failures == before ? "ok  " : "FAIL", tests[i].name);
    fflush(stdout);
  }
  remove_dir(TXN_ROOT);
  printf("\n%s\n", failures ? "FAILED" : "all vault tests passed");
  return failures ? 1 : 0;
}
