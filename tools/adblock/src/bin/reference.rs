/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Reference verdicts for the network blocker's tests.
//!
//!   reference [--write]
//!
//! Hand cases (tests/blocker/hand-cases.json): their expectations come from
//! filter semantics; this runs them through adblock-rust and reports any
//! disagreement (exit 1).
//!
//! Generated cases (tests/blocker/cases.json, requests recorded on real
//! pages): adblock-rust's own verdicts, in Standard mode (no social list),
//! go to tests/blocker/cases-expected.json with --write; without it, the
//! file is checked against a fresh run (exit 1 on any difference). The
//! browser test (tools/runtime/check.py part 7) compares Gecko's results
//! with both files.

use browserwip_adblock_tools as tools;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

fn load(path: &PathBuf) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn verdict(b: bool) -> &'static str {
    if b {
        "block"
    } else {
        "allow"
    }
}

fn main() {
    let write = std::env::args().any(|a| a == "--write");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let lists = root.join("app/components/contentblocking/lists");
    let tests = root.join("tests/blocker");

    let engines = tools::build_engines(&lists, false);
    let kept = tools::build_engines(&lists, true);
    println!(
        "engine: adblock 0.12.1 (full-regex-handling, single-thread), lists: {} ads/trackers rules, {} social rules",
        engines.main_rules.rules.len(),
        engines.social_rules.rules.len()
    );
    println!(
        "dropped {} $redirect rules (phase 2 re-enables them) and {} element-hiding rules",
        engines.main_rules.dropped_redirect + engines.social_rules.dropped_redirect,
        engines.main_rules.dropped_cosmetic + engines.social_rules.dropped_cosmetic
    );

    let mut failed = false;
    println!("\nhand cases: expectation (filter semantics) vs adblock-rust");
    let hand = load(&tests.join("hand-cases.json"));
    let (mut agree, mut disagree, mut skipped) = (0, 0, 0);
    for case in hand["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let kind = case["kind"].as_str().unwrap();
        let url = case["url"].as_str().unwrap();
        let page = case["page"].as_str().unwrap();
        let expect = case["expect"].as_str().unwrap();
        let social = case["social"].as_bool().unwrap_or(false);
        let Some(main) = tools::reference_blocks(&engines.main, url, page, kind) else {
            println!("  {id}  {kind:11} expect {expect}  not an engine check (browser policy), skipped");
            skipped += 1;
            continue;
        };
        let social_verdict = tools::reference_blocks(&engines.social, url, page, kind).unwrap();
        let with_redirect = tools::reference_blocks(&kept.main, url, page, kind).unwrap();
        let ok = verdict(main) == expect && (!social || social_verdict);
        if ok {
            agree += 1;
        } else {
            disagree += 1;
            failed = true;
        }
        let mut notes = String::new();
        if social {
            notes += &format!(", social list: {}", verdict(social_verdict));
        }
        if with_redirect != main {
            notes += &format!(", with $redirect rules kept: {}", verdict(with_redirect));
        }
        println!(
            "  {id}  {kind:11} expect {expect}  adblock-rust {}{notes}  {}",
            verdict(main),
            if ok { "agree" } else { "DISAGREE" }
        );
    }
    println!("hand cases: {agree} agree, {disagree} disagree, {skipped} skipped");

    let cases = load(&tests.join("cases.json"));
    let mut verdicts = Map::new();
    let (mut blocked, mut total) = (0, 0);
    for case in cases["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let b = tools::reference_blocks(
            &engines.main,
            case["url"].as_str().unwrap(),
            case["page"].as_str().unwrap(),
            case["kind"].as_str().unwrap(),
        )
        .unwrap_or_else(|| panic!("{id}: not an engine check"));
        total += 1;
        blocked += b as u32;
        verdicts.insert(id.to_string(), json!(verdict(b)));
    }
    println!("\ngenerated cases: {total}, adblock-rust blocks {blocked}");
    let expected_path = tests.join("cases-expected.json");
    let fresh = json!({
        "about": "adblock-rust 0.12.1's verdicts for tests/blocker/cases.json in Standard mode (main lists only, $redirect rules left out). Written by tools/adblock (cargo run --release --bin reference -- --write).",
        "verdicts": verdicts,
    });
    if write {
        std::fs::write(&expected_path, serde_json::to_string_pretty(&fresh).unwrap() + "\n").unwrap();
        println!("wrote {}", expected_path.display());
    } else {
        let old = load(&expected_path);
        let mut differ = 0;
        for (id, v) in fresh["verdicts"].as_object().unwrap() {
            if old["verdicts"].get(id) != Some(v) {
                println!("  {id}: committed {}, now {v}", old["verdicts"].get(id).unwrap_or(&Value::Null));
                differ += 1;
            }
        }
        println!("generated cases: {differ} differ from {}", expected_path.display());
        failed |= differ > 0;
    }
    std::process::exit(failed as i32);
}
