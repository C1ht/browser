/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The only file that talks to adblock-rust. It goes through the C FFI of
// toolkit/components/content-classifier/content_classifier_engine, which is
// linked into every libxul (gkrust-shared depends on it unconditionally), so
// nothing in mozilla-central changes.

#include "NetworkFilterEngine.h"

#include "mozilla/content_classifier_ffi.h"

namespace mozilla::browserwip {

namespace {

class AdblockRustEngine final : public NetworkFilterEngine {
 public:
  explicit AdblockRustEngine(ContentClassifierFFIEngine* aEngine)
      : mEngine(aEngine) {}

  ~AdblockRustEngine() override { content_classifier_engine_destroy(mEngine); }

  FilterVerdict Check(const FilterRequest& aRequest) const override {
    FilterVerdict verdict;
    bool matched = false;
    bool important = false;
    nsCString exception;
    // The FFI's "schemeless_site" arguments become adblock's hostname and
    // source hostname (Request::preparsed), so they take hosts: host-anchored
    // rules match by suffix of the hostname. previously_matched_rule is
    // false: each request is checked once, from scratch.
    nsresult rv = content_classifier_engine_check_network_request_preparsed(
        mEngine, &aRequest.mUrl, &aRequest.mHost, &aRequest.mSourceHost,
        &aRequest.mType, aRequest.mThirdParty, false, &matched, &important,
        &exception);
    if (NS_FAILED(rv)) {
      return verdict;
    }
    // "matched" already accounts for exceptions.
    verdict.mBlock = matched;
    verdict.mImportant = important;
    verdict.mException = !exception.IsEmpty();
    return verdict;
  }

 private:
  ContentClassifierFFIEngine* mEngine;
};

}  // namespace

nsresult InitAdblockRustEngines() {
  // Hands the engine Gecko's effective-TLD service. Without a resolver,
  // adblock panics, which aborts the process (Gecko builds Rust with
  // panic = "abort"). Calling it again is harmless.
  return content_classifier_initialize_domain_resolver();
}

UniquePtr<NetworkFilterEngine> BuildAdblockRustEngine(
    const nsTArray<nsCString>& aRules) {
  ContentClassifierFFIEngine* engine = nullptr;
  nsresult rv = content_classifier_engine_from_rules(&aRules, &engine);
  if (NS_FAILED(rv) || !engine) {
    return nullptr;
  }
  return MakeUnique<AdblockRustEngine>(engine);
}

}  // namespace mozilla::browserwip
