/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "PasswordVault.h"
#include "WindowsUnlock.h"

#include <inttypes.h>
#include <string.h>

#include "bwvault.h"
#include "bwvstore.h"
#include "bwvtxn.h"
#include "mozilla/Base64.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/ErrorResult.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/Promise-inl.h"
#include "nsIObserverService.h"
#include "nsPrintfCString.h"
#include "nsProxyRelease.h"
#include "nsTHashMap.h"
#include "nsThreadUtils.h"
#include "nsXULAppAPI.h"
#include "xpcpublic.h"

namespace mozilla::browserwip {

using dom::Promise;
using Outcome = PasswordVault::Outcome;

namespace {

StaticRefPtr<PasswordVault> sSingleton;

// A new vault's master-password KDF: Argon2id, 256 MiB, t = 3 (§4.3).
const bwv_kdf_params kDefaultKdf = {BWV_KDF_DEFAULT_T, BWV_KDF_DEFAULT_M_KIB};

// Large enough for any slot's fixed inputs (a salt, a tag, a challenge).
constexpr size_t kSlotInputsMax = 64;

void Wipe(void* aData, size_t aLen) {
  volatile uint8_t* p = static_cast<volatile uint8_t*>(aData);
  while (aLen--) {
    *p++ = 0;
  }
}

void Wipe(nsCString& aValue) {
  if (!aValue.IsEmpty()) {
    Wipe(aValue.BeginWriting(), aValue.Length());
  }
  aValue.Truncate();
}

// A buffer of our own, so that wiping it wipes the copy we made. The one
// XPConnect made from the JS string is freed by it; JS strings themselves
// can't be wiped (docs/PASSWORDS.md §8).
nsCString Own(const nsACString& aValue) {
  return nsCString(aValue.BeginReading(), aValue.Length());
}

Outcome Done(bwv_status aStatus) {
  Outcome out;
  out.mStatus = aStatus;
  return out;
}

Outcome Text(nsCString&& aValue, bool aSecret) {
  Outcome out;
  out.mKind = Outcome::Kind::String;
  out.mString = std::move(aValue);
  out.mSecret = aSecret;
  return out;
}

Outcome Flag(bool aValue) {
  Outcome out;
  out.mKind = Outcome::Kind::Bool;
  out.mBool = aValue;
  return out;
}

bool DecodeId(const nsCString& aId, uint8_t aOut[BWV_ENTRY_ID_BYTES]) {
  FallibleTArray<uint8_t> bytes;
  if (NS_FAILED(Base64URLDecode(aId, Base64URLDecodePaddingPolicy::Reject, bytes)) ||
      bytes.Length() != BWV_ENTRY_ID_BYTES) {
    return false;
  }
  memcpy(aOut, bytes.Elements(), BWV_ENTRY_ID_BYTES);
  return true;
}

// vault.bwv, loaded and still locked.
bwv_status LoadFile(bws_store* aStore, bwv_vault** aOut) {
  uint8_t* data = nullptr;
  size_t len = 0;
  bwv_status st = bws_read(aStore, BWS_VAULT, &data, &len);
  if (st != BWV_OK) {
    return st;
  }
  bwv_vault* vault = bwv_new();
  st = vault ? bwv_load(vault, data, len) : BWV_E_NOMEM;
  bwv_bytes_free(data);
  if (st != BWV_OK) {
    bwv_free(vault);
    return st;
  }
  *aOut = vault;
  return BWV_OK;
}

// The key of `aVault`'s password slot for `aPassword` (Argon2id: the slow
// part of unlocking).
bwv_status PasswordKey(const bwv_vault* aVault, const nsCString& aPassword,
                       bwv_key** aOut) {
  bwv_kdf_params params;
  uint8_t inputs[kSlotInputsMax];
  size_t inputsLen = 0;
  bwv_status st =
      bwv_slot_inputs(aVault, BWV_SLOT_PASSWORD, &params, inputs, &inputsLen);
  if (st != BWV_OK) {
    return st;
  }
  if (inputsLen < BWV_SALT_BYTES) {
    return BWV_E_FORMAT;
  }
  bwv_key* key = bwv_key_new();
  if (!key) {
    return BWV_E_NOMEM;
  }
  st = bwv_derive_password_key(&params, inputs, aPassword.get(),
                               aPassword.Length(), key);
  if (st != BWV_OK) {
    bwv_key_free(key);
    return st;
  }
  *aOut = key;
  return BWV_OK;
}

// A new, unlocked vault with one password slot under aPassword (Argon2id
// with the default parameters): for setup and for an encrypted export.
bwv_status NewVault(const nsCString& aPassword, bwv_vault** aOut) {
  bwv_vault* vault = bwv_new();
  bwv_status st = vault ? bwv_create(vault) : BWV_E_NOMEM;
  if (st == BWV_OK) {
    st = bwv_prepare_slot(vault, BWV_SLOT_PASSWORD, &kDefaultKdf);
  }
  bwv_kdf_params params;
  uint8_t inputs[kSlotInputsMax];
  size_t inputsLen = 0;
  if (st == BWV_OK) {
    st = bwv_prepared_inputs(vault, BWV_SLOT_PASSWORD, &params, inputs,
                             &inputsLen);
  }
  bwv_key* key = nullptr;
  if (st == BWV_OK) {
    key = bwv_key_new();
    st = key ? bwv_derive_password_key(&params, inputs, aPassword.get(),
                                       aPassword.Length(), key)
             : BWV_E_NOMEM;
  }
  if (st == BWV_OK) {
    st = bwv_set_slot(vault, BWV_SLOT_PASSWORD, key);
  }
  bwv_key_free(key);
  if (st != BWV_OK) {
    bwv_free(vault);
    return st;
  }
  *aOut = vault;
  return BWV_OK;
}

// Copies one password from aFrom (sealed to aFromOrigin) to aTo.
bwv_status CopySecret(const bwv_vault* aFrom, const nsCString& aFromId,
                      const nsCString& aFromOrigin, bwv_vault* aTo,
                      const nsCString& aToId, const nsCString& aToOrigin) {
  uint8_t from[BWV_ENTRY_ID_BYTES];
  uint8_t to[BWV_ENTRY_ID_BYTES];
  if (!DecodeId(aFromId, from) || !DecodeId(aToId, to)) {
    return BWV_E_ARG;
  }
  uint8_t* data = nullptr;
  size_t len = 0;
  bwv_status st = bwv_get_secret(aFrom, from, aFromOrigin.get(),
                                 aFromOrigin.Length(), &data, &len);
  if (st == BWV_OK) {
    st = bwv_set_secret(aTo, to, aToOrigin.get(), aToOrigin.Length(), data, len);
  }
  bwv_secret_free(data);
  return st;
}

// Whether aPassword opens the password slot of vault.bwv as it is on disk.
bwv_status CheckMaster(bws_store* aStore, const nsCString& aPassword) {
  bwv_vault* vault = nullptr;
  bwv_key* key = nullptr;
  bwv_status st = LoadFile(aStore, &vault);
  if (st == BWV_OK) {
    st = PasswordKey(vault, aPassword, &key);
  }
  if (st == BWV_OK) {
    st = bwv_unlock(vault, BWV_SLOT_PASSWORD, key);
  }
  bwv_key_free(key);
  bwv_free(vault);
  return st;
}

// The key of `aVault`'s Hello slot: its challenge signed with this vault's
// Hello key (one prompt), through HKDF (§5.3).
bwv_status HelloKey(const bwv_vault* aVault, const uint8_t aChallenge[BWV_CHALLENGE_BYTES],
                    bwv_key** aOut) {
  uint8_t id[BWV_ID_BYTES];
  bwv_get_id(aVault, id);
  uint8_t signature[BWT_MAX_SIGNATURE];
  size_t len = sizeof(signature);
  bwv_status st = windows_unlock::HelloSign(nullptr, id, aChallenge, signature, &len);
  bwv_key* key = nullptr;
  if (st == BWV_OK) {
    key = bwv_key_new();
    st = key ? bwv_derive_hello_key(id, signature, len, key) : BWV_E_NOMEM;
  }
  Wipe(signature, sizeof(signature));
  if (st != BWV_OK) {
    bwv_key_free(key);
    return st;
  }
  *aOut = key;
  return BWV_OK;
}

void NotifySessionLocked() {
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (obs) {
    obs->NotifyObservers(nullptr, "browserwip:session-locked", nullptr);
  }
}

// An exported vault is at most this big (a few hundred thousand logins).
constexpr size_t kMaxImportBytes = 64 * 1024 * 1024;

// A login waiting to be saved: its password, sealed under the capture key.
struct Box {
  uint8_t* mData = nullptr;
  size_t mLen = 0;
  ~Box() { bwv_bytes_free(mData); }
};

void Settle(Promise* aPromise, Outcome& aOut) {
  if (aOut.mStatus != BWV_OK) {
    aPromise->MaybeRejectWithOperationError(nsDependentCString(
        bwv_status_name(static_cast<bwv_status>(aOut.mStatus))));
  } else if (aOut.mKind == Outcome::Kind::String) {
    nsAutoString value;
    CopyUTF8toUTF16(aOut.mString, value);
    aPromise->MaybeResolve(value);
    if (aOut.mSecret && !value.IsEmpty()) {
      Wipe(value.BeginWriting(), value.Length() * sizeof(char16_t));
    }
  } else if (aOut.mKind == Outcome::Kind::Bool) {
    aPromise->MaybeResolve(aOut.mBool);
  } else {
    aPromise->MaybeResolveWithUndefined();
  }
  if (aOut.mSecret) {
    Wipe(aOut.mString);
  }
}

}  // namespace

// Everything the core holds. Only ever used on the task queue.
struct PasswordVault::Core {
  bool mInitialized = false;
  bws_store* mStore = nullptr;
  bwt_session* mSession = nullptr;
  bool mPermsFixed = false;
  bool mCleanup = false;
  // Logins submitted and not yet saved, sealed under a key that exists
  // only for the session (§7.3).
  bwv_key* mCaptureKey = nullptr;
  uint64_t mNextCapture = 1;
  nsTHashMap<nsCStringHashKey, UniquePtr<Box>> mCaptures;
  // An exported vault opened for import, unlocked, beside this one.
  bwv_vault* mImport = nullptr;

