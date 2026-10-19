/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* See bwvault.h and docs/PASSWORDS.md §4. */

#include "bwvault.h"

#include <stdlib.h>
#include <string.h>

#include "sodium.h"

/* ---- Format constants. None of these may ever change for this version;
 * they deliberately don't contain the app's codename, which
 * tools/rename.sh rewrites. ---- */

static const uint8_t MAGIC[8] = {'B', 'W', 'V', 'A', 'U', 'L', 'T', 0};
static const char CTX_INDEX[] = "vault/v1/index";
static const char CTX_SECRET[] = "vault/v1/secret";
static const char CTX_HELLO[] = "vault/v1/hello";

#define PREFIX_LEN 16
#define MAX_HEADER 4096
#define NONCE_LEN crypto_aead_xchacha20poly1305_ietf_NPUBBYTES /* 24 */
#define TAG_LEN crypto_aead_xchacha20poly1305_ietf_ABYTES      /* 16 */
#define WRAPPED_LEN (BWV_KEY_BYTES + TAG_LEN)                  /* 48 */
#define SEALED_MIN (NONCE_LEN + TAG_LEN)                       /* 40 */
#define PAD_BLOCK 16384
#define MAX_BODY_CT (64u * 1024u * 1024u)
#define MAX_SIGNATURE 4096
/* Payload: index_len u32 | count u32 | index | records */
#define PAYLOAD_HEAD 8
/* Record: len u32 | entry id | origin_len u16 | origin | sealed */
#define RECORD_HEAD (4 + BWV_ENTRY_ID_BYTES + 2)

enum {
  REC_ID = 0x01,
  REC_KDF = 0x02,
  REC_AEAD = 0x03,
  REC_COUNTER = 0x04,
  REC_CRITICAL = 0x80
};

#define KDF_ARGON2ID 1
#define AEAD_XCHACHA20POLY1305 1

#define KDF_REC_LEN (1 + 4 + 4 + 1 + BWV_SALT_BYTES) /* alg t m p salt: 26 */
#define SLOT_PASSWORD_LEN (NONCE_LEN + WRAPPED_LEN)  /* 72 */
#define SLOT_RECOVERY_LEN (4 + 4 + BWV_SALT_BYTES + NONCE_LEN + WRAPPED_LEN) /* 96 */
#define SLOT_KEYRING_LEN (BWV_ITEM_TAG_BYTES + NONCE_LEN + WRAPPED_LEN)    /* 88 */
#define SLOT_HELLO_LEN (BWV_CHALLENGE_BYTES + NONCE_LEN + WRAPPED_LEN)     /* 104 */

#define NUM_SLOTS 4
#define SLOT_INDEX(type) ((int)(type)-BWV_SLOT_PASSWORD)

/* VK | IK | SK | scratch, in one guarded block. */
#define KEY_VK 0
#define KEY_IK 32
#define KEY_SK 64
#define KEY_SCRATCH 96
#define KEYS_LEN 128

static const char BASE32[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

struct bwv_key {
  unsigned char* k;
};

typedef struct {
  int present;
  bwv_kdf_params params; /* password and recovery slots */
  uint8_t fixed[BWV_CHALLENGE_BYTES]; /* salt, generation tag or challenge */
  size_t fixed_len;
  uint8_t nonce[NONCE_LEN];
  uint8_t wrapped[WRAPPED_LEN];
} slot_t;

/* One sealed password. Ciphertext, so plain memory. */
typedef struct {
  uint8_t id[BWV_ENTRY_ID_BYTES];
  char* origin;
  size_t origin_len;
  uint8_t* sealed;
  size_t sealed_len;
} record_t;

struct bwv_vault {
  int loaded; /* created or loaded */
  uint8_t id[BWV_ID_BYTES];
  uint64_t counter;
  slot_t slots[NUM_SLOTS];
  slot_t pending[NUM_SLOTS];
  uint8_t* unknown; /* records we don't know, kept as they were */
  size_t unknown_len;
  uint8_t* aad; /* prefix and header of the body we hold, byte for byte */
  size_t aad_len;
  uint8_t* body; /* nonce | ciphertext; NULL for a created vault */
  size_t body_len;
  unsigned char* keys;
  /* The opened body. */
  int body_open;
  uint8_t* index; /* guarded */
  size_t index_len;
  record_t* records;
  size_t nrecords;
};

/* ---- Little-endian helpers ---- */

static uint16_t get16(const uint8_t* p) {
  return (uint16_t)(p[0] | (p[1] << 8));
}
static uint32_t get32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}
static uint64_t get64(const uint8_t* p) {
  return (uint64_t)get32(p) | ((uint64_t)get32(p + 4) << 32);
}
static void put16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}
static void put32(uint8_t* p, uint32_t v) {
  for (int i = 0; i < 4; i++) {
    p[i] = (uint8_t)(v >> (8 * i));
  }
}
static void put64(uint8_t* p, uint64_t v) {
  put32(p, (uint32_t)v);
  put32(p + 4, (uint32_t)(v >> 32));
}

/* ---- General ---- */

bwv_status bwv_init(void) { return sodium_init() < 0 ? BWV_E_INIT : BWV_OK; }

const char* bwv_status_name(bwv_status status) {
  switch (status) {
    case BWV_OK: return "ok";
    case BWV_E_FORMAT: return "format";
    case BWV_E_NEWER: return "newer";
    case BWV_E_OLDER: return "older";
    case BWV_E_PARAMS: return "params";
    case BWV_E_AUTH: return "auth";
    case BWV_E_NO_SLOT: return "no-slot";
    case BWV_E_NOT_FOUND: return "not-found";
    case BWV_E_LOCKED: return "locked";
    case BWV_E_STATE: return "state";
    case BWV_E_ARG: return "arg";
    case BWV_E_NOMEM: return "nomem";
    case BWV_E_INIT: return "init";
    case BWV_E_IO: return "io";
    case BWV_E_IN_USE: return "in-use";
    case BWV_E_BUSY: return "busy";
    case BWV_E_PROVIDER: return "provider";
    case BWV_E_CANCELLED: return "cancelled";
    case BWV_E_VERIFY: return "verify";
    case BWV_E_CLEANUP: return "cleanup";
  }
  return "unknown";
}

static int params_ok(const bwv_kdf_params* p) {
  return p->t >= BWV_KDF_MIN_T && p->t <= BWV_KDF_MAX_T &&
         p->m_kib >= BWV_KDF_MIN_M_KIB && p->m_kib <= BWV_KDF_MAX_M_KIB;
}

static int valid_slot_type(bwv_slot_type type) {
  return type >= BWV_SLOT_PASSWORD && type <= BWV_SLOT_HELLO;
}

void bwv_secret_free(uint8_t* buf) {
  if (buf) {
    sodium_free(buf);
  }
}

void bwv_bytes_free(uint8_t* buf) { free(buf); }

/* Guarded buffer of at least one byte, so an empty plaintext is still a
 * pointer the caller frees the usual way. */
static uint8_t* secret_alloc(size_t len) {
  return (uint8_t*)sodium_malloc(len ? len : 1);
}

/* ---- Keys ---- */

bwv_key* bwv_key_new(void) {
  bwv_key* key = (bwv_key*)calloc(1, sizeof(*key));
  if (!key) {
    return NULL;
  }
  key->k = (unsigned char*)sodium_malloc(BWV_KEY_BYTES);
  if (!key->k) {
    free(key);
    return NULL;
  }
  sodium_memzero(key->k, BWV_KEY_BYTES);
  sodium_mprotect_noaccess(key->k);
  return key;
}

