/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// DevTools' default preferences. Firefox keeps them in its own pref file
// (browser/app/profile/firefox.js), which this app doesn't use, so they are
// copied here unchanged: the block from "Toolbox preferences" to the end of
// the devtools.* prefs, from Firefox 157.0.2 (GECKO_REVISION).
// Copy it again when Gecko is updated. Nothing here contacts a server by
// itself; the network-silence check (runtime part 2) covers that.

// Toolbox preferences
pref("devtools.toolbox.footer.height", 250);
pref("devtools.toolbox.sidebar.width", 500);
pref("devtools.toolbox.host", "bottom");
pref("devtools.toolbox.previousHost", "right");
pref("devtools.toolbox.selectedTool", "inspector");
pref("devtools.toolbox.zoomValue", "1");
pref("devtools.toolbox.splitconsole.enabled", true);
pref("devtools.toolbox.splitconsole.open", false);
pref("devtools.toolbox.splitconsoleHeight", 100);
pref("devtools.toolbox.tabsOrder", "");
// This is only used for local Web Extension debugging,
// and allows to keep the window on top of all others,
// so that you can debug the Firefox window, while keeping the devtools
// always visible
pref("devtools.toolbox.alwaysOnTop", true);

// When the Multiprocess Browser Toolbox is enabled, you can configure the scope of it:
// - "everything" will enable debugging absolutely everything in the browser
//   All processes, all documents, all workers, all add-ons.
// - "parent-process" will restrict debugging to the parent process
//   All privileged javascript, documents and workers running in the parent process.
pref("devtools.browsertoolbox.scope", "parent-process");

// Controls the hability to debug popups from the same DevTools
// of the original tab the popups are coming from
pref("devtools.popups.debug", false);

// Toolbox Button preferences
pref("devtools.command-button-pick.enabled", true);
pref("devtools.command-button-frames.enabled", true);
pref("devtools.command-button-responsive.enabled", true);
pref("devtools.command-button-screenshot.enabled", false);
pref("devtools.command-button-rulers.enabled", false);
pref("devtools.command-button-measure.enabled", false);
pref("devtools.command-button-noautohide.enabled", false);
pref("devtools.command-button-errorcount.enabled", true);
pref("devtools.command-button-jstracer.enabled", false);
#ifndef MOZILLA_OFFICIAL
  pref("devtools.command-button-experimental-prefs.enabled", true);
#endif

// Inspector preferences
// Enable the Inspector
pref("devtools.inspector.enabled", true);
// What was the last active sidebar in the inspector
pref("devtools.inspector.selectedSidebar", "layoutview");
pref("devtools.inspector.activeSidebar", "layoutview");

// Enable the 3 pane mode in the inspector
pref("devtools.inspector.three-pane-enabled", true);
// Enable the 3 pane mode in the chrome inspector
pref("devtools.inspector.chrome.three-pane-enabled", false);
// Splitter orientation: "side", "stacked", or "auto" (width-based)
pref("devtools.inspector.split-orientation", "auto");
// Collapse pseudo-elements by default in the rule-view
pref("devtools.inspector.show_pseudo_elements", false);
// The default size for image preview tooltips in the rule-view/computed-view/markup-view
pref("devtools.inspector.imagePreviewTooltipSize", 300);
// Enable user agent style inspection in rule-view
pref("devtools.inspector.showUserAgentStyles", false);
// Show native anonymous content and user agent shadow roots
pref("devtools.inspector.showAllAnonymousContent", false);
// Enable overflow debugging in the inspector.
pref("devtools.overflow.debugging.enabled", true);
// Enable drag to edit properties in the inspector rule view.
pref("devtools.inspector.draggable_properties", true);

// Grid highlighter preferences
pref("devtools.gridinspector.gridOutlineMaxColumns", 50);
pref("devtools.gridinspector.gridOutlineMaxRows", 50);
pref("devtools.gridinspector.showGridAreas", false);
pref("devtools.gridinspector.showGridLineNumbers", false);
pref("devtools.gridinspector.showInfiniteLines", false);
// Max number of grid highlighters that can be displayed
pref("devtools.gridinspector.maxHighlighters", 3);

// Whether or not simplified highlighters should be used when
// prefers-reduced-motion is enabled.
pref("devtools.inspector.simple-highlighters-reduced-motion", false);
// Wheter or not Enter on inplace editor in the Rules view moves focus and activates
// next inplace editor.
pref("devtools.inspector.rule-view.focusNextOnEnter", true);
// Enable Rules view CSS explainers
pref("devtools.inspector.css-explainers", false);

