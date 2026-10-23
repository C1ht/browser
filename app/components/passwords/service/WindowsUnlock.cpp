/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WindowsUnlock.h"

#ifdef XP_WIN

#  include <windows.h>
#  include <asyncinfo.h>
#  include <bcrypt.h>
#  include <ncrypt.h>
#  include <roapi.h>
#  include <tbs.h>
#  include <winstring.h>
#  include <wrl.h>
#  include <wrl/wrappers/corewrappers.h>
#  include <windows.security.credentials.h>
#  include <windows.security.cryptography.h>
#  include <wtsapi32.h>

#  include "mozilla/Assertions.h"
#  include "nsThreadUtils.h"

using namespace Microsoft::WRL;
using namespace Microsoft::WRL::Wrappers;
using namespace ABI::Windows::Foundation;
using namespace ABI::Windows::Security::Credentials;
using namespace ABI::Windows::Security::Cryptography;
using namespace ABI::Windows::Storage::Streams;

namespace mozilla::browserwip::windows_unlock {

namespace {

// How long a Hello prompt may stay open.
constexpr DWORD kPromptTimeoutMs = 5 * 60 * 1000;
constexpr DWORD kPollMs = 50;

// WinRT on the calling thread for as long as this lives. The vault's task
// queue runs on a pool thread, so each call sets it up and tears it down.
class WinRTScope {
 public:
  WinRTScope() {
    HRESULT hr = ::RoInitialize(RO_INIT_MULTITHREADED);
    mOwned = SUCCEEDED(hr);
    mUsable = mOwned || hr == RPC_E_CHANGED_MODE;
  }
  ~WinRTScope() {
    if (mOwned) {
      ::RoUninitialize();
    }
  }
  bool Usable() const { return mUsable; }

