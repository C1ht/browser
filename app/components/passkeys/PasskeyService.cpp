/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "PasskeyService.h"

#include "mozilla/Base64.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/JSONStringWriteFuncs.h"
#include "mozilla/JSONWriter.h"
#include "mozilla/Maybe.h"
#include "mozilla/StaticPtr.h"
#include "nsComponentManagerUtils.h"
#include "nsIComponentRegistrar.h"
#include "nsIFactory.h"
#include "nsIWebAuthnArgs.h"
#include "nsIWebAuthnPromise.h"
#include "nsIWebAuthnResult.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsXPCOM.h"
#include "nsXULAppAPI.h"
#include "nsThreadUtils.h"

namespace mozilla::browserwip {

namespace {

// Gecko's WebAuthn service (dom/webauthn/components.conf).
constexpr nsCID kGeckoWebAuthnServiceCID = {
    0xebe8a51d,
    0xbd54,
    0x4838,
    {0xb0, 0x31, 0xcd, 0x22, 0x89, 0x99, 0x0e, 0x14}};
// The class id "@mozilla.org/webauthn/service;1" is registered under for
// this service.
constexpr nsCID kStandInCID = {
    0x7b2fb4bf,
    0x7adb,
    0x47c8,
    {0x91, 0x60, 0xe6, 0x21, 0x7d, 0xb5, 0x2b, 0x5b}};
constexpr const char* kWebAuthnContractID = "@mozilla.org/webauthn/service;1";

StaticRefPtr<PasskeyService> sSingleton;

nsCString Base64URL(const nsTArray<uint8_t>& aBytes) {
  nsCString out;
  if (NS_FAILED(Base64URLEncode(aBytes.Length(), aBytes.Elements(),
                                Base64URLEncodePaddingPolicy::Omit, out))) {
    out.Truncate();
  }
  return out;
}

// Hands this service out for "@mozilla.org/webauthn/service;1".
class StandInFactory final : public nsIFactory {
 public:
  NS_DECL_ISUPPORTS

  NS_IMETHOD CreateInstance(const nsIID& aIID, void** aResult) override {
    if (!sSingleton) {
      return NS_ERROR_NOT_AVAILABLE;
    }
    return sSingleton->QueryInterface(aIID, aResult);
  }

 private:
  ~StandInFactory() = default;
};

NS_IMPL_ISUPPORTS(StandInFactory, nsIFactory)

// What a passkey the browser keeps makes: no attestation ("none"), so
// nothing identifies the authenticator, and no extensions but credProps.
class RegisterResult final : public nsIWebAuthnRegisterResult {
 public:
  NS_DECL_ISUPPORTS

  RegisterResult(nsTArray<uint8_t>&& aCredentialId,
                 nsTArray<uint8_t>&& aAttestationObject, bool aCredProps)
      : mCredentialId(std::move(aCredentialId)),
        mAttestationObject(std::move(aAttestationObject)) {
    if (aCredProps) {
      // Always a discoverable credential (a resident key).
      mCredPropsRk = Some(true);
    }
  }