// Whether or not the box model panel is opened in the layout view
pref("devtools.layout.boxmodel.opened", true);
// Whether or not the flexbox panel is opened in the layout view
pref("devtools.layout.flexbox.opened", true);
// Whether or not the flexbox container panel is opened in the layout view
pref("devtools.layout.flex-container.opened", true);
// Whether or not the flexbox item panel is opened in the layout view
pref("devtools.layout.flex-item.opened", true);
// Whether or not the grid inspector panel is opened in the layout view
pref("devtools.layout.grid.opened", true);

// Enable hovering Box Model values and jumping to their source CSS rule in the
// rule-view.
#if defined(NIGHTLY_BUILD)
  pref("devtools.layout.boxmodel.highlightProperty", true);
#else
  pref("devtools.layout.boxmodel.highlightProperty", false);
#endif

// By how many times eyedropper will magnify pixels
pref("devtools.eyedropper.zoom", 6);

// Enable to collapse attributes that are too long.
pref("devtools.markup.collapseAttributes", true);
// Length to collapse attributes
pref("devtools.markup.collapseAttributeLength", 120);
// Enable the display of comment nodes in the markup view.
pref("devtools.markup.showComments", true);
// Whether to auto-beautify the HTML on copy.
pref("devtools.markup.beautifyOnCopy", false);

// DevTools default color unit
pref("devtools.defaultColorUnit", "authored");

// Enable the Memory tools
pref("devtools.memory.enabled", true);

pref("devtools.memory.custom-census-displays", "{}");
pref("devtools.memory.custom-label-displays", "{}");
pref("devtools.memory.custom-tree-map-displays", "{}");

pref("devtools.memory.max-individuals", 1000);
pref("devtools.memory.max-retaining-paths", 10);

// Enable the Performance tools
pref("devtools.performance.enabled", true);

// The default cache UI setting
pref("devtools.cache.disabled", false);

// The default service workers UI setting
pref("devtools.serviceWorkers.testing.enabled", false);

// Enable the Network Monitor
pref("devtools.netmonitor.enabled", true);

pref("devtools.netmonitor.features.requestBlocking", true);

// Enable the Application panel
pref("devtools.application.enabled", true);
pref("devtools.application.selectedSidebar", "service-workers");

// The internal Anti tracking debugging panel
pref("devtools.anti-tracking.enabled", false);

// Session History panel
pref("devtools.application.sessionHistory.enabled", false);

// Enable the custom formatters feature
// This preference represents the user's choice to enable the custom formatters feature.
// While the preference above will be removed once the feature is stable, this one is menat to stay.
pref("devtools.custom-formatters.enabled", false);

// The default Network Monitor UI settings
pref("devtools.netmonitor.panes-network-details-width", 550);
pref("devtools.netmonitor.panes-network-details-height", 450);
pref("devtools.netmonitor.panes-search-width", 550);
pref("devtools.netmonitor.panes-search-height", 450);
pref("devtools.netmonitor.filters", "[\"all\"]");
pref("devtools.netmonitor.requestfilter", "");
pref("devtools.netmonitor.visibleColumns",
    "[\"override\",\"status\",\"method\",\"domain\",\"file\",\"initiator\",\"type\",\"transferred\",\"contentSize\",\"waterfall\"]"
);
pref("devtools.netmonitor.columnsData",
  '[{"name":"override","minWidth":20,"width":2}, {"name":"status","minWidth":30,"width":5}, {"name":"method","minWidth":30,"width":5}, {"name":"domain","minWidth":30,"width":10}, {"name":"file","minWidth":30,"width":25}, {"name":"url","minWidth":30,"width":25},{"name":"initiator","minWidth":30,"width":10},{"name":"type","minWidth":30,"width":5},{"name":"transferred","minWidth":30,"width":10},{"name":"contentSize","minWidth":30,"width":5},{"name":"waterfall","minWidth":150,"width":15}]');
pref("devtools.netmonitor.msg.payload-preview-height", 128);
pref("devtools.netmonitor.msg.visibleColumns",
  '["data", "time"]'
);
pref("devtools.netmonitor.msg.displayed-messages.limit", 500);

pref("devtools.netmonitor.ui.default-raw-response", false);

// Save request/response bodies yes/no.
pref("devtools.netmonitor.saveRequestAndResponseBodies", true);

// The default Network monitor HAR export setting
pref("devtools.netmonitor.har.defaultLogDir", "");
pref("devtools.netmonitor.har.defaultFileName", "%hostname_Archive [%date]");
pref("devtools.netmonitor.har.jsonp", false);
pref("devtools.netmonitor.har.jsonpCallback", "");
pref("devtools.netmonitor.har.includeResponseBodies", true);
pref("devtools.netmonitor.har.compress", false);
pref("devtools.netmonitor.har.forceExport", false);
pref("devtools.netmonitor.har.pageLoadedTimeout", 1500);
pref("devtools.netmonitor.har.enableAutoExportToFile", false);
pref("devtools.netmonitor.har.multiple-pages", false);