 private:
  bool mOwned = false;
  bool mUsable = false;
};

// The Hello prompt of an unpackaged app can open behind the browser window
// (KeePassXC works around it the same way): bring it forward once it shows.
void RaisePrompt(bool& aRaised) {
  if (aRaised) {
    return;
  }
  HWND prompt = ::FindWindowW(L"Credential Dialog Xaml Host", nullptr);
  if (prompt) {
    ::SetForegroundWindow(prompt);
    aRaised = true;
  }
}

// Waits for an async WinRT operation by polling its status (the thread has
// nothing else to do), keeping the Hello prompt in front meanwhile.
template <typename TOperation>
HRESULT Wait(TOperation* aOperation, bool aPrompts) {
  ComPtr<IAsyncInfo> info;
  HRESULT hr = aOperation->QueryInterface(IID_PPV_ARGS(&info));
  if (FAILED(hr)) {
    return hr;
  }
  bool raised = false;
  AsyncStatus status = AsyncStatus::Started;
  for (DWORD waited = 0;; waited += kPollMs) {
    hr = info->get_Status(&status);
    if (FAILED(hr)) {
      return hr;
    }
    if (status != AsyncStatus::Started) {
      break;
    }
    if (waited >= kPromptTimeoutMs) {
      info->Cancel();
      return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    if (aPrompts) {
      RaisePrompt(raised);
    }
    ::Sleep(kPollMs);
  }
  if (status == AsyncStatus::Completed) {
    return S_OK;
  }
  HRESULT error = E_FAIL;
  info->get_ErrorCode(&error);
  return FAILED(error) ? error : E_FAIL;
}

HRESULT Statics(ComPtr<IKeyCredentialManagerStatics>& aOut) {
  return ::RoGetActivationFactory(
      HStringReference(RuntimeClass_Windows_Security_Credentials_KeyCredentialManager)
          .Get(),
      IID_PPV_ARGS(&aOut));
}

// "BWVAULT-<vault id hex>": the codename never appears in it, so a rename
// doesn't strand existing keys (§3).
void KeyName(const uint8_t aVaultId[BWV_ID_BYTES], wchar_t aOut[8 + 2 * BWV_ID_BYTES + 1]) {
  static const wchar_t kHex[] = L"0123456789abcdef";
  wcscpy_s(aOut, 9, L"BWVAULT-");
  for (size_t i = 0; i < BWV_ID_BYTES; i++) {
    aOut[8 + 2 * i] = kHex[aVaultId[i] >> 4];
    aOut[8 + 2 * i + 1] = kHex[aVaultId[i] & 0xf];
  }
  aOut[8 + 2 * BWV_ID_BYTES] = 0;
}

bwv_status FromCredentialStatus(KeyCredentialStatus aStatus) {
  switch (aStatus) {
    case KeyCredentialStatus_Success:
      return BWV_OK;
    case KeyCredentialStatus_UserCanceled:
    case KeyCredentialStatus_UserPrefersPassword:
      return BWV_E_CANCELLED;
    case KeyCredentialStatus_NotFound:
      return BWV_E_NO_SLOT;
    default:
      return BWV_E_PROVIDER;
  }
}

bool HasTpm2() {
  TPM_DEVICE_INFO info = {};
  return ::Tbsi_GetDeviceInfo(sizeof(info), &info) == TBS_SUCCESS &&
         info.tpmVersion == TPM_VERSION_20;
}

}  // namespace

// ---- This computer only ----

namespace {

void DeviceKeyName(const uint8_t aVaultId[BWV_ID_BYTES],
                   wchar_t aOut[15 + 2 * BWV_ID_BYTES + 1]) {
  static const wchar_t kHex[] = L"0123456789abcdef";
  wcscpy_s(aOut, 16, L"BWVAULT-DEVICE-");
  for (size_t i = 0; i < BWV_ID_BYTES; i++) {
    aOut[15 + 2 * i] = kHex[aVaultId[i] >> 4];
    aOut[15 + 2 * i + 1] = kHex[aVaultId[i] & 0xf];
  }
  aOut[15 + 2 * BWV_ID_BYTES] = 0;
}

// SHA-256 of `aContext` then `aData`.
bool Sha256(const char* aContext, const uint8_t* aData, size_t aLen,
            uint8_t aOut[32]) {
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  bool ok =
      BCRYPT_SUCCESS(::BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0)) &&
      BCRYPT_SUCCESS(::BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0)) &&
      BCRYPT_SUCCESS(::BCryptHashData(hash, (PUCHAR)aContext, (ULONG)strlen(aContext), 0)) &&
      BCRYPT_SUCCESS(::BCryptHashData(hash, (PUCHAR)aData, (ULONG)aLen, 0)) &&
      BCRYPT_SUCCESS(::BCryptFinishHash(hash, aOut, 32, 0));
  if (hash) {
    ::BCryptDestroyHash(hash);
  }
  if (alg) {
    ::BCryptCloseAlgorithmProvider(alg, 0);
  }
  return ok;
}

class Provider {
 public:
  Provider() {
    if (FAILED(::NCryptOpenStorageProvider(&mHandle, MS_PLATFORM_CRYPTO_PROVIDER, 0))) {
      mHandle = 0;
    }
  }
  ~Provider() {
    if (mHandle) {
      ::NCryptFreeObject(mHandle);
    }
  }
  NCRYPT_PROV_HANDLE get() const { return mHandle; }

 private:
  NCRYPT_PROV_HANDLE mHandle = 0;
};

bool OpenDeviceKey(const Provider& aProvider, const uint8_t aVaultId[BWV_ID_BYTES],
                   NCRYPT_KEY_HANDLE* aKey) {
  wchar_t name[15 + 2 * BWV_ID_BYTES + 1];
  DeviceKeyName(aVaultId, name);
  return aProvider.get() && SUCCEEDED(::NCryptOpenKey(aProvider.get(), aKey, name, 0, 0));
}

}  // namespace

bool DeviceBindingAvailable() {
  Provider provider;
  return HasTpm2() && provider.get();
}

bool DeviceKeyExists(const uint8_t aVaultId[BWV_ID_BYTES]) {
  Provider provider;
  NCRYPT_KEY_HANDLE key = 0;
  if (!OpenDeviceKey(provider, aVaultId, &key)) {
    return false;
  }
  ::NCryptFreeObject(key);
  return true;
}

