/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "NetworkBlocker.h"

#include "mozilla/BasePrincipal.h"  // nsIPrincipal::IsSystemPrincipal
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/Components.h"
#include "mozilla/Logging.h"
#include "mozilla/Preferences.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPrefs_privacy.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/net/ChannelClassifierUtils.h"
#include "nsICookieJarSettings.h"
#include "nsIEffectiveTLDService.h"
#include "nsILoadInfo.h"
#include "nsIObserverService.h"
#include "nsIPrincipal.h"
#include "nsIURI.h"
#include "nsNetUtil.h"
#include "nsThreadUtils.h"

// MOZ_LOG=BrowserWipBlocker:3 for startup and state changes,
// :4 for the time each request check takes, :5 for each URL checked.
static mozilla::LazyLogModule gBlockerLog("BrowserWipBlocker");
#define BLOCKER_LOG(level, args) \
  MOZ_LOG(gBlockerLog, mozilla::LogLevel::level, args)

namespace mozilla::browserwip {

static StaticRefPtr<NetworkBlocker> sSingleton;

static constexpr uint32_t kBuildTimeoutMs = 10000;
static constexpr auto kMainList = "browserwip-ads-trackers"_ns;
static constexpr auto kSocialList = "browserwip-social"_ns;
static const char* const kProtectionPrefs[] = {
    "privacy.trackingprotection.enabled",
    "privacy.trackingprotection.pbmode.enabled",
};

NS_IMPL_ISUPPORTS(NetworkBlocker, nsIBrowserWipBlocker, nsIObserver,
                  nsITimerCallback, nsINamed)

/* static */
already_AddRefed<NetworkBlocker> NetworkBlocker::GetSingleton() {
  MOZ_ASSERT(NS_IsMainThread());
  if (!sSingleton) {
    sSingleton = new NetworkBlocker();
    ClearOnShutdown(&sSingleton);
  }
  return do_AddRef(sSingleton);
}

static bool ProtectionEnabled(nsIChannel* aChannel) {
  return NS_UsePrivateBrowsing(aChannel)
             ? StaticPrefs::privacy_trackingprotection_pbmode_enabled()
             : StaticPrefs::privacy_trackingprotection_enabled();
}

// Request types as WebExtensions name them (ChannelWrapper.cpp,
// GetContentPolicyType), spelled the way adblock-rust reads them. fetch() is
// "xmlhttprequest" there, as in every other browser.
static const char* RequestType(ExtContentPolicyType aType) {
  switch (aType) {
    case ExtContentPolicy::TYPE_DOCUMENT:
      return "document";
    case ExtContentPolicy::TYPE_SUBDOCUMENT:
      return "subdocument";
    case ExtContentPolicy::TYPE_STYLESHEET:
      return "stylesheet";
    case ExtContentPolicy::TYPE_SCRIPT:
      return "script";
    case ExtContentPolicy::TYPE_IMAGE:
    case ExtContentPolicy::TYPE_IMAGESET:
      return "image";
    case ExtContentPolicy::TYPE_OBJECT:
      return "object";
    case ExtContentPolicy::TYPE_XMLHTTPREQUEST:
    case ExtContentPolicy::TYPE_FETCH:
      return "xmlhttprequest";
    case ExtContentPolicy::TYPE_PING:
    case ExtContentPolicy::TYPE_BEACON:
      return "ping";
    case ExtContentPolicy::TYPE_FONT:
    case ExtContentPolicy::TYPE_UA_FONT:
      return "font";
    case ExtContentPolicy::TYPE_MEDIA:
      return "media";
    case ExtContentPolicy::TYPE_WEBSOCKET:
      return "websocket";
    case ExtContentPolicy::TYPE_CSP_REPORT:
      return "csp_report";
    default:
      return "other";
  }
}

static bool IsCosmeticRule(const nsACString& aLine) {
  static const char* const kMarkers[] = {"##",  "#@#",  "#?#", "#@?#",
                                         "#$#", "#@$#", "#%#", "#@%#"};
  for (const char* marker : kMarkers) {
    if (aLine.Find(marker) != kNotFound) {
      return true;
    }
  }
  return false;
}

// Rules whose options include redirect= or redirect-rule=. Without the
// redirect resources (phase 2), adblock-rust would block these requests
// instead of answering them with a stand-in, so they are left out.
static bool IsRedirectRule(const nsACString& aLine) {
  int32_t dollar = aLine.RFindChar('$');
  if (dollar == kNotFound) {
    return false;
  }
  const nsDependentCSubstring options = Substring(aLine, dollar + 1);
  for (const auto& option : options.Split(',')) {
    if (StringBeginsWith(option, "redirect="_ns) ||
        StringBeginsWith(option, "redirect-rule="_ns)) {
      return true;
    }
  }
  return false;
}

/* static */
NetworkBlocker::Rules NetworkBlocker::SplitRules(const nsACString& aText) {
  // tools/adblock/src/lib.rs (split_rules) does exactly the same for the
  // reference test; keep the two in step.
  Rules rules;
  for (const auto& raw : aText.Split('\n')) {
    nsCString line(raw);
    line.Trim(" \t\r");
    if (line.IsEmpty() || line.First() == '!' || line.First() == '[') {
      continue;
    }
    if (IsCosmeticRule(line)) {
      rules.mDroppedCosmetic++;
      continue;
    }
    if (IsRedirectRule(line)) {
      rules.mDroppedRedirect++;
      continue;
    }
    rules.mRules.AppendElement(std::move(line));
  }
  return rules;
}

/* static */
NetworkBlocker::BuildResult NetworkBlocker::Build(const nsACString& aMain,
                                                  const nsACString& aSocial) {
  BuildResult result;
  TimeStamp start = TimeStamp::Now();
  Rules main = SplitRules(aMain);
  Rules social = SplitRules(aSocial);
  BLOCKER_LOG(
      Info, ("network rules: %zu ads and trackers, %zu social; dropped %u "
             "$redirect rules (phase 2 re-enables them) and %u element-hiding "
             "rules",
             main.mRules.Length(), social.mRules.Length(),
             main.mDroppedRedirect + social.mDroppedRedirect,
             main.mDroppedCosmetic + social.mDroppedCosmetic));
  if (main.mRules.IsEmpty() || social.mRules.IsEmpty()) {
    result.mError = "a filter list is missing or empty"_ns;
    return result;
  }
  result.mMain = BuildAdblockRustEngine(main.mRules);
  result.mSocial = BuildAdblockRustEngine(social.mRules);
  if (!result.mMain || !result.mSocial) {
    result.mError = "the filter engine could not be built"_ns;
    return result;
  }
  BLOCKER_LOG(Info, ("engines built in %.0f ms",
                     (TimeStamp::Now() - start).ToMilliseconds()));
  return result;
}

NS_IMETHODIMP
NetworkBlocker::GetState(nsACString& aState) {
  switch (mState) {
    case State::Idle:
      aState.AssignLiteral("idle");
      break;
    case State::Building:
      aState.AssignLiteral("building");
      break;
    case State::Ready:
      aState.AssignLiteral("ready");
      break;
    case State::Failed:
      aState.AssignLiteral("failed");
      break;
    case State::Timeout:
      aState.AssignLiteral("timeout");
      break;
    case State::ShutDown:
      aState.AssignLiteral("shutdown");
      break;
  }
  return NS_OK;
}

NS_IMETHODIMP
NetworkBlocker::Start(const nsACString& aMainLists,
                      const nsACString& aSocialList) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mState != State::Idle) {
    return NS_OK;
  }
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (!obs) {
    return NS_ERROR_FAILURE;
  }
  obs->AddObserver(this, "http-on-modify-request", false);
  obs->AddObserver(this, "xpcom-shutdown", false);
  for (const char* pref : kProtectionPrefs) {
    Preferences::RegisterCallback(PrefChanged, nsDependentCString(pref), this);
  }
  mStarted = TimeStamp::Now();
  SetState(State::Building);

  nsresult rv = InitAdblockRustEngines();
  if (NS_FAILED(rv)) {
    BLOCKER_LOG(Error, ("domain resolver unavailable (0x%08x); not blocking",
                        static_cast<uint32_t>(rv)));
    SetState(State::Failed);
    return NS_OK;
  }
  NS_NewTimerWithCallback(getter_AddRefs(mTimer), this, kBuildTimeoutMs,
                          nsITimer::TYPE_ONE_SHOT);

  // The background task holds no reference to this object (its refcount is
  // main-thread only); the result goes back through sSingleton.
  rv = NS_DispatchBackgroundTask(
      NS_NewRunnableFunction(
          "NetworkBlocker::Build",
          [main = nsCString(aMainLists), social = nsCString(aSocialList)]() {
            BuildResult result = Build(main, social);
            NS_DispatchToMainThread(NS_NewRunnableFunction(
                "NetworkBlocker::OnBuilt",
                [result = std::move(result)]() mutable {
                  if (RefPtr<NetworkBlocker> blocker = sSingleton.get()) {
                    blocker->OnBuilt(std::move(result));
                  }
                }));
          }),
      NS_DISPATCH_EVENT_MAY_BLOCK);
  if (NS_FAILED(rv)) {
    BLOCKER_LOG(Error, ("could not start the build (0x%08x); not blocking",
                        static_cast<uint32_t>(rv)));
    SetState(State::Failed);
    ReleaseHeld("engine build failed");
  }
  return NS_OK;
}