void bwv_key_free(bwv_key* key) {
  if (!key) {
    return;
  }
  sodium_free(key->k); /* zeroes first; also undoes noaccess */
  free(key);
}

void bwv_key_generate(bwv_key* key) {
  sodium_mprotect_readwrite(key->k);
  randombytes_buf(key->k, BWV_KEY_BYTES);
  sodium_mprotect_noaccess(key->k);
}

void bwv_key_import(bwv_key* key, const uint8_t in[BWV_KEY_BYTES]) {
  sodium_mprotect_readwrite(key->k);
  memcpy(key->k, in, BWV_KEY_BYTES);
  sodium_mprotect_noaccess(key->k);
}

void bwv_key_export(const bwv_key* key, uint8_t out[BWV_KEY_BYTES]) {
  sodium_mprotect_readonly(key->k);
  memcpy(out, key->k, BWV_KEY_BYTES);
  sodium_mprotect_noaccess(key->k);
}

static bwv_status argon2id(const bwv_kdf_params* params,
                           const uint8_t salt[BWV_SALT_BYTES],
                           const uint8_t* in, size_t len, bwv_key* out) {
  if (!params_ok(params)) {
    return BWV_E_PARAMS;
  }
  if (len > crypto_pwhash_PASSWD_MAX) {
    return BWV_E_ARG;
  }
  sodium_mprotect_readwrite(out->k);
  int rv = crypto_pwhash(out->k, BWV_KEY_BYTES, (const char*)in, len, salt,
                         params->t, (size_t)params->m_kib * 1024u,
                         crypto_pwhash_ALG_ARGON2ID13);
  if (rv != 0) {
    sodium_memzero(out->k, BWV_KEY_BYTES);
  }
  sodium_mprotect_noaccess(out->k);
  /* libsodium fails Argon2id only when it can't get the memory. */
  return rv == 0 ? BWV_OK : BWV_E_NOMEM;
}

bwv_status bwv_derive_password_key(const bwv_kdf_params* params,
                                   const uint8_t salt[BWV_SALT_BYTES],
                                   const char* password, size_t len,
                                   bwv_key* out) {
  return argon2id(params, salt, (const uint8_t*)password, len, out);
}

static int base32_value(char c) {
  if (c >= 'a' && c <= 'z') {
    c = (char)(c - 'a' + 'A');
  }
  /* People copy codes by hand: 0 and 1 are O and I. */
  if (c == '0') {
    c = 'O';
  } else if (c == '1') {
    c = 'I';
  }
  const char* p = c ? strchr(BASE32, c) : NULL;
  return p ? (int)(p - BASE32) : -1;
}

bwv_status bwv_derive_recovery_key(const bwv_kdf_params* params,
                                   const uint8_t salt[BWV_SALT_BYTES],
                                   const char* code, size_t len, bwv_key* out) {
  uint8_t* raw = secret_alloc(BWV_RECOVERY_BYTES);
  if (!raw) {
    return BWV_E_NOMEM;
  }
  sodium_memzero(raw, BWV_RECOVERY_BYTES);
  uint32_t acc = 0;
  int bits = 0;
  size_t chars = 0, n = 0;
  bwv_status status = BWV_OK;
  for (size_t i = 0; i < len; i++) {
    char c = code[i];
    if (c == '-' || c == ' ') {
      continue;
    }
    int v = base32_value(c);
    if (v < 0 || ++chars > 32) {
      status = BWV_E_ARG;
      break;
    }
    acc = (acc << 5) | (uint32_t)v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      raw[n++] = (uint8_t)(acc >> bits);
      acc &= (1u << bits) - 1u;
    }
  }
  acc = 0;
  if (status == BWV_OK && (chars != 32 || n != BWV_RECOVERY_BYTES)) {
    status = BWV_E_ARG;
  }
  if (status == BWV_OK) {
    status = argon2id(params, salt, raw, BWV_RECOVERY_BYTES, out);
  }
  sodium_free(raw);
  return status;
}

void bwv_recovery_code_generate(char out[BWV_RECOVERY_CHARS + 1]) {
  uint8_t raw[BWV_RECOVERY_BYTES];
  randombytes_buf(raw, sizeof(raw));
  size_t o = 0, chars = 0;
  uint32_t acc = 0;
  int bits = 0;
  for (size_t i = 0; i < sizeof(raw); i++) {
    acc = (acc << 8) | raw[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      if (chars && chars % 4 == 0) {
        out[o++] = '-';
      }
      out[o++] = BASE32[(acc >> bits) & 31u];
      chars++;
    }
    acc &= (1u << bits) - 1u;
  }
  out[o] = 0;
  sodium_memzero(raw, sizeof(raw));
  acc = 0;
}

/* HKDF-SHA256 with the vault id as salt. `scratch` holds the PRK; it must
 * be BWV_KEY_BYTES of guarded, writable memory. */
static void hkdf(unsigned char* out, const uint8_t* ikm, size_t ikm_len,
                 const uint8_t salt[BWV_ID_BYTES], const char* ctx,
                 unsigned char* scratch) {
  crypto_kdf_hkdf_sha256_extract(scratch, salt, BWV_ID_BYTES, ikm, ikm_len);
  crypto_kdf_hkdf_sha256_expand(out, BWV_KEY_BYTES, ctx, strlen(ctx), scratch);
  sodium_memzero(scratch, BWV_KEY_BYTES);
}

bwv_status bwv_derive_hello_key(const uint8_t vault_id[BWV_ID_BYTES],
                                const uint8_t* signature, size_t len,
                                bwv_key* out) {
  if (len < 64 || len > MAX_SIGNATURE) {
    return BWV_E_ARG;
  }
  unsigned char* prk = (unsigned char*)sodium_malloc(BWV_KEY_BYTES);
  if (!prk) {
    return BWV_E_NOMEM;
  }
  sodium_mprotect_readwrite(out->k);
  hkdf(out->k, signature, len, vault_id, CTX_HELLO, prk);
  sodium_mprotect_noaccess(out->k);
  sodium_free(prk);
  return BWV_OK;
}

/* ---- Vault state ---- */

bwv_vault* bwv_new(void) { return (bwv_vault*)calloc(1, sizeof(bwv_vault)); }

static void free_keys(unsigned char** keys) {
  if (*keys) {
    sodium_free(*keys);
    *keys = NULL;
  }
}

static void free_records(record_t* records, size_t n) {
  for (size_t i = 0; i < n; i++) {
    free(records[i].origin);
    free(records[i].sealed);
  }
  free(records);
}

static void close_body(bwv_vault* vault) {
  if (vault->index) {
    sodium_free(vault->index);
  }
  vault->index = NULL;
  vault->index_len = 0;
  free_records(vault->records, vault->nrecords);
  vault->records = NULL;
  vault->nrecords = 0;
  vault->body_open = 0;
}

void bwv_lock(bwv_vault* vault) {
  free_keys(&vault->keys);
  close_body(vault);
  memset(vault->pending, 0, sizeof(vault->pending));
}

static void reset(bwv_vault* vault) {
  bwv_lock(vault);
  free(vault->unknown);
  free(vault->aad);
  free(vault->body);
  memset(vault, 0, sizeof(*vault));
}

void bwv_free(bwv_vault* vault) {
  if (vault) {
    reset(vault);
    free(vault);
  }
}