  ~Core() { Close(); }

  bwv_status Init() {
    if (!mInitialized) {
      bwv_status st = bwv_init();
      if (st != BWV_OK) {
        return st;
      }
      mInitialized = true;
    }
    return BWV_OK;
  }

  bwv_vault* Vault() { return mSession ? bwt_vault(mSession) : nullptr; }

  void DropCaptures() {
    mCaptures.Clear();
    bwv_key_free(mCaptureKey);
    mCaptureKey = nullptr;
  }

  // Wipes the vault (keys, index, passwords) and the captured logins.
  void Lock() {
    if (mSession) {
      bwt_attach(mSession, nullptr);
    }
    DropCaptures();
    CloseImport();
  }

  void CloseImport() {
    bwv_free(mImport);
    mImport = nullptr;
  }

  void Close() {
    Lock();
    bwt_session_free(mSession);
    mSession = nullptr;
    bws_close(mStore);
    mStore = nullptr;
  }

  bwv_status OpenCapture(const nsCString& aId, uint8_t** aOut, size_t* aLen) {
    auto lookup = mCaptures.Lookup(aId);
    Box* box = lookup ? lookup.Data().get() : nullptr;
    if (!box || !mCaptureKey) {
      return BWV_E_NOT_FOUND;
    }
    return bwv_box_open(mCaptureKey, reinterpret_cast<const uint8_t*>(aId.get()),
                        aId.Length(), box->mData, box->mLen, aOut, aLen);
  }
};

NS_IMPL_ISUPPORTS(PasswordVault, nsIPasswordVault, nsIObserver)

already_AddRefed<PasswordVault> PasswordVault::GetSingleton() {
  MOZ_ASSERT(NS_IsMainThread());
  if (!sSingleton) {
    if (!XRE_IsParentProcess()) {
      return nullptr;
    }
    RefPtr<PasswordVault> vault = new PasswordVault();
    if (NS_FAILED(vault->Init())) {
      return nullptr;
    }
    sSingleton = vault;
    ClearOnShutdown(&sSingleton);
  }
  return do_AddRef(sSingleton);
}

PasswordVault::~PasswordVault() {
  if (mCore && mQueue) {
    Core* core = mCore;
    mCore = nullptr;
    mQueue->Dispatch(NS_NewRunnableFunction("PasswordVault::~PasswordVault",
                                            [core]() { delete core; }));
  }
}

nsresult PasswordVault::Init() {
  nsresult rv = NS_CreateBackgroundTaskQueue("PasswordVault", getter_AddRefs(mQueue));
  NS_ENSURE_SUCCESS(rv, rv);
  mCore = new Core();
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (obs) {
    obs->AddObserver(this, "profile-before-change", false);
  }
  // Locking the Windows session locks the vault (§5.4).
  windows_unlock::WatchSessionLock(NotifySessionLocked);
  return NS_OK;
}

NS_IMETHODIMP
PasswordVault::Observe(nsISupports* aSubject, const char* aTopic,
                       const char16_t* aData) {
  if (!strcmp(aTopic, "profile-before-change")) {
    Shutdown();
  }
  return NS_OK;
}

// Quitting locks: the keys are wiped and the vault directory's lock is
// released before the profile goes away.
void PasswordVault::Shutdown() {
  if (mShutDown) {
    return;
  }
  mShutDown = true;
  windows_unlock::StopWatchingSessionLock();
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (obs) {
    obs->RemoveObserver(this, "profile-before-change");
  }
  if (mQueue && mCore) {
    Core* core = mCore;
    mCore = nullptr;
    NS_DispatchAndSpinEventLoopUntilComplete(
        "PasswordVault::Shutdown wipes the vault keys"_ns, mQueue,
        NS_NewRunnableFunction("PasswordVault::Shutdown",
                               [core]() { delete core; }));
  }
}

nsresult PasswordVault::Run(JSContext* aCx, Promise** aPromise,
                            const char* aName,
                            std::function<Outcome(Core&)>&& aTask) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG_POINTER(aPromise);
  nsIGlobalObject* global = xpc::CurrentNativeGlobal(aCx);
  if (NS_WARN_IF(!global)) {
    return NS_ERROR_UNEXPECTED;
  }
  ErrorResult result;
  RefPtr<Promise> promise = Promise::Create(global, result);
  if (NS_WARN_IF(result.Failed())) {
    return result.StealNSResult();
  }
  if (mShutDown || !mQueue || !mCore) {
    promise->MaybeRejectWithOperationError("BWV_E_STATE"_ns);
    promise.forget(aPromise);
    return NS_OK;
  }

