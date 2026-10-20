# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# On the Windows test VM: unpack a build and run the runtime checks on it.
# Started by windows-smoke.sh over SSH.

param(
  [Parameter(Mandatory)] [string] $Run,
  [Parameter(Mandatory)] [string] $Zip,
  [string] $Parts = "1 2 3 4"
)
$ErrorActionPreference = "Stop"
$env:PYTHONUNBUFFERED = "1"

Expand-Archive -Path (Join-Path $Run $Zip) -DestinationPath (Join-Path $Run "app")
$exe = Get-ChildItem (Join-Path $Run "app") -Recurse -Filter browser-wip.exe | Select-Object -First 1
& python (Join-Path $Run "tools/runtime/check.py") $exe.DirectoryName --part ($Parts -split " ")
$code = $LASTEXITCODE

# Keep the three latest runs to look at.
Get-ChildItem C:/ci -Directory -Filter "run-*" | Sort-Object CreationTime -Descending |
  Select-Object -Skip 3 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
exit $code