static unsigned char* new_keys(const uint8_t id[BWV_ID_BYTES]) {
  unsigned char* keys = (unsigned char*)sodium_malloc(KEYS_LEN);
  if (!keys) {
    return NULL;
  }
  randombytes_buf(keys + KEY_VK, BWV_KEY_BYTES);
  hkdf(keys + KEY_IK, keys + KEY_VK, BWV_KEY_BYTES, id, CTX_INDEX,
       keys + KEY_SCRATCH);
  hkdf(keys + KEY_SK, keys + KEY_VK, BWV_KEY_BYTES, id, CTX_SECRET,
       keys + KEY_SCRATCH);
  sodium_mprotect_noaccess(keys);
  return keys;
}

bwv_status bwv_create(bwv_vault* vault) {
  reset(vault);
  randombytes_buf(vault->id, BWV_ID_BYTES);
  vault->keys = new_keys(vault->id);
  vault->index = secret_alloc(0);
  if (!vault->keys || !vault->index) {
    reset(vault);
    return BWV_E_NOMEM;
  }
  vault->body_open = 1;
  vault->loaded = 1;
  return BWV_OK;
}

static uint8_t* dup_bytes(const uint8_t* p, size_t n) {
  uint8_t* d = (uint8_t*)malloc(n ? n : 1);
  if (d && n) {
    memcpy(d, p, n);
  }
  return d;
}

static int copy_records(record_t** out, const record_t* in, size_t n) {
  *out = NULL;
  if (!n) {
    return 1;
  }
  record_t* r = (record_t*)calloc(n, sizeof(record_t));
  if (!r) {
    return 0;
  }
  for (size_t i = 0; i < n; i++) {
    r[i] = in[i];
    r[i].origin = (char*)dup_bytes((const uint8_t*)in[i].origin, in[i].origin_len);
    r[i].sealed = dup_bytes(in[i].sealed, in[i].sealed_len);
    if (!r[i].origin || !r[i].sealed) {
      free_records(r, i + 1);
      return 0;
    }
  }
  *out = r;
  return 1;
}

bwv_vault* bwv_clone(const bwv_vault* src) {
  if (!src->keys || !src->body_open) {
    return NULL;
  }
  bwv_vault* v = bwv_new();
  if (!v) {
    return NULL;
  }
  v->loaded = 1;
  memcpy(v->id, src->id, BWV_ID_BYTES);
  v->counter = src->counter;
  memcpy(v->slots, src->slots, sizeof(v->slots));
  v->unknown_len = src->unknown_len;
  v->unknown = src->unknown_len ? dup_bytes(src->unknown, src->unknown_len) : NULL;
  v->aad_len = src->aad_len;
  v->aad = src->aad ? dup_bytes(src->aad, src->aad_len) : NULL;
  v->body_len = src->body_len;
  v->body = src->body ? dup_bytes(src->body, src->body_len) : NULL;
  v->keys = (unsigned char*)sodium_malloc(KEYS_LEN);
  v->index = secret_alloc(src->index_len);
  v->index_len = src->index_len;
  if ((src->unknown_len && !v->unknown) || (src->aad && !v->aad) ||
      (src->body && !v->body) || !v->keys || !v->index ||
      !copy_records(&v->records, src->records, src->nrecords)) {
    bwv_free(v);
    return NULL;
  }
  v->nrecords = src->nrecords;
  sodium_mprotect_readonly(src->keys);
  memcpy(v->keys, src->keys, KEYS_LEN);
  sodium_mprotect_noaccess(src->keys);
  sodium_mprotect_noaccess(v->keys);
  if (src->index_len) {
    memcpy(v->index, src->index, src->index_len);
  }
  v->body_open = 1;
  return v;
}

void bwv_get_id(const bwv_vault* vault, uint8_t out[BWV_ID_BYTES]) {
  memcpy(out, vault->id, BWV_ID_BYTES);
}

uint64_t bwv_get_counter(const bwv_vault* vault) { return vault->counter; }

int bwv_is_unlocked(const bwv_vault* vault) { return vault->keys != NULL; }

int bwv_has_slot(const bwv_vault* vault, bwv_slot_type type) {
  return valid_slot_type(type) && vault->slots[SLOT_INDEX(type)].present;
}

int bwv_slot_equal(const bwv_vault* a, const bwv_vault* b, bwv_slot_type type) {
  if (!valid_slot_type(type)) {
    return 0;
  }
  const slot_t* x = &a->slots[SLOT_INDEX(type)];
  const slot_t* y = &b->slots[SLOT_INDEX(type)];
  if (x->present != y->present) {
    return 0;
  }
  return !x->present ||
         (x->params.t == y->params.t && x->params.m_kib == y->params.m_kib &&
          x->fixed_len == y->fixed_len &&
          memcmp(x->fixed, y->fixed, x->fixed_len) == 0 &&
          memcmp(x->nonce, y->nonce, NONCE_LEN) == 0 &&
          memcmp(x->wrapped, y->wrapped, WRAPPED_LEN) == 0);
}

int bwv_kdf_outdated(const bwv_vault* vault) {
  const slot_t* s = &vault->slots[SLOT_INDEX(BWV_SLOT_PASSWORD)];
  return s->present && (s->params.t < BWV_KDF_DEFAULT_T ||
                        s->params.m_kib < BWV_KDF_DEFAULT_M_KIB);
}

static bwv_status inputs_of(const slot_t* s, bwv_slot_type type,
                            bwv_kdf_params* params, uint8_t* fixed,
                            size_t* fixed_len) {
  if (params && (type == BWV_SLOT_PASSWORD || type == BWV_SLOT_RECOVERY)) {
    *params = s->params;
  }
  if (fixed) {
    memcpy(fixed, s->fixed, s->fixed_len);
  }
  if (fixed_len) {
    *fixed_len = s->fixed_len;
  }
  return BWV_OK;
}

bwv_status bwv_slot_inputs(const bwv_vault* vault, bwv_slot_type type,
                           bwv_kdf_params* params, uint8_t* fixed,
                           size_t* fixed_len) {
  if (!valid_slot_type(type)) {
    return BWV_E_ARG;
  }
  const slot_t* s = &vault->slots[SLOT_INDEX(type)];
  return s->present ? inputs_of(s, type, params, fixed, fixed_len)
                    : BWV_E_NO_SLOT;
}

bwv_status bwv_prepared_inputs(const bwv_vault* vault, bwv_slot_type type,
                               bwv_kdf_params* params, uint8_t* fixed,
                               size_t* fixed_len) {
  if (!valid_slot_type(type)) {
    return BWV_E_ARG;
  }
  const slot_t* s = &vault->pending[SLOT_INDEX(type)];
  return s->present ? inputs_of(s, type, params, fixed, fixed_len)
                    : BWV_E_STATE;
}

/* What a slot's wrapped key is bound to: the format, the vault, the slot
 * type and everything its key is derived from. */
static size_t slot_aad(const bwv_vault* vault, bwv_slot_type type,
                       const slot_t* s, uint8_t* out) {
  size_t n = 0;
  memcpy(out, MAGIC, sizeof(MAGIC));
  n += sizeof(MAGIC);
  put16(out + n, BWV_FORMAT_VERSION);
  n += 2;
  memcpy(out + n, vault->id, BWV_ID_BYTES);
  n += BWV_ID_BYTES;
  out[n++] = (uint8_t)type;
  if (type == BWV_SLOT_PASSWORD) {
    out[n++] = KDF_ARGON2ID;
    put32(out + n, s->params.t);
    put32(out + n + 4, s->params.m_kib);
    n += 8;
    out[n++] = 1;
  } else if (type == BWV_SLOT_RECOVERY) {
    put32(out + n, s->params.t);
    put32(out + n + 4, s->params.m_kib);
    n += 8;
  }
  memcpy(out + n, s->fixed, s->fixed_len);
  return n + s->fixed_len;
}