  nsMainThreadPtrHandle<Promise> holder(
      new nsMainThreadPtrHolder<Promise>(aName, promise));
  Core* core = mCore;
  nsresult rv = mQueue->Dispatch(
      NS_NewRunnableFunction(
          aName,
          [core, holder, task = std::move(aTask)]() {
            Outcome out = task(*core);
            NS_DispatchToMainThread(NS_NewRunnableFunction(
                "PasswordVault settle",
                [holder, out = std::move(out)]() mutable {
                  Settle(holder.get(), out);
                }));
          }),
      NS_DISPATCH_NORMAL);
  if (NS_FAILED(rv)) {
    promise->MaybeRejectWithOperationError("BWV_E_STATE"_ns);
  }
  promise.forget(aPromise);
  return NS_OK;
}

NS_IMETHODIMP
PasswordVault::Open(const nsACString& aDir, JSContext* aCx,
                    Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::Open",
             [dir = nsCString(aDir)](Core& core) {
               bwv_status st = core.Init();
               if (st == BWV_OK && !core.mStore) {
                 int fixed = 0;
                 st = bws_open(dir.get(), &core.mStore, &fixed);
                 if (st == BWV_OK) {
                   core.mPermsFixed = fixed;
                   core.mSession = bwt_session_new(core.mStore, nullptr);
                   if (!core.mSession) {
                     bws_close(core.mStore);
                     core.mStore = nullptr;
                     st = BWV_E_NOMEM;
                   }
                 }
                 if (st == BWV_OK) {
                   core.mCleanup = bwt_recover(core.mSession) != BWV_OK;
                 }
               }
               if (st != BWV_OK) {
                 return Done(st);
               }
               return Text(
                   nsCString(nsPrintfCString(
                       R"({"exists":%s,"permsFixed":%s,"cleanup":%s})",
                       bws_exists(core.mStore, BWS_VAULT) ? "true" : "false",
                       core.mPermsFixed ? "true" : "false",
                       core.mCleanup ? "true" : "false")),
                   false);
             });
}

