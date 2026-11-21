/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef browserwip_PasskeyService_h
#define browserwip_PasskeyService_h

#include "mozilla/AlreadyAddRefed.h"
#include "nsCOMPtr.h"
#include "nsIBrowserWipPasskeys.h"
#include "nsIWebAuthnService.h"
#include "nsTArray.h"

namespace mozilla::browserwip {

class PasskeyRequest;

// Stands in front of Gecko's WebAuthn service (docs/PASSWORDS.md §20): each
// page's request to make or use a passkey goes to the provider
// (Passkeys.sys.mjs), which answers it with a passkey the browser keeps, or
// passes it to Gecko's service, for a security key. Everything else goes
// straight to Gecko's service.
//
// Main thread only, but for GetIsUVPAA, which Gecko asks from a background
// task.
class PasskeyService final : public nsIWebAuthnService,
                             public nsIBrowserWipPasskeyService {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIWEBAUTHNSERVICE
  NS_DECL_NSIBROWSERWIPPASSKEYSERVICE

  static already_AddRefed<PasskeyService> GetSingleton();

  // A request done with (answered, passed on, cancelled).
  void Forget(PasskeyRequest* aRequest);
  // Gecko's service takes a request over (a security key).
  nsresult PassOn(PasskeyRequest* aRequest);
  void Shutdown();

 private:
  PasskeyService() = default;
  ~PasskeyService() = default;

  // Ends the requests a new modal one replaces, as Gecko's service does.
  void CancelModal();
  PasskeyRequest* Find(uint64_t aTransactionId);

  // Gecko's own service, by its class id.
  nsCOMPtr<nsIWebAuthnService> mInner;
  nsCOMPtr<nsIBrowserWipPasskeyProvider> mProvider;
  nsTArray<RefPtr<PasskeyRequest>> mRequests;
};

}  // namespace mozilla::browserwip

#endif