#define SLOT_AAD_MAX (8 + 2 + BWV_ID_BYTES + 1 + 10 + BWV_CHALLENGE_BYTES)

static void derive_subkeys(bwv_vault* vault) {
  unsigned char* keys = vault->keys;
  hkdf(keys + KEY_IK, keys + KEY_VK, BWV_KEY_BYTES, vault->id, CTX_INDEX,
       keys + KEY_SCRATCH);
  hkdf(keys + KEY_SK, keys + KEY_VK, BWV_KEY_BYTES, vault->id, CTX_SECRET,
       keys + KEY_SCRATCH);
}

bwv_status bwv_unlock(bwv_vault* vault, bwv_slot_type type,
                      const bwv_key* slot_key) {
  if (!valid_slot_type(type)) {
    return BWV_E_ARG;
  }
  const slot_t* s = &vault->slots[SLOT_INDEX(type)];
  if (!vault->loaded || !s->present) {
    return BWV_E_NO_SLOT;
  }
  bwv_lock(vault);
  vault->keys = (unsigned char*)sodium_malloc(KEYS_LEN);
  if (!vault->keys) {
    return BWV_E_NOMEM;
  }
  uint8_t aad[SLOT_AAD_MAX];
  size_t aad_len = slot_aad(vault, type, s, aad);
  sodium_mprotect_readonly(slot_key->k);
  int rv = crypto_aead_xchacha20poly1305_ietf_decrypt(
      vault->keys + KEY_VK, NULL, NULL, s->wrapped, WRAPPED_LEN, aad, aad_len,
      s->nonce, slot_key->k);
  sodium_mprotect_noaccess(slot_key->k);
  if (rv != 0) {
    free_keys(&vault->keys);
    return BWV_E_AUTH;
  }
  derive_subkeys(vault);
  sodium_mprotect_noaccess(vault->keys);
  return BWV_OK;
}

/* ---- Slots ---- */

bwv_status bwv_prepare_slot(bwv_vault* vault, bwv_slot_type type,
                            const bwv_kdf_params* params) {
  if (!valid_slot_type(type)) {
    return BWV_E_ARG;
  }
  if (!vault->keys) {
    return BWV_E_LOCKED;
  }
  slot_t* p = &vault->pending[SLOT_INDEX(type)];
  memset(p, 0, sizeof(*p));
  switch (type) {
    case BWV_SLOT_PASSWORD:
    case BWV_SLOT_RECOVERY: {
      bwv_kdf_params def = {BWV_KDF_DEFAULT_T, BWV_KDF_DEFAULT_M_KIB};
      p->params = params ? *params : def;
      if (!params_ok(&p->params)) {
        return BWV_E_PARAMS;
      }
      p->fixed_len = BWV_SALT_BYTES;
      break;
    }
    case BWV_SLOT_KEYRING:
      p->fixed_len = BWV_ITEM_TAG_BYTES;
      break;
    case BWV_SLOT_HELLO:
      p->fixed_len = BWV_CHALLENGE_BYTES;
      break;
  }
  randombytes_buf(p->fixed, p->fixed_len);
  p->present = 1;
  return BWV_OK;
}

bwv_status bwv_set_slot(bwv_vault* vault, bwv_slot_type type,
                        const bwv_key* slot_key) {
  if (!valid_slot_type(type)) {
    return BWV_E_ARG;
  }
  if (!vault->keys) {
    return BWV_E_LOCKED;
  }
  slot_t* p = &vault->pending[SLOT_INDEX(type)];
  if (!p->present || !slot_key) {
    return BWV_E_STATE;
  }
  slot_t s = *p;
  randombytes_buf(s.nonce, NONCE_LEN);
  uint8_t aad[SLOT_AAD_MAX];
  size_t aad_len = slot_aad(vault, type, &s, aad);
  sodium_mprotect_readonly(vault->keys);
  sodium_mprotect_readonly(slot_key->k);
  crypto_aead_xchacha20poly1305_ietf_encrypt(s.wrapped, NULL,
                                             vault->keys + KEY_VK,
                                             BWV_KEY_BYTES, aad, aad_len, NULL,
                                             s.nonce, slot_key->k);
  sodium_mprotect_noaccess(slot_key->k);
  sodium_mprotect_noaccess(vault->keys);
  vault->slots[SLOT_INDEX(type)] = s;
  memset(p, 0, sizeof(*p));
  return BWV_OK;
}

bwv_status bwv_remove_slot(bwv_vault* vault, bwv_slot_type type) {
  if (!valid_slot_type(type) || type == BWV_SLOT_PASSWORD) {
    return BWV_E_ARG;
  }
  slot_t* s = &vault->slots[SLOT_INDEX(type)];
  if (!s->present) {
    return BWV_E_NO_SLOT;
  }
  memset(s, 0, sizeof(*s));
  return BWV_OK;
}

/* ---- Sealing ---- */

static bwv_status seal(const unsigned char* key, const uint8_t* ad,
                       size_t ad_len, const uint8_t* msg, size_t len,
                       uint8_t** out, size_t* out_len) {
  size_t n = NONCE_LEN + len + TAG_LEN;
  uint8_t* buf = (uint8_t*)malloc(n);
  if (!buf) {
    return BWV_E_NOMEM;
  }
  randombytes_buf(buf, NONCE_LEN);
  crypto_aead_xchacha20poly1305_ietf_encrypt(buf + NONCE_LEN, NULL, msg, len,
                                             ad, ad_len, NULL, buf, key);
  *out = buf;
  *out_len = n;
  return BWV_OK;
}

static bwv_status open_box(const unsigned char* key, const uint8_t* ad,
                           size_t ad_len, const uint8_t* box, size_t len,
                           uint8_t** out, size_t* out_len) {
  if (len < SEALED_MIN) {
    return BWV_E_AUTH;
  }
  size_t n = len - SEALED_MIN;
  uint8_t* buf = secret_alloc(n);
  if (!buf) {
    return BWV_E_NOMEM;
  }
  if (crypto_aead_xchacha20poly1305_ietf_decrypt(buf, NULL, NULL,
                                                 box + NONCE_LEN,
                                                 len - NONCE_LEN, ad, ad_len,
                                                 box, key) != 0) {
    sodium_free(buf);
    return BWV_E_AUTH;
  }
  *out = buf;
  *out_len = n;
  return BWV_OK;
}

/* vault id | entry id | origin, into `aad` (BWV_ID_BYTES +
 * BWV_ENTRY_ID_BYTES + BWV_MAX_ORIGIN bytes). */
static size_t secret_aad(const uint8_t id[BWV_ID_BYTES],
                         const uint8_t entry_id[BWV_ENTRY_ID_BYTES],
                         const char* origin, size_t origin_len, uint8_t* aad) {
  memcpy(aad, id, BWV_ID_BYTES);
  memcpy(aad + BWV_ID_BYTES, entry_id, BWV_ENTRY_ID_BYTES);
  memcpy(aad + BWV_ID_BYTES + BWV_ENTRY_ID_BYTES, origin, origin_len);
  return BWV_ID_BYTES + BWV_ENTRY_ID_BYTES + origin_len;
}