NS_IMETHODIMP
PasswordVault::Create(const nsACString& aPassword, const nsACString& aIndex,
                      JSContext* aCx, Promise** aPromise) {
  return Run(
      aCx, aPromise, "PasswordVault::Create",
      [pw = Own(aPassword), index = Own(aIndex)](Core& core) mutable {
        bwv_status st = core.mSession ? BWV_OK : BWV_E_STATE;
        // Never overwrite a vault, whatever state JS thinks it is in.
        if (st == BWV_OK && bws_exists(core.mStore, BWS_VAULT)) {
          st = BWV_E_STATE;
        }
        bwv_vault* vault = nullptr;
        if (st == BWV_OK) {
          st = NewVault(pw, &vault);
        }
        Wipe(pw);
        if (st == BWV_OK) {
          st = bwv_set_index(vault, reinterpret_cast<const uint8_t*>(index.get()),
                             index.Length());
        }
        Wipe(index);
        if (st != BWV_OK) {
          bwv_free(vault);
          return Done(st);
        }
        bwt_attach(core.mSession, vault);
        st = bwt_save(core.mSession);
        if (st != BWV_OK) {
          bwt_attach(core.mSession, nullptr);
        }
        return Done(st);
      });
}

NS_IMETHODIMP
PasswordVault::Unlock(const nsACString& aPassword, JSContext* aCx,
                      Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::Unlock",
             [pw = Own(aPassword)](Core& core) mutable {
               bwv_status st = core.mSession ? BWV_OK : BWV_E_STATE;
               bwv_vault* vault = nullptr;
               bwv_key* key = nullptr;
               if (st == BWV_OK) {
                 st = LoadFile(core.mStore, &vault);
               }
               if (st == BWV_OK) {
                 st = PasswordKey(vault, pw, &key);
               }
               Wipe(pw);
               if (st == BWV_OK) {
                 st = bwv_unlock(vault, BWV_SLOT_PASSWORD, key);
               }
               bwv_key_free(key);
               if (st == BWV_OK) {
                 st = bwv_open_body(vault);
               }
               nsCString index;
               if (st == BWV_OK) {
                 uint8_t* data = nullptr;
                 size_t len = 0;
                 st = bwv_get_index(vault, &data, &len);
                 if (st == BWV_OK) {
                   index.Assign(reinterpret_cast<const char*>(data), len);
                   bwv_secret_free(data);
                 }
               }
               if (st != BWV_OK) {
                 bwv_free(vault);
                 return Done(st);
               }
               bwt_attach(core.mSession, vault);
               return Text(std::move(index), true);
             });
}

NS_IMETHODIMP
PasswordVault::CheckPassword(const nsACString& aPassword, JSContext* aCx,
                             Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::CheckPassword",
             [pw = Own(aPassword)](Core& core) mutable {
               bwv_status st =
                   core.mSession ? CheckMaster(core.mStore, pw) : BWV_E_STATE;
               Wipe(pw);
               if (st == BWV_E_AUTH) {
                 return Flag(false);
               }
               return st == BWV_OK ? Flag(true) : Done(st);
             });
}

NS_IMETHODIMP
PasswordVault::Lock(JSContext* aCx, Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::Lock", [](Core& core) {
    core.Lock();
    return Done(BWV_OK);
  });
}

NS_IMETHODIMP
PasswordVault::Save(const nsACString& aIndex, JSContext* aCx,
                    Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::Save",
             [index = Own(aIndex)](Core& core) mutable {
               bwv_vault* vault = core.Vault();
               bwv_status st =
                   vault ? bwv_set_index(
                               vault,
                               reinterpret_cast<const uint8_t*>(index.get()),
                               index.Length())
                         : BWV_E_LOCKED;
               Wipe(index);
               if (st == BWV_OK) {
                 st = bwt_save(core.mSession);
               }
               return Done(st);
             });
}

NS_IMETHODIMP
PasswordVault::SetSecret(const nsACString& aEntryId, const nsACString& aOrigin,
                         const nsACString& aSecret, JSContext* aCx,
                         Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::SetSecret",
             [id = nsCString(aEntryId), origin = nsCString(aOrigin),
              secret = Own(aSecret)](Core& core) mutable {
               uint8_t raw[BWV_ENTRY_ID_BYTES];
               bwv_vault* vault = core.Vault();
               bwv_status st =
                   !vault                 ? BWV_E_LOCKED
                   : !DecodeId(id, raw)   ? BWV_E_ARG
                                          : bwv_set_secret(
                                              vault, raw, origin.get(),
                                              origin.Length(),
                                              reinterpret_cast<const uint8_t*>(
                                                  secret.get()),
                                              secret.Length());
               Wipe(secret);
               return Done(st);
             });
}

NS_IMETHODIMP
PasswordVault::GetSecret(const nsACString& aEntryId, const nsACString& aOrigin,
                         JSContext* aCx, Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::GetSecret",
             [id = nsCString(aEntryId), origin = nsCString(aOrigin)](Core& core) {
               uint8_t raw[BWV_ENTRY_ID_BYTES];
               bwv_vault* vault = core.Vault();
               if (!vault) {
                 return Done(BWV_E_LOCKED);
               }
               if (!DecodeId(id, raw)) {
                 return Done(BWV_E_ARG);
               }
               uint8_t* data = nullptr;
               size_t len = 0;
               bwv_status st = bwv_get_secret(vault, raw, origin.get(),
                                              origin.Length(), &data, &len);
               if (st != BWV_OK) {
                 return Done(st);
               }
               nsCString secret(reinterpret_cast<const char*>(data), len);
               bwv_secret_free(data);
               return Text(std::move(secret), true);
             });
}