  // Gecko adds the client data it made.
  NS_IMETHOD GetClientDataJSON(nsACString&) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetAttestationObject(nsTArray<uint8_t>& aOut) override {
    aOut.Assign(mAttestationObject);
    return NS_OK;
  }
  NS_IMETHOD GetAttestationConsentPromptShown(bool* aOut) override {
    *aOut = false;
    return NS_OK;
  }
  NS_IMETHOD GetCredentialId(nsTArray<uint8_t>& aOut) override {
    aOut.Assign(mCredentialId);
    return NS_OK;
  }
  NS_IMETHOD GetTransports(nsTArray<nsString>& aOut) override {
    aOut.Clear();
    aOut.AppendElement(u"internal"_ns);
    return NS_OK;
  }
  NS_IMETHOD GetHmacCreateSecret(bool*) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetCredPropsRk(bool* aOut) override {
    if (mCredPropsRk.isNothing()) {
      return NS_ERROR_NOT_AVAILABLE;
    }
    *aOut = *mCredPropsRk;
    return NS_OK;
  }
  NS_IMETHOD SetCredPropsRk(bool aValue) override {
    mCredPropsRk = Some(aValue);
    return NS_OK;
  }
  NS_IMETHOD GetLargeBlobSupported(bool*) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetPrfEnabled(bool*) override { return NS_ERROR_NOT_AVAILABLE; }
  NS_IMETHOD GetPrfResultsFirst(nsTArray<uint8_t>&) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetPrfResultsSecond(nsTArray<uint8_t>&) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetAuthenticatorAttachment(nsAString& aOut) override {
    aOut.AssignLiteral(u"platform");
    return NS_OK;
  }
  NS_IMETHOD HasIdentifyingAttestation(bool* aOut) override {
    *aOut = false;
    return NS_OK;
  }
  // "none" has nothing to take out.
  NS_IMETHOD Anonymize() override { return NS_OK; }

 private:
  ~RegisterResult() = default;

  nsTArray<uint8_t> mCredentialId;
  nsTArray<uint8_t> mAttestationObject;
  Maybe<bool> mCredPropsRk;
};

NS_IMPL_ISUPPORTS(RegisterResult, nsIWebAuthnRegisterResult)

class SignResult final : public nsIWebAuthnSignResult {
 public:
  NS_DECL_ISUPPORTS

  SignResult(nsTArray<uint8_t>&& aCredentialId,
             nsTArray<uint8_t>&& aAuthenticatorData,
             nsTArray<uint8_t>&& aSignature, nsTArray<uint8_t>&& aUserHandle)
      : mCredentialId(std::move(aCredentialId)),
        mAuthenticatorData(std::move(aAuthenticatorData)),
        mSignature(std::move(aSignature)),
        mUserHandle(std::move(aUserHandle)) {}

  NS_IMETHOD GetClientDataJSON(nsACString&) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetCredentialId(nsTArray<uint8_t>& aOut) override {
    aOut.Assign(mCredentialId);
    return NS_OK;
  }
  NS_IMETHOD GetAuthenticatorData(nsTArray<uint8_t>& aOut) override {
    aOut.Assign(mAuthenticatorData);
    return NS_OK;
  }
  NS_IMETHOD GetSignature(nsTArray<uint8_t>& aOut) override {
    aOut.Assign(mSignature);
    return NS_OK;
  }
  NS_IMETHOD GetUserHandle(nsTArray<uint8_t>& aOut) override {
    aOut.Assign(mUserHandle);
    return NS_OK;
  }
  NS_IMETHOD GetUserName(nsACString&) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetUsedAppId(bool*) override { return NS_ERROR_NOT_AVAILABLE; }
  NS_IMETHOD SetUsedAppId(bool) override { return NS_OK; }
  NS_IMETHOD GetLargeBlobValue(nsTArray<uint8_t>&) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetLargeBlobWritten(bool*) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetPrfMaybe(bool* aOut) override {
    *aOut = false;
    return NS_OK;
  }
  NS_IMETHOD GetPrfResultsFirst(nsTArray<uint8_t>&) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetPrfResultsSecond(nsTArray<uint8_t>&) override {
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD GetAuthenticatorAttachment(nsAString& aOut) override {
    aOut.AssignLiteral(u"platform");
    return NS_OK;
  }

 private:
  ~SignResult() = default;

  nsTArray<uint8_t> mCredentialId;
  nsTArray<uint8_t> mAuthenticatorData;
  nsTArray<uint8_t> mSignature;
  nsTArray<uint8_t> mUserHandle;
};

NS_IMPL_ISUPPORTS(SignResult, nsIWebAuthnSignResult)

}  // namespace

// One page's request, until it's answered, passed on or cancelled.
class PasskeyRequest final : public nsIBrowserWipPasskeyRequest {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIBROWSERWIPPASSKEYREQUEST

  PasskeyRequest(PasskeyService* aService, uint64_t aTransactionId,
                 uint64_t aBrowsingContextId, nsIWebAuthnRegisterArgs* aArgs,
                 nsIWebAuthnRegisterPromise* aPromise)
      : mService(aService),
        mTransactionId(aTransactionId),
        mBrowsingContextId(aBrowsingContextId),
        mRegisterArgs(aArgs),
        mRegisterPromise(aPromise) {
    mJSON = DescribeRegister(aArgs);
  }

  PasskeyRequest(PasskeyService* aService, uint64_t aTransactionId,
                 uint64_t aBrowsingContextId, nsIWebAuthnSignArgs* aArgs,
                 nsIWebAuthnSignPromise* aPromise)
      : mService(aService),
        mTransactionId(aTransactionId),
        mBrowsingContextId(aBrowsingContextId),
        mSignArgs(aArgs),
        mSignPromise(aPromise) {
    mJSON = DescribeSign(aArgs);
    (void)aArgs->GetConditionallyMediated(&mConditional);
  }

  uint64_t Id() const { return mTransactionId; }
  bool Conditional() const { return mConditional; }
  bool IsSettled() const { return mSettled; }

  // Ends it with NotAllowedError (the page went away, a newer request).
  void Abandon() { Settle(NS_ERROR_DOM_NOT_ALLOWED_ERR); }

  nsresult PassOnTo(nsIWebAuthnService* aInner) {
    mSettled = true;
    if (mRegisterArgs) {
      return aInner->MakeCredential(mTransactionId, mBrowsingContextId,
                                    mRegisterArgs, mRegisterPromise);
    }
    return aInner->GetAssertion(mTransactionId, mBrowsingContextId, mSignArgs,
                                mSignPromise);
  }

 private:
  ~PasskeyRequest() = default;

  // Rejects the page's promise, once.
  void Settle(nsresult aError) {
    if (mSettled) {
      return;
    }
    mSettled = true;
    if (mRegisterPromise) {
      (void)mRegisterPromise->Reject(aError);
    } else if (mSignPromise) {
      (void)mSignPromise->Reject(aError);
    }
  }

  // The request, for the provider. create: origin, rpId, rpName, user
  // { id, name, displayName }, clientDataHash, algs, excludeList,
  // residentKey, userVerification, attachment, attestation, credProps,
  // privateBrowsing, hints.
  static nsCString DescribeRegister(nsIWebAuthnRegisterArgs* aArgs) {
    nsString origin, rpId, rpName, userName, displayName, residentKey,
        userVerification, attachment, attestation;
    nsTArray<uint8_t> userId, clientDataHash;
    nsTArray<int32_t> algs;
    nsTArray<nsTArray<uint8_t>> excludeList;
    nsTArray<nsString> hints;
    bool privateBrowsing = false, credProps = false;
    (void)aArgs->GetOrigin(origin);
    (void)aArgs->GetRpId(rpId);
    (void)aArgs->GetRpName(rpName);
    (void)aArgs->GetUserId(userId);
    (void)aArgs->GetUserName(userName);
    (void)aArgs->GetUserDisplayName(displayName);
    (void)aArgs->GetClientDataHash(clientDataHash);
    (void)aArgs->GetCoseAlgs(algs);
    (void)aArgs->GetExcludeList(excludeList);
    (void)aArgs->GetResidentKey(residentKey);
    (void)aArgs->GetUserVerification(userVerification);
    (void)aArgs->GetAuthenticatorAttachment(attachment);
    (void)aArgs->GetAttestationConveyancePreference(attestation);
    (void)aArgs->GetPrivateBrowsing(&privateBrowsing);
    (void)aArgs->GetHints(hints);
    if (NS_FAILED(aArgs->GetCredProps(&credProps))) {
      credProps = false;
    }

    JSONStringWriteFunc<nsCString> out;
    JSONWriter w(out, JSONWriter::SingleLineStyle);
    w.Start();
    w.StringProperty("origin", NS_ConvertUTF16toUTF8(origin));
    w.StringProperty("rpId", NS_ConvertUTF16toUTF8(rpId));
    w.StringProperty("rpName", NS_ConvertUTF16toUTF8(rpName));
    w.StartObjectProperty("user");
    w.StringProperty("id", Base64URL(userId));
    w.StringProperty("name", NS_ConvertUTF16toUTF8(userName));
    w.StringProperty("displayName", NS_ConvertUTF16toUTF8(displayName));
    w.EndObject();
    w.StringProperty("clientDataHash", Base64URL(clientDataHash));
    w.StartArrayProperty("algs");
    for (int32_t alg : algs) {
      w.IntElement(alg);
    }
    w.EndArray();
    w.StartArrayProperty("excludeList");
    for (const auto& id : excludeList) {
      w.StringElement(Base64URL(id));
    }
    w.EndArray();
    w.StringProperty("residentKey", NS_ConvertUTF16toUTF8(residentKey));
    w.StringProperty("userVerification",
                     NS_ConvertUTF16toUTF8(userVerification));
    w.StringProperty("attachment", NS_ConvertUTF16toUTF8(attachment));
    w.StringProperty("attestation", NS_ConvertUTF16toUTF8(attestation));
    w.BoolProperty("credProps", credProps);
    w.BoolProperty("privateBrowsing", privateBrowsing);
    w.StartArrayProperty("hints");
    for (const auto& hint : hints) {
      w.StringElement(NS_ConvertUTF16toUTF8(hint));
    }
    w.EndArray();
    w.End();
    return out.StringCRef();
  }