#define SECRET_AAD_MAX (BWV_ID_BYTES + BWV_ENTRY_ID_BYTES + BWV_MAX_ORIGIN)

/* Seal or open one password under the SK in `keys`. */
static bwv_status secret_op(const uint8_t id[BWV_ID_BYTES],
                            const unsigned char* keys, int sealing,
                            const uint8_t entry_id[BWV_ENTRY_ID_BYTES],
                            const char* origin, size_t origin_len,
                            const uint8_t* in, size_t len, uint8_t** out,
                            size_t* out_len) {
  uint8_t aad[SECRET_AAD_MAX];
  size_t aad_len = secret_aad(id, entry_id, origin, origin_len, aad);
  sodium_mprotect_readonly((void*)keys);
  bwv_status status =
      sealing ? seal(keys + KEY_SK, aad, aad_len, in, len, out, out_len)
              : open_box(keys + KEY_SK, aad, aad_len, in, len, out, out_len);
  sodium_mprotect_noaccess((void*)keys);
  return status;
}

bwv_status bwv_box_seal(const bwv_key* key, const uint8_t* ad, size_t ad_len,
                        const uint8_t* msg, size_t len, uint8_t** out,
                        size_t* out_len) {
  if (len > BWV_MAX_SECRET) {
    return BWV_E_ARG;
  }
  sodium_mprotect_readonly(key->k);
  bwv_status status = seal(key->k, ad, ad_len, msg, len, out, out_len);
  sodium_mprotect_noaccess(key->k);
  return status;
}

bwv_status bwv_box_open(const bwv_key* key, const uint8_t* ad, size_t ad_len,
                        const uint8_t* box, size_t len, uint8_t** out,
                        size_t* out_len) {
  sodium_mprotect_readonly(key->k);
  bwv_status status = open_box(key->k, ad, ad_len, box, len, out, out_len);
  sodium_mprotect_noaccess(key->k);
  return status;
}

/* ---- Index and passwords ---- */

static int origin_ok(const char* origin, size_t len) {
  return origin && len > 0 && len <= BWV_MAX_ORIGIN;
}

static record_t* find_record(const bwv_vault* vault,
                             const uint8_t entry_id[BWV_ENTRY_ID_BYTES]) {
  for (size_t i = 0; i < vault->nrecords; i++) {
    if (memcmp(vault->records[i].id, entry_id, BWV_ENTRY_ID_BYTES) == 0) {
      return &vault->records[i];
    }
  }
  return NULL;
}

bwv_status bwv_get_index(const bwv_vault* vault, uint8_t** out, size_t* len) {
  if (!vault->keys || !vault->body_open) {
    return BWV_E_LOCKED;
  }
  uint8_t* copy = secret_alloc(vault->index_len);
  if (!copy) {
    return BWV_E_NOMEM;
  }
  if (vault->index_len) {
    memcpy(copy, vault->index, vault->index_len);
  }
  *out = copy;
  *len = vault->index_len;
  return BWV_OK;
}

bwv_status bwv_set_index(bwv_vault* vault, const uint8_t* index, size_t len) {
  if (!vault->keys || !vault->body_open) {
    return BWV_E_LOCKED;
  }
  if (len > MAX_BODY_CT / 2) {
    return BWV_E_ARG;
  }
  uint8_t* copy = secret_alloc(len);
  if (!copy) {
    return BWV_E_NOMEM;
  }
  if (len) {
    memcpy(copy, index, len);
  }
  sodium_free(vault->index);
  vault->index = copy;
  vault->index_len = len;
  return BWV_OK;
}

bwv_status bwv_set_secret(bwv_vault* vault,
                          const uint8_t entry_id[BWV_ENTRY_ID_BYTES],
                          const char* origin, size_t origin_len,
                          const uint8_t* secret, size_t len) {
  if (!vault->keys || !vault->body_open) {
    return BWV_E_LOCKED;
  }
  if (!origin_ok(origin, origin_len) || len > BWV_MAX_SECRET) {
    return BWV_E_ARG;
  }
  uint8_t* sealed;
  size_t sealed_len;
  bwv_status status = secret_op(vault->id, vault->keys, 1, entry_id, origin,
                                origin_len, secret, len, &sealed, &sealed_len);
  if (status != BWV_OK) {
    return status;
  }
  char* origin_copy = (char*)dup_bytes((const uint8_t*)origin, origin_len);
  if (!origin_copy) {
    free(sealed);
    return BWV_E_NOMEM;
  }
  record_t* r = find_record(vault, entry_id);
  if (!r) {
    record_t* grown = (record_t*)realloc(vault->records,
                                         (vault->nrecords + 1) * sizeof(record_t));
    if (!grown) {
      free(sealed);
      free(origin_copy);
      return BWV_E_NOMEM;
    }
    vault->records = grown;
    r = &vault->records[vault->nrecords++];
    memcpy(r->id, entry_id, BWV_ENTRY_ID_BYTES);
  } else {
    free(r->origin);
    free(r->sealed);
  }
  r->origin = origin_copy;
  r->origin_len = origin_len;
  r->sealed = sealed;
  r->sealed_len = sealed_len;
  return BWV_OK;
}

bwv_status bwv_get_secret(const bwv_vault* vault,
                          const uint8_t entry_id[BWV_ENTRY_ID_BYTES],
                          const char* origin, size_t origin_len,
                          uint8_t** out, size_t* out_len) {
  if (!vault->keys || !vault->body_open) {
    return BWV_E_LOCKED;
  }
  if (!origin_ok(origin, origin_len)) {
    return BWV_E_ARG;
  }
  const record_t* r = find_record(vault, entry_id);
  if (!r) {
    return BWV_E_NOT_FOUND;
  }
  /* Opened with the origin asked for, not the stored one: a mismatch fails
   * authentication rather than relying on this comparison. */
  return secret_op(vault->id, vault->keys, 0, entry_id, origin, origin_len,
                   r->sealed, r->sealed_len, out, out_len);
}

bwv_status bwv_remove_secret(bwv_vault* vault,
                             const uint8_t entry_id[BWV_ENTRY_ID_BYTES]) {
  if (!vault->keys || !vault->body_open) {
    return BWV_E_LOCKED;
  }
  record_t* r = find_record(vault, entry_id);
  if (!r) {
    return BWV_E_NOT_FOUND;
  }
  free(r->origin);
  free(r->sealed);
  *r = vault->records[--vault->nrecords];
  return BWV_OK;
}

size_t bwv_secret_count(const bwv_vault* vault) { return vault->nrecords; }

int bwv_contents_equal(const bwv_vault* a, const bwv_vault* b) {
  if (!a->keys || !b->keys || !a->body_open || !b->body_open ||
      a->index_len != b->index_len || a->nrecords != b->nrecords ||
      (a->index_len && sodium_memcmp(a->index, b->index, a->index_len) != 0)) {
    return 0;
  }
  for (size_t i = 0; i < a->nrecords; i++) {
    const record_t* ra = &a->records[i];
    const record_t* rb = find_record(b, ra->id);
    if (!rb || ra->origin_len != rb->origin_len ||
        memcmp(ra->origin, rb->origin, ra->origin_len) != 0) {
      return 0;
    }
    uint8_t *pa = NULL, *pb = NULL;
    size_t la = 0, lb = 0;
    int same =
        bwv_get_secret(a, ra->id, ra->origin, ra->origin_len, &pa, &la) == BWV_OK &&
        bwv_get_secret(b, rb->id, rb->origin, rb->origin_len, &pb, &lb) == BWV_OK &&
        la == lb && (la == 0 || sodium_memcmp(pa, pb, la) == 0);
    bwv_secret_free(pa);
    bwv_secret_free(pb);
    if (!same) {
      return 0;
    }
  }
  return 1;
}

