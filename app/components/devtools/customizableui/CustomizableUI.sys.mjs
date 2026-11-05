/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Stands in for Firefox's CustomizableUI (browser/components/customizableui)
 * for DevToolsStartup and the profiler button: this app has no customizable
 * toolbars, so widgets are only remembered, never shown.
 */

const widgets = new Map();

export const CustomizableUI = {
  PROVIDER_API: "api",
  PROVIDER_XUL: "xul",
  SOURCE_BUILTIN: "builtin",
  SOURCE_EXTERNAL: "external",
  AREA_NAVBAR: "nav-bar",
  AREA_TABSTRIP: "TabsToolbar",

  createWidget(definition) {
    let widget = { ...definition, provider: this.PROVIDER_API, areaType: null, instances: [] };
    widgets.set(definition.id, widget);
    return widget;
  },

  destroyWidget(id) {
    widgets.delete(id);
  },

  getWidget(id) {
    return widgets.get(id) ?? null;
  },

  getPlacementOfWidget() {
    return null;
  },

  addWidgetToArea() {},

  removeWidgetFromArea() {},

  addListener() {},

  removeListener() {},

  clearSubview(subview) {
    subview?.replaceChildren();
  },

  fillSubviewFromMenuItems() {},
};
