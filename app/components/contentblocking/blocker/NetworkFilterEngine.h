/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef browserwip_NetworkFilterEngine_h
#define browserwip_NetworkFilterEngine_h

#include "mozilla/UniquePtr.h"
#include "nsString.h"
#include "nsTArray.h"

namespace mozilla::browserwip {

// One request, as a filter engine sees it.
struct FilterRequest {
  nsCString mUrl;           // ASCII spec
  nsCString mHost;          // ASCII host of mUrl (not its registrable domain)
  nsCString mSourceHost;    // ASCII host of the document making the request
  nsCString mType;          // "script", "xmlhttprequest", "subdocument", ...
  bool mThirdParty = true;  // registrable domains of the two hosts differ
};

struct FilterVerdict {
  bool mBlock = false;
  bool mImportant = false;
  bool mException = false;  // an exception rule matched
};

// A compiled set of network filter rules. Built on any thread, then used by
// one thread at a time; implementations need not be thread-safe.
class NetworkFilterEngine {
 public:
  virtual ~NetworkFilterEngine() = default;
  virtual FilterVerdict Check(const FilterRequest& aRequest) const = 0;
};

// adblock-rust, through toolkit's content_classifier_engine FFI
// (AdblockRustEngine.cpp). InitAdblockRustEngines() must succeed, on the main
// thread, before the first build: the engine resolves domains through it.
nsresult InitAdblockRustEngines();
// Any thread. Null if the engine could not be built.
UniquePtr<NetworkFilterEngine> BuildAdblockRustEngine(
    const nsTArray<nsCString>& aRules);

}  // namespace mozilla::browserwip

#endif  // browserwip_NetworkFilterEngine_h