void NetworkBlocker::OnBuilt(BuildResult&& aResult) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mState == State::ShutDown) {
    return;
  }
  if (mTimer) {
    mTimer->Cancel();
    mTimer = nullptr;
  }
  double ms = (TimeStamp::Now() - mStarted).ToMilliseconds();
  if (!aResult.mError.IsEmpty()) {
    BLOCKER_LOG(Error,
                ("%s after %.0f ms; not blocking", aResult.mError.get(), ms));
    SetState(State::Failed);
    ReleaseHeld("engine build failed");
    return;
  }
  BLOCKER_LOG(Info, ("ready %.0f ms after start%s", ms,
                     mState == State::Timeout ? ", after the timeout" : ""));
  mMain = std::move(aResult.mMain);
  mSocial = std::move(aResult.mSocial);
  SetState(State::Ready);
  ProcessHeld();
}

NS_IMETHODIMP
NetworkBlocker::Notify(nsITimer* aTimer) {
  mTimer = nullptr;
  if (mState == State::Building) {
    BLOCKER_LOG(Error,
                ("engine not built within %u s; not blocking until it is",
                 kBuildTimeoutMs / 1000));
    SetState(State::Timeout);
    ReleaseHeld("engine not built within 10 s");
  }
  return NS_OK;
}