NS_IMETHODIMP
PasswordVault::MoveSecret(const nsACString& aEntryId, const nsACString& aFrom,
                          const nsACString& aTo, JSContext* aCx,
                          Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::MoveSecret",
             [id = nsCString(aEntryId), from = nsCString(aFrom),
              to = nsCString(aTo)](Core& core) {
               uint8_t raw[BWV_ENTRY_ID_BYTES];
               bwv_vault* vault = core.Vault();
               if (!vault) {
                 return Done(BWV_E_LOCKED);
               }
               if (!DecodeId(id, raw)) {
                 return Done(BWV_E_ARG);
               }
               uint8_t* data = nullptr;
               size_t len = 0;
               bwv_status st = bwv_get_secret(vault, raw, from.get(),
                                              from.Length(), &data, &len);
               if (st == BWV_OK) {
                 st = bwv_set_secret(vault, raw, to.get(), to.Length(), data,
                                     len);
               }
               bwv_secret_free(data);
               return Done(st);
             });
}

NS_IMETHODIMP
PasswordVault::RemoveSecret(const nsACString& aEntryId, JSContext* aCx,
                            Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::RemoveSecret",
             [id = nsCString(aEntryId)](Core& core) {
               uint8_t raw[BWV_ENTRY_ID_BYTES];
               bwv_vault* vault = core.Vault();
               if (!vault) {
                 return Done(BWV_E_LOCKED);
               }
               if (!DecodeId(id, raw)) {
                 return Done(BWV_E_ARG);
               }
               return Done(bwv_remove_secret(vault, raw));
             });
}

NS_IMETHODIMP
PasswordVault::SealCapture(const nsACString& aSecret, JSContext* aCx,
                           Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::SealCapture",
             [secret = Own(aSecret)](Core& core) mutable {
               bwv_status st = core.Init();
               if (st == BWV_OK && !core.mCaptureKey) {
                 core.mCaptureKey = bwv_key_new();
                 if (core.mCaptureKey) {
                   bwv_key_generate(core.mCaptureKey);
                 } else {
                   st = BWV_E_NOMEM;
                 }
               }
               nsAutoCString id;
               id.AppendPrintf("c%" PRIu64, core.mNextCapture++);
               auto box = MakeUnique<Box>();
               if (st == BWV_OK) {
                 st = bwv_box_seal(core.mCaptureKey,
                                   reinterpret_cast<const uint8_t*>(id.get()),
                                   id.Length(),
                                   reinterpret_cast<const uint8_t*>(secret.get()),
                                   secret.Length(), &box->mData, &box->mLen);
               }
               Wipe(secret);
               if (st != BWV_OK) {
                 return Done(st);
               }
               core.mCaptures.InsertOrUpdate(id, std::move(box));
               return Text(nsCString(id), false);
             });
}

NS_IMETHODIMP
PasswordVault::OpenCapture(const nsACString& aCaptureId, JSContext* aCx,
                           Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::OpenCapture",
             [id = nsCString(aCaptureId)](Core& core) {
               uint8_t* data = nullptr;
               size_t len = 0;
               bwv_status st = core.OpenCapture(id, &data, &len);
               if (st != BWV_OK) {
                 return Done(st);
               }
               nsCString secret(reinterpret_cast<const char*>(data), len);
               bwv_secret_free(data);
               return Text(std::move(secret), true);
             });
}

NS_IMETHODIMP
PasswordVault::StoreCapture(const nsACString& aCaptureId,
                            const nsACString& aEntryId,
                            const nsACString& aOrigin, JSContext* aCx,
                            Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::StoreCapture",
             [captureId = nsCString(aCaptureId), id = nsCString(aEntryId),
              origin = nsCString(aOrigin)](Core& core) {
               uint8_t raw[BWV_ENTRY_ID_BYTES];
               bwv_vault* vault = core.Vault();
               if (!vault) {
                 return Done(BWV_E_LOCKED);
               }
               if (!DecodeId(id, raw)) {
                 return Done(BWV_E_ARG);
               }
               uint8_t* data = nullptr;
               size_t len = 0;
               bwv_status st = core.OpenCapture(captureId, &data, &len);
               if (st == BWV_OK) {
                 st = bwv_set_secret(vault, raw, origin.get(), origin.Length(),
                                     data, len);
               }
               bwv_secret_free(data);
               if (st == BWV_OK) {
                 core.mCaptures.Remove(captureId);
               }
               return Done(st);
             });
}

NS_IMETHODIMP
PasswordVault::DropCapture(const nsACString& aCaptureId, JSContext* aCx,
                           Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::DropCapture",
             [captureId = nsCString(aCaptureId)](Core& core) {
               core.mCaptures.Remove(captureId);
               return Done(BWV_OK);
             });
}

NS_IMETHODIMP
PasswordVault::ChangePassword(const nsACString& aCurrent,
                              const nsACString& aFresh, JSContext* aCx,
                              Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::ChangePassword",
             [current = Own(aCurrent), fresh = Own(aFresh)](Core& core) mutable {
               bwv_status st = core.mSession ? bwt_change_password(
                                                   core.mSession, current.get(),
                                                   current.Length(), fresh.get(),
                                                   fresh.Length())
                                             : BWV_E_STATE;
               Wipe(current);
               Wipe(fresh);
               return Done(st);
             });
}