// netmonitor audit
pref("devtools.netmonitor.audits.slow", 500);

// Enable the new Edit and Resend panel
pref("devtools.netmonitor.features.newEditAndResend", true);

pref("devtools.netmonitor.customRequest", '{}');

// Enable Netmonitor Web Transport Support
pref("devtools.netmonitor.features.webtransport", false);

// Enable the Storage Inspector
pref("devtools.storage.enabled", true);

// Enable the Style Editor.
pref("devtools.styleeditor.enabled", true);
pref("devtools.styleeditor.autocompletion-enabled", true);
pref("devtools.styleeditor.showAtRulesSidebar", true);
pref("devtools.styleeditor.atRulesSidebarWidth", 238);
pref("devtools.styleeditor.navSidebarWidth", 245);
pref("devtools.styleeditor.transitions", true);

// Screenshot Option Settings.
pref("devtools.screenshot.clipboard.enabled", false);
pref("devtools.screenshot.audio.enabled", true);

// Make sure the DOM panel is hidden by default
pref("devtools.dom.enabled", false);

// Enable the Accessibility panel.
pref("devtools.accessibility.enabled", true);

// Web console filters
pref("devtools.webconsole.filter.error", true);
pref("devtools.webconsole.filter.warn", true);
pref("devtools.webconsole.filter.info", true);
pref("devtools.webconsole.filter.log", true);
pref("devtools.webconsole.filter.debug", true);
pref("devtools.webconsole.filter.css", false);
pref("devtools.webconsole.filter.net", false);
pref("devtools.webconsole.filter.netxhr", false);
pref("devtools.webconsole.filter.chrome", true);
pref("devtools.webconsole.filter.content", true);

// Webconsole autocomplete preference
pref("devtools.webconsole.input.autocomplete",true);

// Set to true to eagerly show the results of webconsole terminal evaluations
// when they don't have side effects.
pref("devtools.webconsole.input.eagerEvaluation", true);

// Browser console filters
pref("devtools.browserconsole.filter.error", true);
pref("devtools.browserconsole.filter.warn", true);
pref("devtools.browserconsole.filter.info", true);
pref("devtools.browserconsole.filter.log", true);
pref("devtools.browserconsole.filter.debug", true);
pref("devtools.browserconsole.filter.css", false);
pref("devtools.browserconsole.filter.net", false);
pref("devtools.browserconsole.filter.netxhr", false);
// Origin filters allow to separately show or hide messages emitted by the
// browser itself (privileged code) and those emitted by web content.
pref("devtools.browserconsole.filter.chrome", true);
pref("devtools.browserconsole.filter.content", true);

// Max number of inputs to store in web console history.
pref("devtools.webconsole.inputHistoryCount", 300);

// Persistent logging: |true| if you want the relevant tool to keep all of the
// logged messages after reloading the page, |false| if you want the output to
// be cleared each time page navigation happens.
pref("devtools.webconsole.persistlog", false);
pref("devtools.netmonitor.persistlog", false);

// Web Console timestamp: |true| if you want the logs and instructions
// in the Web Console to display a timestamp, or |false| to not display
// any timestamps.
pref("devtools.webconsole.timestampMessages", false);

// Enable the webconsole sidebar toggle in Nightly builds.
#if defined(NIGHTLY_BUILD)
  pref("devtools.webconsole.sidebarToggle", true);
#else
  pref("devtools.webconsole.sidebarToggle", false);
#endif

// Saved editor mode state in the console.
pref("devtools.webconsole.input.editor", false);
pref("devtools.browserconsole.input.editor", false);

// Editor width for webconsole and browserconsole.
pref("devtools.webconsole.input.editorWidth", 0);
pref("devtools.browserconsole.input.editorWidth", 0);

// Display an onboarding UI for the Editor mode.
pref("devtools.webconsole.input.editorOnboarding", true);

// Enable grouping/repeating similar messages in the console, true by default
pref("devtools.webconsole.groupSimilarMessages", true);

// Enable codemirror 6 for the JSTerminal in the console
pref("devtools.webconsole.codemirrorNext", false);

// Enable network monitoring the browser toolbox console/browser console.
pref("devtools.browserconsole.enableNetworkMonitoring", false);

// Enable client-side mapping service for source maps
pref("devtools.source-map.client-service.enabled", true);