  // get: origin, rpId, clientDataHash, allowList, userVerification,
  // conditional, privateBrowsing, hints.
  static nsCString DescribeSign(nsIWebAuthnSignArgs* aArgs) {
    nsString origin, rpId, userVerification;
    nsTArray<uint8_t> clientDataHash;
    nsTArray<nsTArray<uint8_t>> allowList;
    nsTArray<nsString> hints;
    bool conditional = false, privateBrowsing = false;
    (void)aArgs->GetOrigin(origin);
    (void)aArgs->GetRpId(rpId);
    (void)aArgs->GetClientDataHash(clientDataHash);
    (void)aArgs->GetAllowList(allowList);
    (void)aArgs->GetUserVerification(userVerification);
    (void)aArgs->GetConditionallyMediated(&conditional);
    (void)aArgs->GetPrivateBrowsing(&privateBrowsing);
    (void)aArgs->GetHints(hints);

    JSONStringWriteFunc<nsCString> out;
    JSONWriter w(out, JSONWriter::SingleLineStyle);
    w.Start();
    w.StringProperty("origin", NS_ConvertUTF16toUTF8(origin));
    w.StringProperty("rpId", NS_ConvertUTF16toUTF8(rpId));
    w.StringProperty("clientDataHash", Base64URL(clientDataHash));
    w.StartArrayProperty("allowList");
    for (const auto& id : allowList) {
      w.StringElement(Base64URL(id));
    }
    w.EndArray();
    w.StringProperty("userVerification",
                     NS_ConvertUTF16toUTF8(userVerification));
    w.BoolProperty("conditional", conditional);
    w.BoolProperty("privateBrowsing", privateBrowsing);
    w.StartArrayProperty("hints");
    for (const auto& hint : hints) {
      w.StringElement(NS_ConvertUTF16toUTF8(hint));
    }
    w.EndArray();
    w.End();
    return out.StringCRef();
  }