NS_IMETHODIMP
NetworkBlocker::GetName(nsACString& aName) {
  aName.AssignLiteral("NetworkBlocker");
  return NS_OK;
}

NS_IMETHODIMP
NetworkBlocker::Observe(nsISupports* aSubject, const char* aTopic,
                        const char16_t* aData) {
  if (!strcmp(aTopic, "http-on-modify-request")) {
    if (nsCOMPtr<nsIChannel> channel = do_QueryInterface(aSubject)) {
      OnModifyRequest(channel);
    }
  } else if (!strcmp(aTopic, "xpcom-shutdown")) {
    Shutdown();
  }
  return NS_OK;
}

/* static */
void NetworkBlocker::PrefChanged(const char* aPref, void* aClosure) {
  static_cast<NetworkBlocker*>(aClosure)->ReleaseUnprotected();
}

void NetworkBlocker::OnModifyRequest(nsIChannel* aChannel) {
  TimeStamp start = TimeStamp::Now();
  nsCOMPtr<nsILoadInfo> loadInfo = aChannel->LoadInfo();
  // Top-level pages are never blocked in this phase: the lists' $document
  // rules would need a "blocked page" with a way to continue
  // (docs/CONTENT-BLOCKING.md).
  if (loadInfo->GetExternalContentPolicyType() ==
      ExtContentPolicy::TYPE_DOCUMENT) {
    return;
  }
  // The browser's own requests.
  nsIPrincipal* source = loadInfo->GetLoadingPrincipal();
  if (!source) {
    source = loadInfo->TriggeringPrincipal();
  }
  if (!source || source->IsSystemPrincipal() ||
      source->GetIsAddonOrExpandedAddonPrincipal()) {
    return;
  }
  if (!ProtectionEnabled(aChannel)) {
    return;
  }
  // Protections switched off for the site (the shield's toggle).
  nsCOMPtr<nsICookieJarSettings> cookieJarSettings;
  loadInfo->GetCookieJarSettings(getter_AddRefs(cookieJarSettings));
  if (cookieJarSettings &&
      cookieJarSettings->GetIsOnContentBlockingAllowList()) {
    return;
  }

  switch (mState) {
    case State::Building:
      if (NS_SUCCEEDED(aChannel->Suspend())) {
        mHeld.AppendElement(aChannel);
        BLOCKER_LOG(Debug,
                    ("holding a request until the engine is built (%zu held)",
                     mHeld.Length()));
      }
      return;
    case State::Ready:
      Check(aChannel, start);
      return;
    default:
      return;
  }
}

