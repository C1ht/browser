/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "LinuxKeyring.h"

#include <string.h>

#ifdef MOZ_WIDGET_GTK
#  include <gio/gio.h>

#  include "mozilla/StaticMutex.h"
#  include "nsPrintfCString.h"
#  include "prlink.h"
#endif

namespace mozilla::browserwip::linux_keyring {

#ifdef MOZ_WIDGET_GTK

namespace {

// libsecret's own declarations (libsecret/secret-schema.h), so building
// doesn't need its headers; Gecko's LibSecret.cpp does the same.
typedef enum { SECRET_SCHEMA_NONE = 0 } SecretSchemaFlags;
typedef enum { SECRET_SCHEMA_ATTRIBUTE_STRING = 0 } SecretSchemaAttributeType;
typedef struct {
  const gchar* name;
  SecretSchemaAttributeType type;
} SecretSchemaAttribute;
typedef struct {
  const gchar* name;
  SecretSchemaFlags flags;
  SecretSchemaAttribute attributes[32];
  gint reserved;
  gpointer reserved1;
  gpointer reserved2;
  gpointer reserved3;
  gpointer reserved4;
  gpointer reserved5;
  gpointer reserved6;
  gpointer reserved7;
} SecretSchema;
typedef enum { SECRET_SEARCH_ALL = 1 << 1 } SecretSearchFlags;
typedef enum { SECRET_ERROR_IS_LOCKED = 2 } SecretError;

typedef gboolean (*store_fn)(const SecretSchema*, const gchar*, const gchar*,
                             const gchar*, GCancellable*, GError**, ...);
typedef gchar* (*lookup_fn)(const SecretSchema*, GCancellable*, GError**, ...);
typedef gboolean (*clear_fn)(const SecretSchema*, GCancellable*, GError**, ...);
typedef void (*free_fn)(gchar*);
typedef GQuark (*quark_fn)();
// Since libsecret 0.19; without them, leftover items aren't tidied up.
typedef GList* (*search_fn)(const SecretSchema*, SecretSearchFlags,
                            GCancellable*, GError**, ...);
typedef GHashTable* (*attributes_fn)(gpointer);

struct LibSecret {
  bool mTried = false;
  PRLibrary* mLib = nullptr;
  store_fn mStore = nullptr;
  lookup_fn mLookup = nullptr;
  clear_fn mClear = nullptr;
  free_fn mFree = nullptr;
  quark_fn mErrorQuark = nullptr;
  search_fn mSearch = nullptr;
  attributes_fn mAttributes = nullptr;
};

StaticMutex sLock;
LibSecret sLib;

// Loaded once, on first use, from whichever thread gets there first.
const LibSecret* Lib() {
  StaticMutexAutoLock lock(sLock);
  if (!sLib.mTried) {
    sLib.mTried = true;
    sLib.mLib = PR_LoadLibrary("libsecret-1.so.0");
    if (sLib.mLib) {
      auto find = [](const char* aName) {
        return PR_FindFunctionSymbol(sLib.mLib, aName);
      };
      sLib.mStore = (store_fn)find("secret_password_store_sync");
      sLib.mLookup = (lookup_fn)find("secret_password_lookup_sync");
      sLib.mClear = (clear_fn)find("secret_password_clear_sync");
      sLib.mFree = (free_fn)find("secret_password_free");
      sLib.mErrorQuark = (quark_fn)find("secret_error_get_quark");
      sLib.mSearch = (search_fn)find("secret_password_search_sync");
      sLib.mAttributes = (attributes_fn)find("secret_retrievable_get_attributes");
      if (!sLib.mStore || !sLib.mLookup || !sLib.mClear || !sLib.mFree ||
          !sLib.mErrorQuark) {
        PR_UnloadLibrary(sLib.mLib);
        sLib = LibSecret{};
        sLib.mTried = true;
      }
    }
  }
  return sLib.mLib ? &sLib : nullptr;
}

// The name is in the codename on purpose (tools/rename.sh renames it): it
// identifies items, it isn't key material.
const SecretSchema kSchema = {"org.browserwip.Vault",
                              SECRET_SCHEMA_NONE,
                              {{"vault", SECRET_SCHEMA_ATTRIBUTE_STRING},
                               {"generation", SECRET_SCHEMA_ATTRIBUTE_STRING},
                               {nullptr, SECRET_SCHEMA_ATTRIBUTE_STRING}}};

constexpr char kSecretService[] = "org.freedesktop.secrets";

void Wipe(void* aData, size_t aLen) {
  volatile uint8_t* p = static_cast<volatile uint8_t*>(aData);
  while (aLen--) {
    *p++ = 0;
  }
}

// Lower-case hex, NUL-terminated: aOut has room for 2 * aLen + 1.
void Hex(const uint8_t* aData, size_t aLen, char* aOut) {
  static const char kDigits[] = "0123456789abcdef";
  for (size_t i = 0; i < aLen; i++) {
    aOut[2 * i] = kDigits[aData[i] >> 4];
    aOut[2 * i + 1] = kDigits[aData[i] & 0xf];
  }
  aOut[2 * aLen] = '\0';
}

bool Unhex(const char* aText, uint8_t* aOut, size_t aLen) {
  if (strlen(aText) != 2 * aLen) {
    return false;
  }
  auto digit = [](char c) {
    return c >= '0' && c <= '9'   ? c - '0'
           : c >= 'a' && c <= 'f' ? c - 'a' + 10
           : c >= 'A' && c <= 'F' ? c - 'A' + 10
                                  : -1;
  };
  for (size_t i = 0; i < aLen; i++) {
    int hi = digit(aText[2 * i]);
    int lo = digit(aText[2 * i + 1]);
    if (hi < 0 || lo < 0) {
      return false;
    }
    aOut[i] = static_cast<uint8_t>(hi << 4 | lo);
  }
  return true;
}

// Asks the bus daemon (not the Secret Service, which this mustn't start).
bool BusHas(const char* aMethod, const char* aName) {
  GError* error = nullptr;
  GDBusConnection* bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error);
  if (!bus) {
    g_clear_error(&error);
    return false;
  }
  bool found = false;
  bool owner = !strcmp(aMethod, "NameHasOwner");
  GVariant* reply = g_dbus_connection_call_sync(
      bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
      aMethod, owner ? g_variant_new("(s)", aName) : nullptr,
      owner ? G_VARIANT_TYPE("(b)") : G_VARIANT_TYPE("(as)"),
      G_DBUS_CALL_FLAGS_NONE, 5000, nullptr, &error);
  if (reply) {
    if (owner) {
      gboolean has = FALSE;
      g_variant_get(reply, "(b)", &has);
      found = has;
    } else {
      GVariantIter* names = nullptr;
      const gchar* name = nullptr;
      g_variant_get(reply, "(as)", &names);
      while (g_variant_iter_loop(names, "&s", &name)) {
        if (!strcmp(name, aName)) {
          found = true;
        }
      }
      g_variant_iter_free(names);
    }
    g_variant_unref(reply);
  }
  g_clear_error(&error);
  g_object_unref(bus);
  return found;
}

bool Running() { return BusHas("NameHasOwner", kSecretService); }

bwv_status Failure(const LibSecret* aLib, GError* aError) {
  bwv_status st = BWV_E_PROVIDER;
  if (aError && ((aError->domain == aLib->mErrorQuark() &&
                  aError->code == SECRET_ERROR_IS_LOCKED) ||
                 g_error_matches(aError, G_IO_ERROR, G_IO_ERROR_CANCELLED))) {
    st = BWV_E_CANCELLED;
  }
  return st;
}

}  // namespace