/* ---- Replacing the vault key ---- */

bwv_status bwv_replace_key(bwv_vault* vault) {
  if (!vault->keys || !vault->body_open) {
    return BWV_E_LOCKED;
  }
  unsigned char* fresh = new_keys(vault->id);
  record_t* resealed = NULL;
  if (!fresh || (vault->nrecords &&
                 !(resealed = (record_t*)calloc(vault->nrecords, sizeof(record_t))))) {
    free_keys(&fresh);
    return BWV_E_NOMEM;
  }
  /* Build every resealed password first; the vault changes only when all
   * of them are done. */
  bwv_status status = BWV_OK;
  size_t done = 0;
  for (; done < vault->nrecords && status == BWV_OK; done++) {
    const record_t* r = &vault->records[done];
    record_t* n = &resealed[done];
    *n = *r;
    n->origin = (char*)dup_bytes((const uint8_t*)r->origin, r->origin_len);
    n->sealed = NULL;
    uint8_t* plain = NULL;
    size_t plain_len = 0;
    status = n->origin ? BWV_OK : BWV_E_NOMEM;
    if (status == BWV_OK) {
      status = secret_op(vault->id, vault->keys, 0, r->id, r->origin,
                         r->origin_len, r->sealed, r->sealed_len, &plain,
                         &plain_len);
    }
    if (status == BWV_OK) {
      status = secret_op(vault->id, fresh, 1, r->id, r->origin, r->origin_len,
                         plain, plain_len, &n->sealed, &n->sealed_len);
      sodium_free(plain);
    }
  }
  if (status != BWV_OK) {
    free_records(resealed, done);
    free_keys(&fresh);
    return status;
  }
  free_records(vault->records, vault->nrecords);
  vault->records = resealed;
  free_keys(&vault->keys);
  vault->keys = fresh;
  memset(vault->slots, 0, sizeof(vault->slots));
  memset(vault->pending, 0, sizeof(vault->pending));
  return BWV_OK;
}

/* ---- Parsing ---- */

static bwv_status parse_slot(bwv_vault* vault, uint8_t type,
                             const uint8_t* v, uint16_t len) {
  static const uint16_t lens[NUM_SLOTS] = {SLOT_PASSWORD_LEN, SLOT_RECOVERY_LEN,
                                           SLOT_KEYRING_LEN, SLOT_HELLO_LEN};
  slot_t* s = &vault->slots[SLOT_INDEX(type)];
  if (len != lens[SLOT_INDEX(type)] || s->present) {
    return BWV_E_FORMAT;
  }
  size_t n = 0;
  switch (type) {
    case BWV_SLOT_PASSWORD:
      /* Parameters and salt come from the KDF record. */
      break;
    case BWV_SLOT_RECOVERY:
      s->params.t = get32(v);
      s->params.m_kib = get32(v + 4);
      if (!params_ok(&s->params)) {
        return BWV_E_PARAMS;
      }
      memcpy(s->fixed, v + 8, BWV_SALT_BYTES);
      s->fixed_len = BWV_SALT_BYTES;
      n = 8 + BWV_SALT_BYTES;
      break;
    case BWV_SLOT_KEYRING:
      memcpy(s->fixed, v, BWV_ITEM_TAG_BYTES);
      s->fixed_len = n = BWV_ITEM_TAG_BYTES;
      break;
    case BWV_SLOT_HELLO:
      memcpy(s->fixed, v, BWV_CHALLENGE_BYTES);
      s->fixed_len = n = BWV_CHALLENGE_BYTES;
      break;
  }
  memcpy(s->nonce, v + n, NONCE_LEN);
  memcpy(s->wrapped, v + n + NONCE_LEN, WRAPPED_LEN);
  s->present = 1;
  return BWV_OK;
}

static bwv_status parse(bwv_vault* vault, const uint8_t* data, size_t len) {
  if (len < PREFIX_LEN || memcmp(data, MAGIC, sizeof(MAGIC)) != 0) {
    return BWV_E_FORMAT;
  }
  uint16_t version = get16(data + 8);
  if (version == 0) {
    return BWV_E_FORMAT;
  }
  if (version < BWV_FORMAT_VERSION) {
    return BWV_E_OLDER;
  }
  if (version > BWV_FORMAT_VERSION) {
    return BWV_E_NEWER;
  }
  size_t header_len = get16(data + 10);
  if (header_len > MAX_HEADER || get32(data + 12) != 0 ||
      len < PREFIX_LEN + header_len + NONCE_LEN + 4) {
    return BWV_E_FORMAT;
  }

  int have_id = 0, have_kdf = 0, have_aead = 0, have_counter = 0;
  slot_t* password = &vault->slots[SLOT_INDEX(BWV_SLOT_PASSWORD)];
  const uint8_t* p = data + PREFIX_LEN;
  const uint8_t* end = p + header_len;
  while (p < end) {
    if (end - p < 3) {
      return BWV_E_FORMAT;
    }
    uint8_t type = p[0];
    uint16_t rlen = get16(p + 1);
    const uint8_t* v = p + 3;
    if ((size_t)(end - v) < rlen) {
      return BWV_E_FORMAT;
    }
    bwv_status status = BWV_OK;
    switch (type) {
      case REC_ID:
        if (rlen != BWV_ID_BYTES || have_id++) {
          return BWV_E_FORMAT;
        }
        memcpy(vault->id, v, BWV_ID_BYTES);
        break;
      case REC_KDF:
        if (rlen != KDF_REC_LEN || have_kdf++) {
          return BWV_E_FORMAT;
        }
        if (v[0] != KDF_ARGON2ID) {
          return BWV_E_NEWER;
        }
        password->params.t = get32(v + 1);
        password->params.m_kib = get32(v + 5);
        if (v[9] != 1 || !params_ok(&password->params)) {
          return BWV_E_PARAMS;
        }
        memcpy(password->fixed, v + 10, BWV_SALT_BYTES);
        password->fixed_len = BWV_SALT_BYTES;
        break;
      case REC_AEAD:
        if (rlen != 1 || have_aead++) {
          return BWV_E_FORMAT;
        }
        if (v[0] != AEAD_XCHACHA20POLY1305) {
          return BWV_E_NEWER;
        }
        break;
      case REC_COUNTER:
        if (rlen != 8 || have_counter++) {
          return BWV_E_FORMAT;
        }
        vault->counter = get64(v);
        break;
      case BWV_SLOT_PASSWORD:
      case BWV_SLOT_RECOVERY:
      case BWV_SLOT_KEYRING:
      case BWV_SLOT_HELLO:
        status = parse_slot(vault, type, v, rlen);
        if (status != BWV_OK) {
          return status;
        }
        break;
      default: {
        if (type & REC_CRITICAL) {
          return BWV_E_NEWER;
        }
        /* Not ours yet: keep it, so a newer version's data survives a
         * rewrite by this one. */
        uint8_t* grown = (uint8_t*)realloc(vault->unknown,
                                           vault->unknown_len + 3 + rlen);
        if (!grown) {
          return BWV_E_NOMEM;
        }
        memcpy(grown + vault->unknown_len, p, 3 + (size_t)rlen);
        vault->unknown = grown;
        vault->unknown_len += 3 + (size_t)rlen;
      }
    }
    p = v + rlen;
  }
  if (!have_id || !have_kdf || !have_aead || !have_counter ||
      !password->present) {
    return BWV_E_FORMAT;
  }

  const uint8_t* body = data + PREFIX_LEN + header_len;
  size_t ct_len = get32(body + NONCE_LEN);
  if (ct_len < TAG_LEN || ct_len > MAX_BODY_CT ||
      len != PREFIX_LEN + header_len + NONCE_LEN + 4 + ct_len) {
    return BWV_E_FORMAT;
  }
  vault->aad_len = PREFIX_LEN + header_len;
  vault->body_len = NONCE_LEN + ct_len;
  vault->aad = (uint8_t*)malloc(vault->aad_len);
  vault->body = (uint8_t*)malloc(vault->body_len);
  if (!vault->aad || !vault->body) {
    return BWV_E_NOMEM;
  }
  memcpy(vault->aad, data, vault->aad_len);
  memcpy(vault->body, body, NONCE_LEN);
  memcpy(vault->body + NONCE_LEN, body + NONCE_LEN + 4, ct_len);
  return BWV_OK;
}