void NetworkBlocker::Check(nsIChannel* aChannel, const TimeStamp& aStart) {
  nsCOMPtr<nsILoadInfo> loadInfo = aChannel->LoadInfo();
  FilterRequest request;
  nsCOMPtr<nsIURI> uri;
  aChannel->GetURI(getter_AddRefs(uri));
  if (!uri || NS_FAILED(uri->GetAsciiSpec(request.mUrl)) ||
      NS_FAILED(uri->GetAsciiHost(request.mHost)) || request.mHost.IsEmpty()) {
    return;
  }
  request.mType = RequestType(loadInfo->GetExternalContentPolicyType());

  // The document making the request: a frame's own document, not the top
  // page. A sandboxed document counts as the site that created it.
  nsCOMPtr<nsIPrincipal> source = loadInfo->GetLoadingPrincipal();
  if (!source) {
    source = loadInfo->TriggeringPrincipal();
  }
  if (source && source->GetIsNullPrincipal()) {
    if (nsCOMPtr<nsIPrincipal> precursor = source->GetPrecursorPrincipal()) {
      source = precursor;
    }
  }
  if (source && source->GetIsContentPrincipal()) {
    nsCOMPtr<nsIURI> sourceURI = source->GetURI();
    if (sourceURI) {
      sourceURI->GetAsciiHost(request.mSourceHost);
    }
  }

  // Third party: the two hosts belong to different sites.
  if (!request.mSourceHost.IsEmpty()) {
    nsCOMPtr<nsIEffectiveTLDService> etld = components::EffectiveTLD::Service();
    nsAutoCString site, sourceSite;
    if (etld &&
        NS_SUCCEEDED(etld->GetSchemelessSiteFromHost(request.mHost, site)) &&
        NS_SUCCEEDED(
            etld->GetSchemelessSiteFromHost(request.mSourceHost, sourceSite))) {
      request.mThirdParty = !site.Equals(sourceSite);
    } else {
      request.mThirdParty = !request.mHost.Equals(request.mSourceHost);
    }
  }

  TimeStamp engineStart = TimeStamp::Now();
  FilterVerdict verdict = mMain->Check(request);
  nsresult error = NS_ERROR_TRACKING_URI;
  const nsLiteralCString* list = &kMainList;
  if (!verdict.mBlock &&
      StaticPrefs::privacy_trackingprotection_socialtracking_enabled()) {
    verdict = mSocial->Check(request);
    error = NS_ERROR_SOCIALTRACKING_URI;
    list = &kSocialList;
  }
  TimeStamp engineEnd = TimeStamp::Now();

  if (verdict.mBlock) {
    // Sets requestBlockingReason (CLASSIFY_TRACKING_URI or
    // CLASSIFY_SOCIALTRACKING_URI), the matched list, and the content-blocking
    // log entry the shield counts, exactly as tracking protection does.
    (void)net::ChannelClassifierUtils::SetBlockedContent(aChannel, error, *list,
                                                         ""_ns, ""_ns);
    (void)aChannel->Cancel(error);
  }
  BLOCKER_LOG(Debug,
              ("check %.2f us engine %.2f us %s %s",
               (TimeStamp::Now() - aStart).ToMicroseconds(),
               (engineEnd - engineStart).ToMicroseconds(), request.mType.get(),
               verdict.mBlock ? "blocked" : "allowed"));
  BLOCKER_LOG(Verbose,
              ("  %s from %s%s", request.mUrl.get(), request.mSourceHost.get(),
               request.mThirdParty ? " (third party)" : ""));
}