  RefPtr<PasskeyService> mService;
  uint64_t mTransactionId;
  uint64_t mBrowsingContextId;
  nsCOMPtr<nsIWebAuthnRegisterArgs> mRegisterArgs;
  nsCOMPtr<nsIWebAuthnRegisterPromise> mRegisterPromise;
  nsCOMPtr<nsIWebAuthnSignArgs> mSignArgs;
  nsCOMPtr<nsIWebAuthnSignPromise> mSignPromise;
  nsCString mJSON;
  bool mConditional = false;
  bool mSettled = false;
};

NS_IMPL_ISUPPORTS(PasskeyRequest, nsIBrowserWipPasskeyRequest)

NS_IMETHODIMP
PasskeyRequest::GetTransactionId(uint64_t* aOut) {
  *aOut = mTransactionId;
  return NS_OK;
}

NS_IMETHODIMP
PasskeyRequest::GetBrowsingContextId(uint64_t* aOut) {
  *aOut = mBrowsingContextId;
  return NS_OK;
}

NS_IMETHODIMP
PasskeyRequest::GetKind(nsACString& aOut) {
  aOut.Assign(mRegisterArgs ? "create"_ns : "get"_ns);
  return NS_OK;
}

NS_IMETHODIMP
PasskeyRequest::GetJson(nsACString& aOut) {
  aOut.Assign(mJSON);
  return NS_OK;
}

NS_IMETHODIMP
PasskeyRequest::GetSettled(bool* aOut) {
  *aOut = mSettled;
  return NS_OK;
}

NS_IMETHODIMP
PasskeyRequest::UseSecurityKey() {
  MOZ_ASSERT(NS_IsMainThread());
  // A conditional request (passkey autofill) has no security key to turn to.
  if (mSettled || mConditional) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  RefPtr<PasskeyService> service = mService;
  return service->PassOn(this);
}

NS_IMETHODIMP
PasskeyRequest::ResolveCreate(const nsTArray<uint8_t>& aCredentialId,
                              const nsTArray<uint8_t>& aAttestationObject) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mSettled || !mRegisterPromise) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  bool credProps = false;
  if (NS_FAILED(mRegisterArgs->GetCredProps(&credProps))) {
    credProps = false;
  }
  mSettled = true;
  RefPtr<RegisterResult> result =
      new RegisterResult(aCredentialId.Clone(), aAttestationObject.Clone(),
                         credProps);
  (void)mRegisterPromise->Resolve(result);
  mService->Forget(this);
  return NS_OK;
}

NS_IMETHODIMP
PasskeyRequest::ResolveGet(const nsTArray<uint8_t>& aCredentialId,
                           const nsTArray<uint8_t>& aAuthenticatorData,
                           const nsTArray<uint8_t>& aSignature,
                           const nsTArray<uint8_t>& aUserHandle) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mSettled || !mSignPromise) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  mSettled = true;
  RefPtr<SignResult> result =
      new SignResult(aCredentialId.Clone(), aAuthenticatorData.Clone(),
                     aSignature.Clone(), aUserHandle.Clone());
  (void)mSignPromise->Resolve(result);
  mService->Forget(this);
  return NS_OK;
}

NS_IMETHODIMP
PasskeyRequest::Reject(const nsACString& aError) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mSettled) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsresult error = aError.EqualsLiteral("invalid-state")
                       ? NS_ERROR_DOM_INVALID_STATE_ERR
                   : aError.EqualsLiteral("not-supported")
                       ? NS_ERROR_DOM_NOT_SUPPORTED_ERR
                       : NS_ERROR_DOM_NOT_ALLOWED_ERR;
  Settle(error);
  mService->Forget(this);
  return NS_OK;
}

// ---------------------------------------------------------------------------
// PasskeyService

NS_IMPL_ISUPPORTS(PasskeyService, nsIWebAuthnService,
                  nsIBrowserWipPasskeyService)

/* static */
already_AddRefed<PasskeyService> PasskeyService::GetSingleton() {
  MOZ_ASSERT(NS_IsMainThread());
  if (!sSingleton) {
    if (!XRE_IsParentProcess()) {
      return nullptr;
    }
    sSingleton = new PasskeyService();
    // Requests and the service hold each other until each request ends;
    // whatever is still open ends before shutdown.
    RunOnShutdown(
        [] {
          if (sSingleton) {
            sSingleton->Shutdown();
          }
        },
        ShutdownPhase::XPCOMWillShutdown);
    ClearOnShutdown(&sSingleton);
  }
  return do_AddRef(sSingleton);
}

