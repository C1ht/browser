/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef browserwip_PasswordVault_h
#define browserwip_PasswordVault_h

#include <functional>

#include "mozilla/AlreadyAddRefed.h"
#include "nsCOMPtr.h"
#include "nsIObserver.h"
#include "nsIPasswordVault.h"
#include "nsString.h"

class nsISerialEventTarget;
struct JSContext;

namespace mozilla::dom {
class Promise;
}

namespace mozilla::browserwip {

// nsIPasswordVault: the vault core (bwvault, bwvstore, bwvtxn) behind
// Promises. The core runs on one background task queue and nowhere else:
// it switches its keys' memory between no-access and read-write around each
// use, so two threads must never touch it at once. See
// docs/PASSWORDS.md §3.
class PasswordVault final : public nsIPasswordVault, public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPASSWORDVAULT
  NS_DECL_NSIOBSERVER

  static already_AddRefed<PasswordVault> GetSingleton();

  struct Core;

  // What a task hands back to the main thread.
  struct Outcome {
    int mStatus = 0;  // bwv_status
    enum class Kind { Undefined, String, Bool } mKind = Kind::Undefined;
    nsCString mString;
    bool mBool = false;
    // mString is a secret (a password or the index): wiped once resolved.
    bool mSecret = false;
  };

 private:
  PasswordVault() = default;
  ~PasswordVault();

  nsresult Init();
  nsresult Run(JSContext* aCx, dom::Promise** aPromise, const char* aName,
               std::function<Outcome(Core&)>&& aTask);
  void Shutdown();

  nsCOMPtr<nsISerialEventTarget> mQueue;
  // Owned here, used only on mQueue, deleted there at shutdown.
  Core* mCore = nullptr;
  bool mShutDown = false;
};

}  // namespace mozilla::browserwip

#endif  // browserwip_PasswordVault_h