NS_IMETHODIMP
PasswordVault::ExportVault(const nsACString& aPassphrase,
                           const nsACString& aIndex,
                           const nsTArray<nsCString>& aIds,
                           const nsTArray<nsCString>& aOrigins, JSContext* aCx,
                           Promise** aPromise) {
  NS_ENSURE_ARG(aIds.Length() == aOrigins.Length());
  return Run(
      aCx, aPromise, "PasswordVault::ExportVault",
      [pw = Own(aPassphrase), index = Own(aIndex),
       ids = CopyableTArray<nsCString>(aIds.Clone()),
       origins = CopyableTArray<nsCString>(aOrigins.Clone())](Core& core) mutable {
        bwv_vault* source = core.Vault();
        if (!source) {
          Wipe(pw);
          Wipe(index);
          return Done(BWV_E_LOCKED);
        }
        // A copy with its own vault key, under the passphrase only.
        bwv_vault* copy = nullptr;
        bwv_status st = NewVault(pw, &copy);
        Wipe(pw);
        if (st == BWV_OK) {
          st = bwv_set_index(copy, reinterpret_cast<const uint8_t*>(index.get()),
                             index.Length());
        }
        Wipe(index);
        for (size_t i = 0; st == BWV_OK && i < ids.Length(); i++) {
          st = CopySecret(source, ids[i], origins[i], copy, ids[i], origins[i]);
        }
        uint8_t* file = nullptr;
        size_t len = 0;
        if (st == BWV_OK) {
          st = bwv_serialize(copy, &file, &len);
        }
        bwv_free(copy);
        if (st != BWV_OK) {
          return Done(st);
        }
        nsCString encoded;
        nsresult rv = Base64URLEncode(len, file, Base64URLEncodePaddingPolicy::Omit,
                                      encoded);
        bwv_bytes_free(file);
        return NS_SUCCEEDED(rv) ? Text(std::move(encoded), false)
                                : Done(BWV_E_NOMEM);
      });
}

NS_IMETHODIMP
PasswordVault::OpenImport(const nsACString& aFile, const nsACString& aPassphrase,
                          JSContext* aCx, Promise** aPromise) {
  return Run(
      aCx, aPromise, "PasswordVault::OpenImport",
      [file = nsCString(aFile), pw = Own(aPassphrase)](Core& core) mutable {
        bwv_status st = core.Init();
        FallibleTArray<uint8_t> bytes;
        if (st == BWV_OK &&
            (NS_FAILED(Base64URLDecode(file, Base64URLDecodePaddingPolicy::Ignore,
                                       bytes)) ||
             bytes.Length() > kMaxImportBytes)) {
          st = BWV_E_FORMAT;
        }
        bwv_vault* vault = nullptr;
        if (st == BWV_OK) {
          vault = bwv_new();
          st = vault ? bwv_load(vault, bytes.Elements(), bytes.Length())
                     : BWV_E_NOMEM;
        }
        bwv_key* key = nullptr;
        if (st == BWV_OK) {
          st = PasswordKey(vault, pw, &key);
        }
        Wipe(pw);
        if (st == BWV_OK) {
          st = bwv_unlock(vault, BWV_SLOT_PASSWORD, key);
        }
        bwv_key_free(key);
        if (st == BWV_OK) {
          st = bwv_open_body(vault);
        }
        nsCString index;
        if (st == BWV_OK) {
          uint8_t* data = nullptr;
          size_t len = 0;
          st = bwv_get_index(vault, &data, &len);
          if (st == BWV_OK) {
            index.Assign(reinterpret_cast<const char*>(data), len);
            bwv_secret_free(data);
          }
        }
        if (st != BWV_OK) {
          bwv_free(vault);
          return Done(st);
        }
        core.CloseImport();
        core.mImport = vault;
        return Text(std::move(index), true);
      });
}

NS_IMETHODIMP
PasswordVault::ImportSecrets(const nsTArray<nsCString>& aSrcIds,
                             const nsTArray<nsCString>& aSrcOrigins,
                             const nsTArray<nsCString>& aDstIds,
                             const nsTArray<nsCString>& aDstOrigins,
                             JSContext* aCx, Promise** aPromise) {
  NS_ENSURE_ARG(aSrcIds.Length() == aSrcOrigins.Length() &&
                aSrcIds.Length() == aDstIds.Length() &&
                aSrcIds.Length() == aDstOrigins.Length());
  return Run(aCx, aPromise, "PasswordVault::ImportSecrets",
             [srcIds = CopyableTArray<nsCString>(aSrcIds.Clone()),
              srcOrigins = CopyableTArray<nsCString>(aSrcOrigins.Clone()),
              dstIds = CopyableTArray<nsCString>(aDstIds.Clone()),
              dstOrigins = CopyableTArray<nsCString>(aDstOrigins.Clone())](Core& core) {
               bwv_vault* vault = core.Vault();
               if (!vault) {
                 return Done(BWV_E_LOCKED);
               }
               if (!core.mImport) {
                 return Done(BWV_E_STATE);
               }
               bwv_status st = BWV_OK;
               for (size_t i = 0; st == BWV_OK && i < srcIds.Length(); i++) {
                 st = CopySecret(core.mImport, srcIds[i], srcOrigins[i], vault,
                                 dstIds[i], dstOrigins[i]);
               }
               return Done(st);
             });
}

NS_IMETHODIMP
PasswordVault::CloseImport(JSContext* aCx, Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::CloseImport", [](Core& core) {
    core.CloseImport();
    return Done(BWV_OK);
  });
}

NS_IMETHODIMP
PasswordVault::HelloAvailable(JSContext* aCx, Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::HelloAvailable", [](Core& core) {
    return Flag(windows_unlock::HelloAvailable());
  });
}