bwv_status bwv_load(bwv_vault* vault, const uint8_t* data, size_t len) {
  reset(vault);
  bwv_status status = parse(vault, data, len);
  if (status != BWV_OK) {
    reset(vault);
    return status;
  }
  vault->loaded = 1;
  return BWV_OK;
}

/* ---- The body ---- */

static int compare_ids(const void* a, const void* b) {
  return memcmp(((const record_t*)a)->id, ((const record_t*)b)->id,
                BWV_ENTRY_ID_BYTES);
}

/* The decrypted, unpadded payload into the vault's index and records. */
static bwv_status parse_payload(bwv_vault* vault, const uint8_t* p, size_t len) {
  if (len < PAYLOAD_HEAD) {
    return BWV_E_FORMAT;
  }
  size_t index_len = get32(p);
  size_t count = get32(p + 4);
  if (index_len > len - PAYLOAD_HEAD ||
      count > (len - PAYLOAD_HEAD - index_len) / (RECORD_HEAD + 1 + SEALED_MIN)) {
    return BWV_E_FORMAT;
  }
  uint8_t* index = secret_alloc(index_len);
  record_t* records = count ? (record_t*)calloc(count, sizeof(record_t)) : NULL;
  if (!index || (count && !records)) {
    bwv_secret_free(index);
    free(records);
    return BWV_E_NOMEM;
  }
  if (index_len) {
    memcpy(index, p + PAYLOAD_HEAD, index_len);
  }
  size_t pos = PAYLOAD_HEAD + index_len;
  size_t n = 0;
  bwv_status status = BWV_OK;
  for (; n < count; n++) {
    if (len - pos < RECORD_HEAD) {
      status = BWV_E_FORMAT;
      break;
    }
    size_t rec_len = get32(p + pos);
    const uint8_t* r = p + pos + 4;
    size_t origin_len = get16(r + BWV_ENTRY_ID_BYTES);
    if (rec_len > len - pos - 4 || rec_len < BWV_ENTRY_ID_BYTES + 2 ||
        !origin_ok("", origin_len) ||
        rec_len - BWV_ENTRY_ID_BYTES - 2 < origin_len + SEALED_MIN ||
        rec_len - BWV_ENTRY_ID_BYTES - 2 - origin_len > SEALED_MIN + BWV_MAX_SECRET) {
      status = BWV_E_FORMAT;
      break;
    }
    record_t* rec = &records[n];
    memcpy(rec->id, r, BWV_ENTRY_ID_BYTES);
    rec->origin_len = origin_len;
    rec->sealed_len = rec_len - BWV_ENTRY_ID_BYTES - 2 - origin_len;
    rec->origin = (char*)dup_bytes(r + BWV_ENTRY_ID_BYTES + 2, origin_len);
    rec->sealed = dup_bytes(r + BWV_ENTRY_ID_BYTES + 2 + origin_len, rec->sealed_len);
    if (!rec->origin || !rec->sealed) {
      n++;
      status = BWV_E_NOMEM;
      break;
    }
    pos += 4 + rec_len;
  }
  if (status == BWV_OK && pos != len) {
    status = BWV_E_FORMAT;
  }
  if (status == BWV_OK && count > 1) {
    /* One password per entry. */
    qsort(records, count, sizeof(record_t), compare_ids);
    for (size_t i = 1; i < count && status == BWV_OK; i++) {
      if (memcmp(records[i - 1].id, records[i].id, BWV_ENTRY_ID_BYTES) == 0) {
        status = BWV_E_FORMAT;
      }
    }
  }
  if (status != BWV_OK) {
    free_records(records, n);
    bwv_secret_free(index);
    return status;
  }
  close_body(vault);
  vault->index = index;
  vault->index_len = index_len;
  vault->records = records;
  vault->nrecords = count;
  vault->body_open = 1;
  return BWV_OK;
}

bwv_status bwv_open_body(bwv_vault* vault) {
  if (!vault->keys) {
    return BWV_E_LOCKED;
  }
  if (vault->body_open) {
    return BWV_OK;
  }
  if (!vault->body) {
    return BWV_E_STATE;
  }
  uint8_t* plain;
  size_t padded;
  sodium_mprotect_readonly(vault->keys);
  bwv_status status = open_box(vault->keys + KEY_IK, vault->aad, vault->aad_len,
                               vault->body, vault->body_len, &plain, &padded);
  sodium_mprotect_noaccess(vault->keys);
  if (status != BWV_OK) {
    return status;
  }
  size_t unpadded;
  if (sodium_unpad(&unpadded, plain, padded, PAD_BLOCK) != 0) {
    sodium_free(plain);
    return BWV_E_FORMAT;
  }
  status = parse_payload(vault, plain, unpadded);
  sodium_free(plain);
  return status;
}

static uint8_t* put_record(uint8_t* p, uint8_t type, const uint8_t* v,
                           uint16_t len) {
  p[0] = type;
  put16(p + 1, len);
  memcpy(p + 3, v, len);
  return p + 3 + len;
}

/* The header for `counter`, into `out` (MAX_HEADER bytes). */
static size_t build_header(const bwv_vault* vault, uint64_t counter,
                           uint8_t* out) {
  uint8_t v[SLOT_HELLO_LEN];
  uint8_t* p = out;
  p = put_record(p, REC_ID, vault->id, BWV_ID_BYTES);

  const slot_t* pw = &vault->slots[SLOT_INDEX(BWV_SLOT_PASSWORD)];
  v[0] = KDF_ARGON2ID;
  put32(v + 1, pw->params.t);
  put32(v + 5, pw->params.m_kib);
  v[9] = 1;
  memcpy(v + 10, pw->fixed, BWV_SALT_BYTES);
  p = put_record(p, REC_KDF, v, KDF_REC_LEN);

  v[0] = AEAD_XCHACHA20POLY1305;
  p = put_record(p, REC_AEAD, v, 1);
  put64(v, counter);
  p = put_record(p, REC_COUNTER, v, 8);

  for (int i = 0; i < NUM_SLOTS; i++) {
    const slot_t* s = &vault->slots[i];
    if (!s->present) {
      continue;
    }
    size_t n = 0;
    if (i == SLOT_INDEX(BWV_SLOT_RECOVERY)) {
      put32(v, s->params.t);
      put32(v + 4, s->params.m_kib);
      n = 8;
    }
    if (i != SLOT_INDEX(BWV_SLOT_PASSWORD)) {
      memcpy(v + n, s->fixed, s->fixed_len);
      n += s->fixed_len;
    }
    memcpy(v + n, s->nonce, NONCE_LEN);
    memcpy(v + n + NONCE_LEN, s->wrapped, WRAPPED_LEN);
    n += NONCE_LEN + WRAPPED_LEN;
    p = put_record(p, (uint8_t)(BWV_SLOT_PASSWORD + i), v, (uint16_t)n);
  }
  if (vault->unknown_len) {
    memcpy(p, vault->unknown, vault->unknown_len);
  }
  return (size_t)(p - out) + vault->unknown_len;
}

