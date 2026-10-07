# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Included by the top-level Makefile: `mach package` builds the
# distributable archive (tar.xz on Linux, zip on Windows).

package:
	@$(MAKE) -C browser-wip/installer

stage-package:
	@$(MAKE) -C browser-wip/installer stage-package