bwv_status DeviceCreate(const uint8_t aVaultId[BWV_ID_BYTES]) {
  Provider provider;
  if (!HasTpm2() || !provider.get()) {
    return BWV_E_PROVIDER;
  }
  wchar_t name[15 + 2 * BWV_ID_BYTES + 1];
  DeviceKeyName(aVaultId, name);
  NCRYPT_KEY_HANDLE key = 0;
  DWORD length = 2048;
  bool ok = SUCCEEDED(::NCryptCreatePersistedKey(provider.get(), &key, BCRYPT_RSA_ALGORITHM,
                                                 name, 0, NCRYPT_OVERWRITE_KEY_FLAG)) &&
            SUCCEEDED(::NCryptSetProperty(key, NCRYPT_LENGTH_PROPERTY, (PBYTE)&length,
                                          sizeof(length), 0)) &&
            SUCCEEDED(::NCryptFinalizeKey(key, 0));
  if (key) {
    ::NCryptFreeObject(key);
  }
  if (!ok) {
    DeviceDelete(aVaultId);
    return BWV_E_PROVIDER;
  }
  return BWV_OK;
}

bwv_status DeviceSecret(const uint8_t aVaultId[BWV_ID_BYTES], uint8_t aOut[32]) {
  Provider provider;
  if (!provider.get()) {
    return BWV_E_PROVIDER;
  }
  NCRYPT_KEY_HANDLE key = 0;
  if (!OpenDeviceKey(provider, aVaultId, &key)) {
    return BWV_E_NO_SLOT;
  }
  // The same challenge every time, from the vault id; PKCS#1 v1.5 signs it
  // the same way every time.
  uint8_t challenge[32];
  uint8_t signature[512];
  DWORD len = 0;
  BCRYPT_PKCS1_PADDING_INFO padding = {BCRYPT_SHA256_ALGORITHM};
  bool ok = Sha256("vault/device/challenge", aVaultId, BWV_ID_BYTES, challenge) &&
            SUCCEEDED(::NCryptSignHash(key, &padding, challenge, sizeof(challenge), signature,
                                       sizeof(signature), &len, BCRYPT_PAD_PKCS1)) &&
            Sha256("vault/device/secret", signature, len, aOut);
  ::SecureZeroMemory(signature, sizeof(signature));
  ::NCryptFreeObject(key);
  return ok ? BWV_OK : BWV_E_PROVIDER;
}

void DeviceDelete(const uint8_t aVaultId[BWV_ID_BYTES]) {
  Provider provider;
  NCRYPT_KEY_HANDLE key = 0;
  if (OpenDeviceKey(provider, aVaultId, &key)) {
    ::NCryptDeleteKey(key, 0);  // frees the handle
  }
}

bool HelloAvailable() {
  WinRTScope winrt;
  if (!winrt.Usable() || !HasTpm2()) {
    return false;
  }
  ComPtr<IKeyCredentialManagerStatics> statics;
  ComPtr<IAsyncOperation<bool>> operation;
  boolean supported = false;
  return SUCCEEDED(Statics(statics)) &&
         SUCCEEDED(statics->IsSupportedAsync(&operation)) &&
         SUCCEEDED(Wait(operation.Get(), false)) &&
         SUCCEEDED(operation->GetResults(&supported)) && supported;
}

bwv_status HelloEnroll(const uint8_t aVaultId[BWV_ID_BYTES]) {
  WinRTScope winrt;
  if (!winrt.Usable()) {
    return BWV_E_PROVIDER;
  }
  wchar_t name[8 + 2 * BWV_ID_BYTES + 1];
  KeyName(aVaultId, name);
  ComPtr<IKeyCredentialManagerStatics> statics;
  ComPtr<IAsyncOperation<KeyCredentialRetrievalResult*>> operation;
  if (FAILED(Statics(statics)) ||
      FAILED(statics->RequestCreateAsync(HStringReference(name).Get(),
                                         KeyCredentialCreationOption_ReplaceExisting,
                                         &operation)) ||
      FAILED(Wait(operation.Get(), true))) {
    return BWV_E_PROVIDER;
  }
  ComPtr<IKeyCredentialRetrievalResult> result;
  KeyCredentialStatus status = KeyCredentialStatus_UnknownError;
  if (FAILED(operation->GetResults(&result)) || FAILED(result->get_Status(&status))) {
    return BWV_E_PROVIDER;
  }
  return FromCredentialStatus(status);
}

