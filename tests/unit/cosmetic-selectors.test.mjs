// Element-hiding selection, against lists compiled by run.sh into $CB_OUT.
globalThis.Ci = { nsIStyleSheetService: { AGENT_SHEET: 0 } };
globalThis.JSWindowActorChild = class {};
const { selectorsForHost } = await import(
  "../../app/components/contentblocking/ContentBlockingChild.sys.mjs"
);
const fs = await import("node:fs");
const index = JSON.parse(fs.readFileSync(`${process.env.CB_OUT}/cosmetic-sites.json`, "utf8"));
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };

const site = Object.keys(index.specific).find(d => index.specific[d].length > 3);
const onSub = selectorsForHost("www." + site, index);
assert(index.specific[site].every(s => onSub.selectors.includes(s)), "site rules apply to its subdomains");

const [exHost, exSelectors] = Object.entries(index.specificExcept)[0];
assert(!exSelectors.some(s => selectorsForHost(exHost, index).selectors.includes(s)), "site exceptions are honored");

assert(index.noGeneric.length > 0 && !selectorsForHost(index.noGeneric[0], index).useGeneric, "$generichide sites skip the generic sheet");

const [cond, condDomains] = Object.entries(index.conditionalGeneric)[0];
assert(!selectorsForHost(condDomains[0], index).selectors.includes(cond), "generic rule skipped on its excepted site");
assert(selectorsForHost("unrelated.example", index).selectors.includes(cond), "generic rule with exceptions still applies elsewhere");

const css = fs.readFileSync(`${process.env.CB_OUT}/cosmetic-generic.css`, "utf8");
assert(!css.includes(`\n${cond}{`) && !css.startsWith(`${cond}{`), "excepted generic rule is not in the shared sheet");
