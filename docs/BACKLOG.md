# Backlog

Agreed work that isn't scheduled yet.

- **Clear site data.** A per-site and an all-sites "Clear site data" (cookies, storage, cache, permissions), which also clears the new tab page's favorite icons (`SiteIcons.clear()` / `SiteIcons.forget()`). Today only Clear history → All clears them.
- **Decode favorite icons in a content process.** `SiteIcons.sys.mjs` decodes and re-encodes icons in the parent process, as tab icons are drawn there today (decoders listed in PLAN.md §7). Moving the decode and re-encode into a sandboxed content process would keep a decoder bug out of the parent.