NS_IMETHODIMP
PasskeyService::Install(nsIBrowserWipPasskeyProvider* aProvider) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG(aProvider);
  if (mProvider) {
    return NS_ERROR_ALREADY_INITIALIZED;
  }
  nsresult rv;
  mInner = do_GetService(kGeckoWebAuthnServiceCID, &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsIComponentRegistrar> registrar;
  rv = NS_GetComponentRegistrar(getter_AddRefs(registrar));
  NS_ENSURE_SUCCESS(rv, rv);
  // A dynamically registered contract id overrides the static one: from
  // now on, "@mozilla.org/webauthn/service;1" is this service.
  RefPtr<StandInFactory> factory = new StandInFactory();
  rv = registrar->RegisterFactory(kStandInCID, "browser-wip passkeys",
                                  kWebAuthnContractID, factory);
  NS_ENSURE_SUCCESS(rv, rv);
  mProvider = aProvider;
  // Created now, on the main thread: Gecko asks for the service from a
  // background task too (isUVPAA), and gets it from the service cache.
  nsCOMPtr<nsIWebAuthnService> check = do_GetService(kWebAuthnContractID);
  MOZ_ASSERT(check == static_cast<nsIWebAuthnService*>(this));
  return NS_OK;
}

NS_IMETHODIMP
PasskeyService::GetInstalled(bool* aOut) {
  *aOut = !!mProvider;
  return NS_OK;
}

PasskeyRequest* PasskeyService::Find(uint64_t aTransactionId) {
  for (auto& request : mRequests) {
    if (request->Id() == aTransactionId) {
      return request;
    }
  }
  return nullptr;
}

void PasskeyService::Shutdown() {
  nsTArray<RefPtr<PasskeyRequest>> open = std::move(mRequests);
  for (auto& request : open) {
    request->Abandon();
  }
  mProvider = nullptr;
}

void PasskeyService::Forget(PasskeyRequest* aRequest) {
  mRequests.RemoveElement(aRequest);
}

nsresult PasskeyService::PassOn(PasskeyRequest* aRequest) {
  RefPtr<PasskeyRequest> request = aRequest;
  mRequests.RemoveElement(aRequest);
  return request->PassOnTo(mInner);
}

void PasskeyService::CancelModal() {
  nsTArray<RefPtr<PasskeyRequest>> ending;
  mRequests.RemoveElementsBy([&](RefPtr<PasskeyRequest>& aRequest) {
    if (aRequest->Conditional()) {
      return false;
    }
    ending.AppendElement(aRequest);
    return true;
  });
  for (auto& request : ending) {
    request->Abandon();
    if (mProvider) {
      (void)mProvider->Cancel(request->Id());
    }
  }
}

NS_IMETHODIMP
PasskeyService::MakeCredential(uint64_t aTransactionId,
                               uint64_t aBrowsingContextId,
                               nsIWebAuthnRegisterArgs* aArgs,
                               nsIWebAuthnRegisterPromise* aPromise) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!mProvider) {
    return mInner ? mInner->MakeCredential(aTransactionId, aBrowsingContextId,
                                           aArgs, aPromise)
                  : NS_ERROR_NOT_AVAILABLE;
  }
  // A new request ends the last, ours or a security key's.
  CancelModal();
  (void)mInner->Reset();
  RefPtr<PasskeyRequest> request = new PasskeyRequest(
      this, aTransactionId, aBrowsingContextId, aArgs, aPromise);
  mRequests.AppendElement(request);
  nsresult rv = mProvider->Handle(request);
  if (NS_FAILED(rv) && !request->IsSettled()) {
    // Without the provider, a security key, as Gecko alone would.
    return PassOn(request);
  }
  return NS_OK;
}

