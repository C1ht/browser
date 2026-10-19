/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! What the network blocker does with the lists, outside Gecko.

use std::path::Path;

/// The lists the blocker's two engines are built from, in the order
/// ContentBlockingLists.sys.mjs joins them.
pub const MAIN_LISTS: [&str; 2] = ["easylist.txt", "easyprivacy.txt"];
pub const SOCIAL_LISTS: [&str; 1] = ["fanboy-social.txt"];

pub struct Rules {
    pub rules: Vec<String>,
    pub dropped_redirect: u32,
    pub dropped_cosmetic: u32,
}

fn is_cosmetic(line: &str) -> bool {
    ["##", "#@#", "#?#", "#@?#", "#$#", "#@$#", "#%#", "#@%#"]
        .iter()
        .any(|m| line.contains(m))
}

fn is_redirect(line: &str) -> bool {
    match line.rfind('$') {
        Some(i) => line[i + 1..]
            .split(',')
            .any(|o| o.starts_with("redirect=") || o.starts_with("redirect-rule=")),
        None => false,
    }
}

/// NetworkBlocker::SplitRules, line for line. `keep_redirect` builds what
/// the engine would be with the $redirect rules left in.
pub fn split_rules(text: &str, keep_redirect: bool) -> Rules {
    let mut out = Rules { rules: vec![], dropped_redirect: 0, dropped_cosmetic: 0 };
    for raw in text.split('\n') {
        let line = raw.trim_matches(|c| c == ' ' || c == '\t' || c == '\r');
        if line.is_empty() || line.starts_with('!') || line.starts_with('[') {
            continue;
        }
        if is_cosmetic(line) {
            out.dropped_cosmetic += 1;
            continue;
        }
        if !keep_redirect && is_redirect(line) {
            out.dropped_redirect += 1;
            continue;
        }
        out.rules.push(line.to_string());
    }
    out
}

/// Gecko resolves domains with nsIEffectiveTLDService; the public suffix
/// list from the psl crate stands in for it.
struct Psl;
impl adblock::url_parser::ResolvesDomain for Psl {
    fn get_host_domain(&self, host: &str) -> (usize, usize) {
        match psl::domain_str(host) {
            Some(d) if d.len() <= host.len() => (host.len() - d.len(), host.len()),
            _ => (0, host.len()),
        }
    }
}

pub fn set_resolver() {
    let _ = adblock::url_parser::set_domain_resolver(Box::new(Psl));
}

pub fn site_of(host: &str) -> String {
    psl::domain_str(host).unwrap_or(host).to_string()
}

pub fn read_lists(dir: &Path, names: &[&str]) -> String {
    names
        .iter()
        .map(|n| std::fs::read_to_string(dir.join(n)).unwrap_or_else(|e| panic!("{n}: {e}")))
        .collect::<Vec<_>>()
        .join("\n")
}

pub struct Engines {
    pub main: adblock::Engine,
    pub social: adblock::Engine,
    pub main_rules: Rules,
    pub social_rules: Rules,
}

pub fn build_engines(dir: &Path, keep_redirect: bool) -> Engines {
    set_resolver();
    let main_rules = split_rules(&read_lists(dir, &MAIN_LISTS), keep_redirect);
    let social_rules = split_rules(&read_lists(dir, &SOCIAL_LISTS), keep_redirect);
    let opts = adblock::lists::ParseOptions::default();
    Engines {
        main: adblock::Engine::from_rules(main_rules.rules.clone(), opts),
        social: adblock::Engine::from_rules(social_rules.rules.clone(), opts),
        main_rules,
        social_rules,
    }
}

/// The adblock request type a test case's kind of request has in Gecko
/// (NetworkBlocker.cpp, RequestType).
pub fn request_type(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "script" => "script",
        "image" => "image",
        "stylesheet" => "stylesheet",
        "xhr" | "fetch" => "xmlhttprequest",
        "subdocument" => "subdocument",
        "beacon" => "ping",
        "media" => "media",
        "font" => "font",
        _ => return None,
    })
}

/// adblock-rust's own reading of a request: it parses the URLs, works out
/// the hosts and third-partiness itself, and runs its full check.
pub fn reference_blocks(engine: &adblock::Engine, url: &str, page: &str, kind: &str) -> Option<bool> {
    let ty = request_type(kind)?;
    let request = adblock::request::Request::new(url, page, ty).ok()?;
    Some(engine.check_network_request(&request).matched)
}

/// Exactly the calls content_classifier_engine_check_network_request_preparsed
/// makes, with the strings the FFI would receive.
pub fn ffi_check(
    engine: &adblock::Engine,
    url: &[u8],
    host: &[u8],
    source_host: &[u8],
    ty: &[u8],
    third_party: bool,
) -> adblock::blocker::BlockerResult {
    let url = String::from_utf8_lossy(url).to_string();
    let host = String::from_utf8_lossy(host).to_string();
    let source_host = String::from_utf8_lossy(source_host).to_string();
    let ty = String::from_utf8_lossy(ty).to_string();
    let request = adblock::request::Request::preparsed(&url, &host, &source_host, &ty, third_party);
    engine.check_network_request_subset(&request, false, false)
}
