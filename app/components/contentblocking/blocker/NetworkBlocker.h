/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef browserwip_NetworkBlocker_h
#define browserwip_NetworkBlocker_h

#include "NetworkFilterEngine.h"
#include "mozilla/TimeStamp.h"
#include "nsCOMPtr.h"
#include "nsIBrowserWipBlocker.h"
#include "nsINamed.h"
#include "nsIObserver.h"
#include "nsITimer.h"
#include "nsTArray.h"

class nsIChannel;

namespace mozilla::browserwip {

// Network matching for the bundled filter lists, in the parent process.
// Observes http-on-modify-request, which fires once per channel and again
// for every redirect target, for requests from every content process.
// Matches are reported the way Gecko's tracking protection reports its own
// (requestBlockingReason, matchedList, content-blocking log), so devtools
// and the shield count them, and are cancelled before they connect.
class NetworkBlocker final : public nsIBrowserWipBlocker,
                             public nsIObserver,
                             public nsITimerCallback,
                             public nsINamed {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIBROWSERWIPBLOCKER
  NS_DECL_NSIOBSERVER
  NS_DECL_NSITIMERCALLBACK
  NS_DECL_NSINAMED

  static already_AddRefed<NetworkBlocker> GetSingleton();

  // The list text split into rules for the engine, without what network
  // matching does not use. Any thread.
  struct Rules {
    nsTArray<nsCString> mRules;
    uint32_t mDroppedRedirect = 0;
    uint32_t mDroppedCosmetic = 0;
  };
  static Rules SplitRules(const nsACString& aText);

 private:
  enum class State { Idle, Building, Ready, Failed, Timeout, ShutDown };

  struct BuildResult {
    UniquePtr<NetworkFilterEngine> mMain;
    UniquePtr<NetworkFilterEngine> mSocial;
    nsCString mError;
  };

  NetworkBlocker() = default;
  ~NetworkBlocker() = default;

  static BuildResult Build(const nsACString& aMain, const nsACString& aSocial);
  static void PrefChanged(const char* aPref, void* aClosure);

  void OnBuilt(BuildResult&& aResult);
  void OnModifyRequest(nsIChannel* aChannel);
  void Check(nsIChannel* aChannel, const TimeStamp& aStart);
  void ProcessHeld();
  void ReleaseHeld(const char* aReason);
  void ReleaseUnprotected();
  void SetState(State aState);
  void Shutdown();

  State mState = State::Idle;
  UniquePtr<NetworkFilterEngine> mMain;
  UniquePtr<NetworkFilterEngine> mSocial;
  // Requests suspended until the engine is built.
  nsTArray<nsCOMPtr<nsIChannel>> mHeld;
  nsCOMPtr<nsITimer> mTimer;
  TimeStamp mStarted;
};

}  // namespace mozilla::browserwip

#endif  // browserwip_NetworkBlocker_h