bwv_status HelloSign(void* aCtx, const uint8_t aVaultId[BWV_ID_BYTES],
                     const uint8_t aChallenge[BWV_CHALLENGE_BYTES],
                     uint8_t* aSignature, size_t* aLen) {
  WinRTScope winrt;
  if (!winrt.Usable()) {
    return BWV_E_PROVIDER;
  }
  wchar_t name[8 + 2 * BWV_ID_BYTES + 1];
  KeyName(aVaultId, name);

  ComPtr<IKeyCredentialManagerStatics> statics;
  ComPtr<IAsyncOperation<KeyCredentialRetrievalResult*>> opening;
  if (FAILED(Statics(statics)) ||
      FAILED(statics->OpenAsync(HStringReference(name).Get(), &opening)) ||
      FAILED(Wait(opening.Get(), false))) {
    return BWV_E_PROVIDER;
  }
  ComPtr<IKeyCredentialRetrievalResult> retrieved;
  KeyCredentialStatus status = KeyCredentialStatus_UnknownError;
  if (FAILED(opening->GetResults(&retrieved)) || FAILED(retrieved->get_Status(&status))) {
    return BWV_E_PROVIDER;
  }
  if (status != KeyCredentialStatus_Success) {
    return FromCredentialStatus(status);
  }
  ComPtr<IKeyCredential> credential;
  if (FAILED(retrieved->get_Credential(&credential))) {
    return BWV_E_PROVIDER;
  }

  ComPtr<ICryptographicBufferStatics> buffers;
  ComPtr<IBuffer> challenge;
  if (FAILED(::RoGetActivationFactory(
          HStringReference(RuntimeClass_Windows_Security_Cryptography_CryptographicBuffer)
              .Get(),
          IID_PPV_ARGS(&buffers))) ||
      FAILED(buffers->CreateFromByteArray(BWV_CHALLENGE_BYTES,
                                          const_cast<BYTE*>(aChallenge), &challenge))) {
    return BWV_E_PROVIDER;
  }

  ComPtr<IAsyncOperation<KeyCredentialOperationResult*>> signing;
  if (FAILED(credential->RequestSignAsync(challenge.Get(), &signing)) ||
      FAILED(Wait(signing.Get(), true))) {
    return BWV_E_PROVIDER;
  }
  ComPtr<IKeyCredentialOperationResult> signed_;
  if (FAILED(signing->GetResults(&signed_)) || FAILED(signed_->get_Status(&status))) {
    return BWV_E_PROVIDER;
  }
  if (status != KeyCredentialStatus_Success) {
    return FromCredentialStatus(status);
  }
  ComPtr<IBuffer> signature;
  UINT32 length = 0;
  BYTE* bytes = nullptr;
  if (FAILED(signed_->get_Result(&signature)) ||
      FAILED(buffers->CopyToByteArray(signature.Get(), &length, &bytes))) {
    return BWV_E_PROVIDER;
  }
  bwv_status st = BWV_OK;
  if (length == 0 || length > *aLen) {
    st = BWV_E_PROVIDER;
  } else {
    memcpy(aSignature, bytes, length);
    *aLen = length;
  }
  ::SecureZeroMemory(bytes, length);
  ::CoTaskMemFree(bytes);
  return st;
}

void HelloDelete(const uint8_t aVaultId[BWV_ID_BYTES]) {
  WinRTScope winrt;
  if (!winrt.Usable()) {
    return;
  }
  wchar_t name[8 + 2 * BWV_ID_BYTES + 1];
  KeyName(aVaultId, name);
  ComPtr<IKeyCredentialManagerStatics> statics;
  ComPtr<IAsyncAction> deleting;
  if (SUCCEEDED(Statics(statics)) &&
      SUCCEEDED(statics->DeleteAsync(HStringReference(name).Get(), &deleting))) {
    Wait(deleting.Get(), false);
  }
}