NS_IMETHODIMP
PasswordVault::Slots(JSContext* aCx, Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::Slots", [](Core& core) {
    bool hello = false;
    bool recovery = false;
    bwv_vault* vault = nullptr;
    if (core.mStore && LoadFile(core.mStore, &vault) == BWV_OK) {
      hello = bwv_has_slot(vault, BWV_SLOT_HELLO);
      recovery = bwv_has_slot(vault, BWV_SLOT_RECOVERY);
    }
    bwv_free(vault);
    return Text(nsCString(nsPrintfCString(R"({"hello":%s,"recovery":%s})",
                                          hello ? "true" : "false",
                                          recovery ? "true" : "false")),
                false);
  });
}

NS_IMETHODIMP
PasswordVault::EnableHello(const nsACString& aMasterPassword, JSContext* aCx,
                           Promise** aPromise) {
  return Run(
      aCx, aPromise, "PasswordVault::EnableHello",
      [pw = Own(aMasterPassword)](Core& core) mutable {
        bwv_vault* vault = core.Vault();
        if (!vault) {
          Wipe(pw);
          return Done(BWV_E_LOCKED);
        }
        // Adding an unlock method needs the master password (§5.1).
        bwv_status st = CheckMaster(core.mStore, pw);
        Wipe(pw);
        if (st != BWV_OK) {
          return Done(st);
        }
        if (!windows_unlock::HelloAvailable()) {
          return Done(BWV_E_PROVIDER);
        }
        uint8_t id[BWV_ID_BYTES];
        bwv_get_id(vault, id);
        bool hadSlot = bwv_has_slot(vault, BWV_SLOT_HELLO);
        st = windows_unlock::HelloEnroll(id);
        if (st == BWV_OK) {
          st = bwv_prepare_slot(vault, BWV_SLOT_HELLO, nullptr);
        }
        bwv_kdf_params params;
        uint8_t challenge[kSlotInputsMax];
        size_t challengeLen = 0;
        if (st == BWV_OK) {
          st = bwv_prepared_inputs(vault, BWV_SLOT_HELLO, &params, challenge,
                                   &challengeLen);
        }
        if (st == BWV_OK && challengeLen != BWV_CHALLENGE_BYTES) {
          st = BWV_E_FORMAT;
        }
        bwv_key* key = nullptr;
        if (st == BWV_OK) {
          st = HelloKey(vault, challenge, &key);
        }
        if (st == BWV_OK) {
          st = bwv_set_slot(vault, BWV_SLOT_HELLO, key);
        }
        bwv_key_free(key);
        if (st == BWV_OK) {
          st = bwt_save(core.mSession);
        }
        if (st != BWV_OK && hadSlot) {
          // A new key replaced the one the old slot was made with: that slot
          // can't open any more.
          bwv_remove_slot(vault, BWV_SLOT_HELLO);
          bwt_save(core.mSession);
        }
        return Done(st);
      });
}

NS_IMETHODIMP
PasswordVault::DisableHello(JSContext* aCx, Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::DisableHello", [](Core& core) {
    bwv_vault* vault = core.Vault();
    if (!vault) {
      return Done(BWV_E_LOCKED);
    }
    uint8_t id[BWV_ID_BYTES];
    bwv_get_id(vault, id);
    bwv_status st = BWV_OK;
    if (bwv_has_slot(vault, BWV_SLOT_HELLO)) {
      st = bwv_remove_slot(vault, BWV_SLOT_HELLO);
      if (st == BWV_OK) {
        st = bwt_save(core.mSession);
      }
    }
    if (st == BWV_OK) {
      windows_unlock::HelloDelete(id);
    }
    return Done(st);
  });
}

NS_IMETHODIMP
PasswordVault::UnlockWithHello(JSContext* aCx, Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::UnlockWithHello", [](Core& core) {
    bwv_status st = core.mSession ? BWV_OK : BWV_E_STATE;
    bwv_vault* vault = nullptr;
    if (st == BWV_OK) {
      st = LoadFile(core.mStore, &vault);
    }
    if (st == BWV_OK && !bwv_has_slot(vault, BWV_SLOT_HELLO)) {
      st = BWV_E_NO_SLOT;
    }
    bwv_kdf_params params;
    uint8_t challenge[kSlotInputsMax];
    size_t challengeLen = 0;
    if (st == BWV_OK) {
      st = bwv_slot_inputs(vault, BWV_SLOT_HELLO, &params, challenge, &challengeLen);
    }
    if (st == BWV_OK && challengeLen != BWV_CHALLENGE_BYTES) {
      st = BWV_E_FORMAT;
    }
    bwv_key* key = nullptr;
    if (st == BWV_OK) {
      st = HelloKey(vault, challenge, &key);
    }
    if (st == BWV_OK) {
      st = bwv_unlock(vault, BWV_SLOT_HELLO, key);
    }
    bwv_key_free(key);
    if (st == BWV_OK) {
      st = bwv_open_body(vault);
    }
    nsCString index;
    if (st == BWV_OK) {
      uint8_t* data = nullptr;
      size_t len = 0;
      st = bwv_get_index(vault, &data, &len);
      if (st == BWV_OK) {
        index.Assign(reinterpret_cast<const char*>(data), len);
        bwv_secret_free(data);
      }
    }
    if (st != BWV_OK) {
      bwv_free(vault);
      return Done(st);
    }
    bwt_attach(core.mSession, vault);
    return Text(std::move(index), true);
  });
}