NS_IMETHODIMP
PasskeyService::GetAssertion(uint64_t aTransactionId,
                             uint64_t aBrowsingContextId,
                             nsIWebAuthnSignArgs* aArgs,
                             nsIWebAuthnSignPromise* aPromise) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!mProvider) {
    return mInner ? mInner->GetAssertion(aTransactionId, aBrowsingContextId,
                                         aArgs, aPromise)
                  : NS_ERROR_NOT_AVAILABLE;
  }
  bool conditional = false;
  (void)aArgs->GetConditionallyMediated(&conditional);
  if (conditional) {
    // Passkey autofill: waits beside other requests, until the user picks
    // a passkey in a login field's dropdown. One per frame, as in Gecko.
    nsTArray<RefPtr<PasskeyRequest>> replaced;
    for (auto& request : mRequests) {
      if (request->Conditional()) {
        replaced.AppendElement(request);
      }
    }
    for (auto& request : replaced) {
      // Only the same frame's (Gecko keys them by browsing context).
      uint64_t bc = 0;
      (void)request->GetBrowsingContextId(&bc);
      if (bc == aBrowsingContextId) {
        mRequests.RemoveElement(request);
        request->Abandon();
        (void)mProvider->Cancel(request->Id());
      }
    }
  } else {
    CancelModal();
    (void)mInner->Reset();
  }
  RefPtr<PasskeyRequest> request = new PasskeyRequest(
      this, aTransactionId, aBrowsingContextId, aArgs, aPromise);
  mRequests.AppendElement(request);
  nsresult rv = mProvider->Handle(request);
  if (NS_FAILED(rv) && !request->IsSettled()) {
    if (conditional) {
      mRequests.RemoveElement(request);
      request->Abandon();
      return NS_OK;
    }
    return PassOn(request);
  }
  return NS_OK;
}

NS_IMETHODIMP
PasskeyService::GetIsUVPAA(bool* aAvailable) {
  // The browser is a platform authenticator that verifies the user (the
  // master password unlocks it). Any thread.
  *aAvailable = true;
  return NS_OK;
}

NS_IMETHODIMP
PasskeyService::Cancel(uint64_t aTransactionId) {
  MOZ_ASSERT(NS_IsMainThread());
  if (RefPtr<PasskeyRequest> request = Find(aTransactionId)) {
    mRequests.RemoveElement(request);
    request->Abandon();
    if (mProvider) {
      (void)mProvider->Cancel(aTransactionId);
    }
    return NS_OK;
  }
  return mInner ? mInner->Cancel(aTransactionId) : NS_OK;
}

NS_IMETHODIMP
PasskeyService::Reset() {
  MOZ_ASSERT(NS_IsMainThread());
  CancelModal();
  return mInner ? mInner->Reset() : NS_OK;
}

// Everything else is Gecko's service's.

#define FORWARD(call)               \
  if (!mInner) {                    \
    return NS_ERROR_NOT_AVAILABLE;  \
  }                                 \
  return mInner->call;

NS_IMETHODIMP
PasskeyService::HasPendingConditionalGet(uint64_t aBrowsingContextId,
                                         const nsAString& aOrigin,
                                         uint64_t* aRv) {
  FORWARD(HasPendingConditionalGet(aBrowsingContextId, aOrigin, aRv))
}

NS_IMETHODIMP
PasskeyService::GetAutoFillEntries(
    uint64_t aTransactionId, nsIWebAuthnAutoFillEntriesCallback* aCallback) {
  FORWARD(GetAutoFillEntries(aTransactionId, aCallback))
}

NS_IMETHODIMP
PasskeyService::GetAutoFillEntriesForRpId(
    const nsAString& aRpId, const nsTArray<nsTArray<uint8_t>>& aAllowList,
    nsIWebAuthnAutoFillEntriesCallback* aCallback) {
  FORWARD(GetAutoFillEntriesForRpId(aRpId, aAllowList, aCallback))
}