// The number of lines that are displayed in the web console.
pref("devtools.hud.loglimit", 10000);

// The developer tools editor configuration:
// - tabsize: how many spaces to use when a Tab character is displayed.
// - expandtab: expand Tab characters to spaces.
// - keymap: which keymap to use (can be 'default', 'emacs' or 'vim')
// - autoclosebrackets: whether to permit automatic bracket/quote closing.
// - detectindentation: whether to detect the indentation from the file
// - enableCodeFolding: Whether to enable code folding or not.
pref("devtools.editor.tabsize", 2);
pref("devtools.editor.expandtab", true);
pref("devtools.editor.keymap", "default");
pref("devtools.editor.autoclosebrackets", true);
pref("devtools.editor.detectindentation", true);
pref("devtools.editor.enableCodeFolding", true);
pref("devtools.editor.autocomplete", true);

// The angle of the viewport.
pref("devtools.responsive.viewport.angle", 0);
// The width of the viewport.
pref("devtools.responsive.viewport.width", 320);
// The height of the viewport.
pref("devtools.responsive.viewport.height", 480);
// The pixel ratio of the viewport.
pref("devtools.responsive.viewport.pixelRatio", 0);
// Whether or not the viewports are left aligned.
pref("devtools.responsive.leftAlignViewport.enabled", false);
// Whether to reload when touch simulation is toggled
pref("devtools.responsive.reloadConditions.touchSimulation", false);
// Whether to reload when user agent is changed
pref("devtools.responsive.reloadConditions.userAgent", false);
// Whether to show the notification about reloading to apply emulation
pref("devtools.responsive.reloadNotification.enabled", true);
// Whether or not touch simulation is enabled.
pref("devtools.responsive.touchSimulation.enabled", false);
// The user agent of the viewport.
pref("devtools.responsive.userAgent", "");
// Show the custom user agent input by default
pref("devtools.responsive.showUserAgentInput", true);
// Whether to show the RDM dynamic toolbar
pref("devtools.responsive.dynamicToolbar.enabled", false);
// Whether the RDM dynamic toolbar is on the top (false = on bottom)
pref("devtools.responsive.dynamicToolbar.onTop", false);

// Show tab debug targets for This Firefox (on by default for local builds).
#ifdef MOZILLA_OFFICIAL
  pref("devtools.aboutdebugging.local-tab-debugging", false);
#else
  pref("devtools.aboutdebugging.local-tab-debugging", true);
#endif

// Show process debug targets.
pref("devtools.aboutdebugging.process-debugging", true);
// Stringified array of network locations that users can connect to.
pref("devtools.aboutdebugging.network-locations", "[]");
// Debug target pane collapse/expand settings.
pref("devtools.aboutdebugging.collapsibilities.installedExtension", false);
pref("devtools.aboutdebugging.collapsibilities.otherWorker", false);
pref("devtools.aboutdebugging.collapsibilities.serviceWorker", false);
pref("devtools.aboutdebugging.collapsibilities.sharedWorker", false);
pref("devtools.aboutdebugging.collapsibilities.tab", false);
pref("devtools.aboutdebugging.collapsibilities.temporaryExtension", false);

// about:debugging: only show system and hidden extensions in local builds by
// default.
#ifdef MOZILLA_OFFICIAL
  pref("devtools.aboutdebugging.showHiddenAddons", false);
#else
  pref("devtools.aboutdebugging.showHiddenAddons", true);
#endif

// Add some extra logging to the console, for debugging
pref("devtools.aboutdebugging.showReduxActionsInConsole", false);

// Map top-level await expressions in the console
pref("devtools.debugger.features.map-await-expression", true);

// This relies on javascript.options.asyncstack as well or it has no effect.
pref("devtools.debugger.features.async-captured-stacks", true);
pref("devtools.debugger.features.async-live-stacks", false);

// This supports showing stylesheet sources in the debugger
pref("devtools.debugger.features.stylesheets-in-debugger", false);

// When debugging a website, this pref controls if extension content scripts applied
// to the currently debugged page should be shown in the Debugger Source Tree
pref("devtools.debugger.show-content-scripts", false);

pref("devtools.debugger.hide-ignored-sources", false);

// Disable autohide for DevTools popups and tooltips.
// This is currently not exposed by any UI to avoid making
// about:devtools-toolbox tabs unusable by mistake.
pref("devtools.popup.disable_autohide", false);

// Add support for high contrast mode
#if defined(NIGHTLY_BUILD)
  pref("devtools.high-contrast-mode-support", true);
#else
  pref("devtools.high-contrast-mode-support", false);
#endif