void NetworkBlocker::ProcessHeld() {
  nsTArray<nsCOMPtr<nsIChannel>> held = std::move(mHeld);
  if (!held.IsEmpty()) {
    BLOCKER_LOG(Info, ("checking %zu requests held until the engine was built",
                       held.Length()));
  }
  for (const auto& channel : held) {
    // As WebExtensions do: resume, then cancel if it matches. The channel
    // goes on only after this task, so the cancel takes effect first.
    channel->Resume();
    nsresult status = NS_OK;
    channel->GetStatus(&status);
    if (NS_SUCCEEDED(status)) {
      OnModifyRequest(channel);
    }
  }
}

void NetworkBlocker::ReleaseHeld(const char* aReason) {
  nsTArray<nsCOMPtr<nsIChannel>> held = std::move(mHeld);
  if (!held.IsEmpty()) {
    BLOCKER_LOG(Info, ("releasing %zu held requests unchecked: %s",
                       held.Length(), aReason));
  }
  for (const auto& channel : held) {
    channel->Resume();
  }
}

void NetworkBlocker::ReleaseUnprotected() {
  size_t released = 0;
  for (size_t i = mHeld.Length(); i-- > 0;) {
    if (!ProtectionEnabled(mHeld[i])) {
      nsCOMPtr<nsIChannel> channel = std::move(mHeld[i]);
      mHeld.RemoveElementAt(i);
      channel->Resume();
      released++;
    }
  }
  if (released) {
    BLOCKER_LOG(Info,
                ("releasing %zu held requests unchecked: protection turned off",
                 released));
  }
}

void NetworkBlocker::SetState(State aState) {
  mState = aState;
  nsAutoCString state;
  GetState(state);
  BLOCKER_LOG(Info, ("state: %s", state.get()));
  if (nsCOMPtr<nsIObserverService> obs = services::GetObserverService()) {
    obs->NotifyObservers(nullptr, "browserwip:blocker-state",
                         NS_ConvertASCIItoUTF16(state).get());
  }
}

void NetworkBlocker::Shutdown() {
  ReleaseHeld("shutting down");
  mState = State::ShutDown;
  if (mTimer) {
    mTimer->Cancel();
    mTimer = nullptr;
  }
  if (nsCOMPtr<nsIObserverService> obs = services::GetObserverService()) {
    obs->RemoveObserver(this, "http-on-modify-request");
    obs->RemoveObserver(this, "xpcom-shutdown");
  }
  for (const char* pref : kProtectionPrefs) {
    Preferences::UnregisterCallback(PrefChanged, nsDependentCString(pref),
                                    this);
  }
  mMain = nullptr;
  mSocial = nullptr;
}

}  // namespace mozilla::browserwip