// ---- Session lock ----

namespace {

HWND sSessionWindow = nullptr;
void (*sSessionCallback)() = nullptr;
const wchar_t kSessionWindowClass[] = L"BrowserWipSessionWatcher";

LRESULT CALLBACK SessionWindowProc(HWND aWnd, UINT aMsg, WPARAM aWParam, LPARAM aLParam) {
  if (aMsg == WM_WTSSESSION_CHANGE &&
      (aWParam == WTS_SESSION_LOCK || aWParam == WTS_CONSOLE_DISCONNECT ||
       aWParam == WTS_REMOTE_DISCONNECT)) {
    // Windows can report other sessions' changes too.
    DWORD session = 0;
    if (::ProcessIdToSessionId(::GetCurrentProcessId(), &session) &&
        session == static_cast<DWORD>(aLParam) && sSessionCallback) {
      // Not from inside the window procedure.
      NS_DispatchToMainThread(NS_NewRunnableFunction(
          "PasswordVault session locked", [] {
            if (sSessionCallback) {
              sSessionCallback();
            }
          }));
    }
    return 0;
  }
  return ::DefWindowProcW(aWnd, aMsg, aWParam, aLParam);
}

}  // namespace

void WatchSessionLock(void (*aCallback)()) {
  MOZ_ASSERT(NS_IsMainThread());
  if (sSessionWindow) {
    return;
  }
  WNDCLASSW wc = {};
  wc.lpfnWndProc = SessionWindowProc;
  wc.hInstance = ::GetModuleHandleW(nullptr);
  wc.lpszClassName = kSessionWindowClass;
  ::RegisterClassW(&wc);
  // A message-only window: WTS notifications are sent to it directly.
  sSessionWindow = ::CreateWindowExW(0, kSessionWindowClass, L"", 0, 0, 0, 0, 0,
                                     HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
  if (!sSessionWindow) {
    return;
  }
  if (!::WTSRegisterSessionNotification(sSessionWindow, NOTIFY_FOR_THIS_SESSION)) {
    ::DestroyWindow(sSessionWindow);
    sSessionWindow = nullptr;
    return;
  }
  sSessionCallback = aCallback;
}

void StopWatchingSessionLock() {
  MOZ_ASSERT(NS_IsMainThread());
  sSessionCallback = nullptr;
  if (sSessionWindow) {
    ::WTSUnRegisterSessionNotification(sSessionWindow);
    ::DestroyWindow(sSessionWindow);
    sSessionWindow = nullptr;
  }
}

}  // namespace mozilla::browserwip::windows_unlock

#else  // !XP_WIN

namespace mozilla::browserwip::windows_unlock {

bool HelloAvailable() { return false; }

bwv_status HelloEnroll(const uint8_t aVaultId[BWV_ID_BYTES]) { return BWV_E_PROVIDER; }

bwv_status HelloSign(void* aCtx, const uint8_t aVaultId[BWV_ID_BYTES],
                     const uint8_t aChallenge[BWV_CHALLENGE_BYTES],
                     uint8_t* aSignature, size_t* aLen) {
  return BWV_E_PROVIDER;
}

void HelloDelete(const uint8_t aVaultId[BWV_ID_BYTES]) {}

bool DeviceBindingAvailable() { return false; }

bool DeviceKeyExists(const uint8_t aVaultId[BWV_ID_BYTES]) { return false; }

bwv_status DeviceCreate(const uint8_t aVaultId[BWV_ID_BYTES]) { return BWV_E_PROVIDER; }

bwv_status DeviceSecret(const uint8_t aVaultId[BWV_ID_BYTES], uint8_t aOut[32]) {
  return BWV_E_NO_SLOT;
}

void DeviceDelete(const uint8_t aVaultId[BWV_ID_BYTES]) {}

void WatchSessionLock(void (*aCallback)()) {}

void StopWatchingSessionLock() {}

}  // namespace mozilla::browserwip::windows_unlock

#endif  // XP_WIN