NS_IMETHODIMP
PasswordVault::NewRecoveryKey(const nsACString& aMasterPassword, JSContext* aCx,
                              Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::NewRecoveryKey",
             [pw = Own(aMasterPassword)](Core& core) mutable {
               if (!core.Vault()) {
                 Wipe(pw);
                 return Done(BWV_E_LOCKED);
               }
               char code[BWV_RECOVERY_CHARS + 1];
               bwv_status st =
                   bwt_new_recovery_key(core.mSession, pw.get(), pw.Length(), code);
               Wipe(pw);
               nsCString out;
               if (st == BWV_OK) {
                 out.Assign(code);
               }
               Wipe(code, sizeof(code));
               return st == BWV_OK ? Text(std::move(out), true) : Done(st);
             });
}

NS_IMETHODIMP
PasswordVault::UnlockWithRecovery(const nsACString& aCode,
                                  const nsACString& aNewPassword, JSContext* aCx,
                                  Promise** aPromise) {
  return Run(
      aCx, aPromise, "PasswordVault::UnlockWithRecovery",
      [code = Own(aCode), fresh = Own(aNewPassword)](Core& core) mutable {
        bwv_status st = core.mSession ? BWV_OK : BWV_E_STATE;
        bwv_vault* vault = nullptr;
        if (st == BWV_OK) {
          st = LoadFile(core.mStore, &vault);
        }
        if (st == BWV_OK && !bwv_has_slot(vault, BWV_SLOT_RECOVERY)) {
          st = BWV_E_NO_SLOT;
        }
        bwv_kdf_params params;
        uint8_t salt[kSlotInputsMax];
        size_t saltLen = 0;
        if (st == BWV_OK) {
          st = bwv_slot_inputs(vault, BWV_SLOT_RECOVERY, &params, salt, &saltLen);
        }
        bwv_key* key = nullptr;
        if (st == BWV_OK) {
          key = bwv_key_new();
          st = key ? bwv_derive_recovery_key(&params, salt, code.get(),
                                             code.Length(), key)
                   : BWV_E_NOMEM;
        }
        if (st == BWV_OK) {
          st = bwv_unlock(vault, BWV_SLOT_RECOVERY, key);
        }
        bwv_key_free(key);
        if (st == BWV_OK) {
          st = bwv_open_body(vault);
        }
        nsCString index;
        if (st == BWV_OK) {
          uint8_t* data = nullptr;
          size_t len = 0;
          st = bwv_get_index(vault, &data, &len);
          if (st == BWV_OK) {
            index.Assign(reinterpret_cast<const char*>(data), len);
            bwv_secret_free(data);
          }
        }
        if (st != BWV_OK) {
          Wipe(code);
          Wipe(fresh);
          bwv_free(vault);
          return Done(st);
        }
        // The recovery key is a full replacement for the master password,
        // so it sets a new one at once (§6); until that's written, nothing
        // stays unlocked.
        bwt_attach(core.mSession, vault);
        st = bwt_reset_password(core.mSession, code.get(), code.Length(),
                                fresh.get(), fresh.Length());
        Wipe(code);
        Wipe(fresh);
        if (st != BWV_OK) {
          core.Lock();
          Wipe(index);
          return Done(st);
        }
        return Text(std::move(index), true);
      });
}

NS_IMETHODIMP
PasswordVault::StartOver(const nsACString& aDate, JSContext* aCx,
                         Promise** aPromise) {
  return Run(aCx, aPromise, "PasswordVault::StartOver",
             [date = nsCString(aDate)](Core& core) {
               if (!core.mSession) {
                 return Done(BWV_E_STATE);
               }
               // YYYY-MM-DD, so the name stays a plain file name.
               bool valid = date.Length() == 10;
               for (size_t i = 0; valid && i < date.Length(); i++) {
                 char c = date[i];
                 valid = (i == 4 || i == 7) ? c == '-' : c >= '0' && c <= '9';
               }
               if (!valid) {
                 return Done(BWV_E_ARG);
               }
               if (!bws_exists(core.mStore, BWS_VAULT)) {
                 return Done(BWV_E_NOT_FOUND);
               }
               core.Lock();
               bwv_vault* old = nullptr;
               uint8_t id[BWV_ID_BYTES];
               bool haveId = LoadFile(core.mStore, &old) == BWV_OK;
               if (haveId) {
                 bwv_get_id(old, id);
               }
               bwv_free(old);
               nsCString name;
               for (int n = 1; n < 100; n++) {
                 name = n == 1 ? nsPrintfCString("vault-forgotten-%s", date.get())
                               : nsPrintfCString("vault-forgotten-%s-%d", date.get(), n);
                 if (!bws_exists(core.mStore, nsCString(name + ".bwv"_ns).get()) &&
                     !bws_exists(core.mStore, nsCString(name + "-backup.bwv"_ns).get())) {
                   break;
                 }
                 name.Truncate();
               }
               if (name.IsEmpty()) {
                 return Done(BWV_E_IO);
               }
               bwv_status st =
                   bws_rename(core.mStore, BWS_VAULT, nsCString(name + ".bwv"_ns).get());
               if (st != BWV_OK) {
                 return Done(st);
               }
               // The backup is the same vault one save earlier: kept too, so
               // nothing restores it over the new vault.
               if (bws_exists(core.mStore, BWS_BACKUP)) {
                 bws_rename(core.mStore, BWS_BACKUP, nsCString(name + "-backup.bwv"_ns).get());
               }
               bws_remove(core.mStore, BWS_STAGED);
               if (haveId) {
                 // Hello can't open it any more anyway: only its master
                 // password can (Settings › Open an older vault…).
                 windows_unlock::HelloDelete(id);
               }
               return Text(nsCString(name + ".bwv"_ns), false);
             });
}

}  // namespace mozilla::browserwip