bool Available() {
  return Lib() && (Running() || BusHas("ListActivatableNames", kSecretService));
}

bwv_status Store(void* aCtx, const uint8_t aVaultId[BWV_ID_BYTES],
                 const uint8_t aGeneration[BWV_ITEM_TAG_BYTES],
                 const uint8_t aKey[BWV_KEY_BYTES]) {
  const LibSecret* lib = Lib();
  if (!lib) {
    return BWV_E_PROVIDER;
  }
  char vault[2 * BWV_ID_BYTES + 1];
  char gen[2 * BWV_ITEM_TAG_BYTES + 1];
  char secret[2 * BWV_KEY_BYTES + 1];
  Hex(aVaultId, BWV_ID_BYTES, vault);
  Hex(aGeneration, BWV_ITEM_TAG_BYTES, gen);
  Hex(aKey, BWV_KEY_BYTES, secret);
  // What keyring managers list it as.
  nsPrintfCString label("browser-wip passwords (vault %.8s, key %.8s)", vault, gen);
  GError* error = nullptr;
  gboolean ok = lib->mStore(&kSchema, "default", label.get(), secret, nullptr,
                            &error, "vault", vault, "generation", gen, nullptr);
  Wipe(secret, sizeof(secret));
  bwv_status st = ok ? BWV_OK : Failure(lib, error);
  g_clear_error(&error);
  return st;
}

