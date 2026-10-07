/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Program entry point. Adapted from browser/app/nsBrowserApp.cpp in
// mozilla-central, keeping only the Linux paths: load libxul, start child
// processes from the same executable, and hand the compiled-in application
// data to XRE_main.

#include "nsXULAppAPI.h"
#include "mozilla/XREAppData.h"
#include "XREChildData.h"
#include "XREShellData.h"
#include "ApplicationData.h"
#include "mozilla/Bootstrap.h"
#include "mozilla/CmdLineAndEnvUtils.h"
#include "mozilla/ProcessType.h"
#include "mozilla/RuntimeExceptionModule.h"
#include "mozilla/ScopeExit.h"

#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

#include "BinaryPath.h"
#include "nsXPCOMPrivate.h"  // for MAXPATHLEN

#include "mozilla/BaseProfiler.h"
#include "mozilla/Sprintf.h"
#include "mozilla/StartupTimeline.h"
#include "mozilla/UniquePtrExtensions.h"

using namespace mozilla;

// Arguments that must not be followed by further flags, so a URL handed to us
// by the desktop cannot smuggle in options.
static constexpr const char* kRequiredArguments[] = {"url", "private-window"};

static MOZ_FORMAT_PRINTF(1, 2) void Output(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
}

// True if |arg| is |-s| or |--s|.
static bool IsFlag(const char* arg, const char* s) {
  if (*arg == '-') {
    if (*++arg == '-') ++arg;
    return !strcasecmp(arg, s);
  }
  return false;
}

constinit Bootstrap::UniquePtr gBootstrap;

static int do_main(int argc, char* argv[], char* envp[]) {
  if (argc > 1 && IsFlag(argv[1], "xpcshell")) {
    for (int i = 1; i < argc; i++) {
      argv[i] = argv[i + 1];
    }
    XREShellData shellData;
    return gBootstrap->XRE_XPCShellMain(--argc, argv, envp, &shellData);
  }

  // The app data is compiled in, and the app's files live in the same
  // directory as libxul, so there is no app subdirectory to point at.
  BootstrapConfig config;
  config.appData = kStaticAppData;
  config.appDataPath = nullptr;

  EnsureCommandlineSafe(argc, argv, kRequiredArguments, nullptr);

  return gBootstrap->XRE_main(argc, argv, config);
}

static nsresult InitXPCOMGlue(LibLoadingStrategy aLibLoadingStrategy) {
  if (gBootstrap) {
    return NS_OK;
  }

  UniqueFreePtr<char> exePath = BinaryPath::Get();
  if (!exePath) {
    Output("Couldn't find the application directory.\n");
    return NS_ERROR_FAILURE;
  }

  auto bootstrapResult =
      mozilla::GetBootstrap(exePath.get(), aLibLoadingStrategy);
  if (bootstrapResult.isErr()) {
    Output("Couldn't load XPCOM.\n");
    return NS_ERROR_FAILURE;
  }

  gBootstrap = bootstrapResult.unwrap();
  gBootstrap->NS_LogInit();
  return NS_OK;
}

// Make sure fds 0-2 are taken so nothing we open lands on stdio.
static void ReserveDefaultFileDescriptors() {
  int fd = open("/dev/null", O_RDONLY);
  for (int i = 0; i < 2; i++) {
    [[maybe_unused]] int r = dup(fd);
  }
}

// Grow the fd table once at startup instead of under a lock later.
static void ExpandFileDescriptorTable() {
  mozilla::UniqueFileHandle fdTableExpander(fcntl(0, F_DUPFD, 256));
}

int main(int argc, char* argv[], char* envp[]) {
  ReserveDefaultFileDescriptors();

  // Content, GPU, socket and other child processes run this same executable.
  if (argc > 1 && IsFlag(argv[1], "contentproc")) {
    SetGeckoProcessType(argv[--argc]);
    SetGeckoChildID(argv[--argc]);

#if defined(MOZ_ENABLE_FORKSERVER)
    if (GetGeckoProcessType() == GeckoProcessType_ForkServer) {
      nsresult rv = InitXPCOMGlue(LibLoadingStrategy::NoReadAhead);
      if (NS_FAILED(rv)) {
        return 255;
      }
      // Returns false in forked children, which fall through to the child
      // process path below.
      if (gBootstrap->XRE_ForkServer(&argc, &argv)) {
        gBootstrap->NS_LogTerm();
        return 0;
      }
    }
#endif
  }

  ExpandFileDescriptorTable();

  mozilla::TimeStamp start = mozilla::TimeStamp::Now();

  AUTO_BASE_PROFILER_INIT;
  AUTO_BASE_PROFILER_LABEL("nsBrowserWipApp main", OTHER);

  CrashReporter::RegisterRuntimeExceptionModule();
  auto unregisterRuntimeExceptionModule =
      MakeScopeExit([] { CrashReporter::UnregisterRuntimeExceptionModule(); });

  if (GetGeckoProcessType() != GeckoProcessType_Default) {
    nsresult rv = InitXPCOMGlue(LibLoadingStrategy::NoReadAhead);
    if (NS_FAILED(rv)) {
      return 255;
    }
    XREChildData childData;
    rv = gBootstrap->XRE_InitChildProcess(argc, argv, &childData);
    gBootstrap->NS_LogTerm();
    return NS_FAILED(rv) ? 1 : 0;
  }

  nsresult rv = InitXPCOMGlue(LibLoadingStrategy::ReadAhead);
  if (NS_FAILED(rv)) {
    return 255;
  }

  gBootstrap->XRE_StartupTimelineRecord(mozilla::StartupTimeline::START, start);
  gBootstrap->XRE_EnableSameExecutableForContentProc();

  int result = do_main(argc, argv, envp);

  gBootstrap->NS_LogTerm();
  gBootstrap.reset();
  return result;
}