NS_IMETHODIMP
PasskeyService::SelectAutoFillEntry(uint64_t aTransactionId,
                                    const nsTArray<uint8_t>& aCredentialId) {
  FORWARD(SelectAutoFillEntry(aTransactionId, aCredentialId))
}

NS_IMETHODIMP
PasskeyService::ResumeConditionalGet(uint64_t aTransactionId) {
  FORWARD(ResumeConditionalGet(aTransactionId))
}

NS_IMETHODIMP
PasskeyService::PinCallback(uint64_t aTransactionId, const nsACString& aPin) {
  FORWARD(PinCallback(aTransactionId, aPin))
}

NS_IMETHODIMP
PasskeyService::SetHasAttestationConsent(uint64_t aTransactionId,
                                         bool aHasConsent) {
  FORWARD(SetHasAttestationConsent(aTransactionId, aHasConsent))
}

NS_IMETHODIMP
PasskeyService::SelectionCallback(uint64_t aTransactionId, uint64_t aIndex) {
  FORWARD(SelectionCallback(aTransactionId, aIndex))
}

NS_IMETHODIMP
PasskeyService::AddVirtualAuthenticator(
    const nsACString& aProtocol, const nsACString& aTransport,
    bool aHasResidentKey, bool aHasUserVerification, bool aIsUserConsenting,
    bool aIsUserVerified, nsACString& aRetval) {
  FORWARD(AddVirtualAuthenticator(aProtocol, aTransport, aHasResidentKey,
                                  aHasUserVerification, aIsUserConsenting,
                                  aIsUserVerified, aRetval))
}

NS_IMETHODIMP
PasskeyService::HasVirtualAuthenticator(const nsACString& aAuthenticatorId,
                                        bool* aRetval) {
  FORWARD(HasVirtualAuthenticator(aAuthenticatorId, aRetval))
}

NS_IMETHODIMP
PasskeyService::RemoveVirtualAuthenticator(const nsACString& aAuthenticatorId) {
  FORWARD(RemoveVirtualAuthenticator(aAuthenticatorId))
}

NS_IMETHODIMP
PasskeyService::AddCredential(const nsACString& aAuthenticatorId,
                              const nsACString& aCredentialId,
                              bool aIsResidentCredential,
                              const nsACString& aRpId,
                              const nsACString& aPrivateKey,
                              const nsACString& aUserHandle,
                              uint32_t aSignCount) {
  FORWARD(AddCredential(aAuthenticatorId, aCredentialId, aIsResidentCredential,
                        aRpId, aPrivateKey, aUserHandle, aSignCount))
}

NS_IMETHODIMP
PasskeyService::GetCredentials(
    const nsACString& aAuthenticatorId,
    nsTArray<RefPtr<nsICredentialParameters>>& aRetval) {
  FORWARD(GetCredentials(aAuthenticatorId, aRetval))
}

NS_IMETHODIMP
PasskeyService::RemoveCredential(const nsACString& aAuthenticatorId,
                                 const nsACString& aCredentialId) {
  FORWARD(RemoveCredential(aAuthenticatorId, aCredentialId))
}

NS_IMETHODIMP
PasskeyService::RemoveAllCredentials(const nsACString& aAuthenticatorId) {
  FORWARD(RemoveAllCredentials(aAuthenticatorId))
}

NS_IMETHODIMP
PasskeyService::SetUserVerified(const nsACString& aAuthenticatorId,
                                bool aIsUserVerified) {
  FORWARD(SetUserVerified(aAuthenticatorId, aIsUserVerified))
}

NS_IMETHODIMP
PasskeyService::Listen() { FORWARD(Listen()) }

NS_IMETHODIMP
PasskeyService::RunCommand(const nsACString& aCommand) {
  FORWARD(RunCommand(aCommand))
}

#undef FORWARD

}  // namespace mozilla::browserwip