bwv_status Lookup(void* aCtx, const uint8_t aVaultId[BWV_ID_BYTES],
                  const uint8_t aGeneration[BWV_ITEM_TAG_BYTES],
                  uint8_t aKey[BWV_KEY_BYTES]) {
  const LibSecret* lib = Lib();
  if (!lib) {
    return BWV_E_PROVIDER;
  }
  char vault[2 * BWV_ID_BYTES + 1];
  char gen[2 * BWV_ITEM_TAG_BYTES + 1];
  Hex(aVaultId, BWV_ID_BYTES, vault);
  Hex(aGeneration, BWV_ITEM_TAG_BYTES, gen);
  GError* error = nullptr;
  gchar* secret = lib->mLookup(&kSchema, nullptr, &error, "vault", vault,
                               "generation", gen, nullptr);
  bwv_status st = BWV_OK;
  if (!secret) {
    // No item (deleted, or another computer's keyring), or no keyring.
    st = Failure(lib, error);
  } else if (!Unhex(secret, aKey, BWV_KEY_BYTES)) {
    Wipe(aKey, BWV_KEY_BYTES);
    st = BWV_E_PROVIDER;
  }
  if (secret) {
    // Wipes it before freeing.
    lib->mFree(secret);
  }
  g_clear_error(&error);
  return st;
}

bwv_status DeleteExcept(void* aCtx, const uint8_t aVaultId[BWV_ID_BYTES],
                        const uint8_t* aKeep) {
  const LibSecret* lib = Lib();
  if (!lib || !lib->mSearch || !lib->mAttributes || !Running()) {
    return BWV_OK;
  }
  char vault[2 * BWV_ID_BYTES + 1];
  char keep[2 * BWV_ITEM_TAG_BYTES + 1] = {0};
  Hex(aVaultId, BWV_ID_BYTES, vault);
  if (aKeep) {
    Hex(aKeep, BWV_ITEM_TAG_BYTES, keep);
  }
  GError* error = nullptr;
  // Locked items are listed too, without unlocking them.
  GList* items =
      lib->mSearch(&kSchema, SECRET_SEARCH_ALL, nullptr, &error, "vault", vault, nullptr);
  if (error) {
    g_clear_error(&error);
    return BWV_E_PROVIDER;
  }
  bwv_status st = BWV_OK;
  for (GList* item = items; item; item = item->next) {
    GHashTable* attributes = lib->mAttributes(item->data);
    const char* gen =
        attributes ? static_cast<const char*>(g_hash_table_lookup(attributes, "generation"))
                   : nullptr;
    if (gen && (!aKeep || strcmp(gen, keep))) {
      if (!lib->mClear(&kSchema, nullptr, &error, "vault", vault, "generation",
                       gen, nullptr) &&
          error) {
        st = BWV_E_PROVIDER;
      }
      g_clear_error(&error);
    }
    if (attributes) {
      g_hash_table_unref(attributes);
    }
  }
  g_list_free_full(items, g_object_unref);
  return st;
}

#else  // !MOZ_WIDGET_GTK

bool Available() { return false; }

bwv_status Store(void*, const uint8_t*, const uint8_t*, const uint8_t*) {
  return BWV_E_PROVIDER;
}

bwv_status Lookup(void*, const uint8_t*, const uint8_t*, uint8_t*) {
  return BWV_E_PROVIDER;
}

bwv_status DeleteExcept(void*, const uint8_t*, const uint8_t*) { return BWV_OK; }

#endif

}  // namespace mozilla::browserwip::linux_keyring