#define OWN_HEADER_MAX                                                    \
  (3 * 4 + BWV_ID_BYTES + KDF_REC_LEN + 1 + 8 + SLOT_PASSWORD_LEN +       \
   SLOT_RECOVERY_LEN + SLOT_KEYRING_LEN + SLOT_HELLO_LEN + 3 * NUM_SLOTS)

bwv_status bwv_serialize(bwv_vault* vault, uint8_t** file, size_t* file_len) {
  if (!vault->keys || !vault->body_open) {
    return BWV_E_LOCKED;
  }
  if (!vault->slots[SLOT_INDEX(BWV_SLOT_PASSWORD)].present) {
    return BWV_E_STATE;
  }
  if (OWN_HEADER_MAX + vault->unknown_len > MAX_HEADER) {
    return BWV_E_FORMAT;
  }
  size_t payload_len = PAYLOAD_HEAD + vault->index_len;
  for (size_t i = 0; i < vault->nrecords; i++) {
    payload_len += RECORD_HEAD + vault->records[i].origin_len +
                   vault->records[i].sealed_len;
  }
  if (payload_len > MAX_BODY_CT - TAG_LEN - PAD_BLOCK) {
    return BWV_E_ARG;
  }

  size_t padded_max = payload_len + PAD_BLOCK;
  uint8_t* padded = secret_alloc(padded_max);
  if (!padded) {
    return BWV_E_NOMEM;
  }
  put32(padded, (uint32_t)vault->index_len);
  put32(padded + 4, (uint32_t)vault->nrecords);
  size_t pos = PAYLOAD_HEAD;
  if (vault->index_len) {
    memcpy(padded + pos, vault->index, vault->index_len);
  }
  pos += vault->index_len;
  for (size_t i = 0; i < vault->nrecords; i++) {
    const record_t* r = &vault->records[i];
    put32(padded + pos, (uint32_t)(BWV_ENTRY_ID_BYTES + 2 + r->origin_len + r->sealed_len));
    memcpy(padded + pos + 4, r->id, BWV_ENTRY_ID_BYTES);
    put16(padded + pos + 4 + BWV_ENTRY_ID_BYTES, (uint16_t)r->origin_len);
    memcpy(padded + pos + RECORD_HEAD, r->origin, r->origin_len);
    memcpy(padded + pos + RECORD_HEAD + r->origin_len, r->sealed, r->sealed_len);
    pos += RECORD_HEAD + r->origin_len + r->sealed_len;
  }
  size_t padded_len;
  sodium_pad(&padded_len, padded, payload_len, PAD_BLOCK, padded_max);

  uint8_t header[MAX_HEADER];
  uint64_t counter = vault->counter + 1;
  size_t header_len = build_header(vault, counter, header);
  size_t ct_len = padded_len + TAG_LEN;
  size_t total = PREFIX_LEN + header_len + NONCE_LEN + 4 + ct_len;
  uint8_t* out = (uint8_t*)malloc(total);
  uint8_t* aad = (uint8_t*)malloc(PREFIX_LEN + header_len);
  uint8_t* stored = (uint8_t*)malloc(NONCE_LEN + ct_len);
  if (!out || !aad || !stored) {
    free(out);
    free(aad);
    free(stored);
    sodium_free(padded);
    return BWV_E_NOMEM;
  }

  memcpy(out, MAGIC, sizeof(MAGIC));
  put16(out + 8, BWV_FORMAT_VERSION);
  put16(out + 10, (uint16_t)header_len);
  put32(out + 12, 0);
  memcpy(out + PREFIX_LEN, header, header_len);
  uint8_t* nonce = out + PREFIX_LEN + header_len;
  randombytes_buf(nonce, NONCE_LEN);
  put32(nonce + NONCE_LEN, (uint32_t)ct_len);
  sodium_mprotect_readonly(vault->keys);
  crypto_aead_xchacha20poly1305_ietf_encrypt(
      nonce + NONCE_LEN + 4, NULL, padded, padded_len, out,
      PREFIX_LEN + header_len, NULL, nonce, vault->keys + KEY_IK);
  sodium_mprotect_noaccess(vault->keys);
  sodium_free(padded);

  /* What we hold now matches what was written. */
  memcpy(aad, out, PREFIX_LEN + header_len);
  memcpy(stored, nonce, NONCE_LEN);
  memcpy(stored + NONCE_LEN, nonce + NONCE_LEN + 4, ct_len);
  free(vault->aad);
  free(vault->body);
  vault->aad = aad;
  vault->aad_len = PREFIX_LEN + header_len;
  vault->body = stored;
  vault->body_len = NONCE_LEN + ct_len;
  vault->counter = counter;

  *file = out;
  *file_len = total;
  return BWV_OK;
}

#ifdef BWV_TESTING

void bwv_test_key_fingerprint(const bwv_vault* vault, uint8_t out[32]) {
  /* The string also marks this code: release.yml checks the browser binary
   * for it. */
  static const char marker[] = "bwv-test-only fingerprint";
  memset(out, 0, 32);
  if (!vault->keys) {
    return;
  }
  sodium_mprotect_readonly(vault->keys);
  crypto_generichash(out, 32, (const unsigned char*)marker, sizeof(marker) - 1,
                     vault->keys + KEY_VK, BWV_KEY_BYTES);
  sodium_mprotect_noaccess(vault->keys);
}

bwv_status bwv_test_adopt_keys(bwv_vault* dst, const bwv_vault* src) {
  if (!src->keys) {
    return BWV_E_LOCKED;
  }
  bwv_lock(dst);
  dst->keys = (unsigned char*)sodium_malloc(KEYS_LEN);
  if (!dst->keys) {
    return BWV_E_NOMEM;
  }
  sodium_mprotect_readonly(src->keys);
  memcpy(dst->keys, src->keys, KEYS_LEN);
  sodium_mprotect_noaccess(src->keys);
  sodium_mprotect_noaccess(dst->keys);
  return BWV_OK;
}

bwv_status bwv_test_add_unknown(bwv_vault* vault, uint8_t type,
                                const uint8_t* value, uint16_t len) {
  uint8_t* grown = (uint8_t*)realloc(vault->unknown, vault->unknown_len + 3 + len);
  if (!grown) {
    return BWV_E_NOMEM;
  }
  grown[vault->unknown_len] = type;
  put16(grown + vault->unknown_len + 1, len);
  memcpy(grown + vault->unknown_len + 3, value, len);
  vault->unknown = grown;
  vault->unknown_len += 3 + (size_t)len;
  return BWV_OK;
}

#endif
