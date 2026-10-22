/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Feeds the FFI's calls odd input, with the engines built from the full
//! bundled lists.
//!
//!   stress [SECONDS] [SEED]
//!
//! Gecko builds Rust with panic = "abort", so a panic in adblock-rust takes
//! the browser down. The FFI crate itself needs XPCOM and cannot be built
//! alone; this runs the exact calls it makes (tools::ffi_check) on the same
//! adblock-rust version and features. Panics are caught here so every
//! offending input is reported; any panic fails the run.

use browserwip_adblock_tools as tools;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::time::{Duration, Instant};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T {
        &v[self.below(v.len())]
    }
}

const TYPES: [&str; 16] = [
    "script", "image", "stylesheet", "xmlhttprequest", "subdocument", "ping", "media", "font",
    "websocket", "csp_report", "object", "other", "document", "", "SCRIPT", "\u{0}garbage\u{fffd}",
];

const ODD_HOSTS: [&str; 14] = [
    "", ".", "..", "-", "localhost", "127.0.0.1", "[::1]", "::1", "xn--bcher-kva.example",
    "bücher.example", "例え.テスト", "a..b", "com", "x\u{0}y",
];

const ODD_URLS: [&str; 22] = [
    "", "http", "http:", "http://", "https:///", "://", "http://:80/", "http://@/",
    "http://[::1", "http://[::1]:99999999/x", "http://a:b@c:d@e/", "http://xn--/",
    "http://bücher.example/ad.js", "http://例え.テスト/広告", "https://%00/%ff",
    "ws://ads.example/socket", "data:text/html,<script>", "javascript:alert(1)",
    "http://||^$*|/", "\u{0}http://x/", "http://x/\u{0}/y", "?$=&#",
];

fn hosts_from_lists(text: &str) -> Vec<String> {
    let mut hosts: Vec<String> = text
        .lines()
        .filter_map(|l| l.strip_prefix("||"))
        .map(|l| l.split(|c| c == '^' || c == '/' || c == '$' || c == '*').next().unwrap_or("").to_string())
        .filter(|h| !h.is_empty())
        .collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

/// Up to `max` bytes of URL-ish junk.
fn junk(rng: &mut Rng, max: usize) -> Vec<u8> {
    let len = rng.below(max);
    const CHARS: &[u8] = b"abcxyz0123456789-._~:/?#[]@!$&'()*+,;=%^|\\\" <>{}`\x00\xff\xc3\xa9\xe4\xbe\x8b";
    (0..len).map(|_| CHARS[rng.below(CHARS.len())]).collect()
}

struct Input {
    url: Vec<u8>,
    host: Vec<u8>,
    source: Vec<u8>,
    ty: Vec<u8>,
    third_party: bool,
}

fn generate(rng: &mut Rng, hosts: &[String]) -> Input {
    let host = rng.pick(hosts).clone();
    let source = if rng.below(4) == 0 { rng.pick(&ODD_HOSTS).to_string() } else { rng.pick(hosts).clone() };
    let ty = rng.pick(&TYPES).as_bytes().to_vec();
    let third_party = rng.below(2) == 0;
    let path = String::from_utf8_lossy(&junk(rng, 60)).to_string();
    let (url, host) = match rng.below(10) {
        // Well formed, host matching the URL.
        0 | 1 | 2 => (format!("https://{host}/{path}").into_bytes(), host.into_bytes()),
        // Host not the URL's host, or odd.
        3 => (format!("https://{host}/{path}").into_bytes(), rng.pick(&ODD_HOSTS).as_bytes().to_vec()),
        4 => (format!("https://{}/{path}", rng.pick(&ODD_HOSTS)).into_bytes(), rng.pick(&ODD_HOSTS).as_bytes().to_vec()),
        // Very long: up to 2 MB of path.
        5 => {
            let n = if rng.below(50) == 0 { 2 << 20 } else { 1 + rng.below(64 << 10) };
            let mut u = format!("https://{host}/").into_bytes();
            u.extend(std::iter::repeat(b'a' + (rng.below(26) as u8)).take(n));
            (u, host.into_bytes())
        }
        // Long host.
        6 => {
            let long: String = std::iter::repeat("sub.").take(1 + rng.below(4000)).collect::<String>() + &host;
            (format!("http://{long}/x").into_bytes(), long.into_bytes())
        }
        // Malformed URLs.
        7 => (rng.pick(&ODD_URLS).as_bytes().to_vec(), rng.pick(&ODD_HOSTS).as_bytes().to_vec()),
        // Random bytes everywhere, including invalid UTF-8.
        8 => (junk(rng, 300), junk(rng, 40)),
        // Empty.
        _ => (vec![], vec![]),
    };
    let source = if rng.below(10) == 0 { junk(rng, 40) } else { source.into_bytes() };
    Input { url, host, source, ty, third_party }
}

fn show(b: &[u8]) -> String {
    let s = String::from_utf8_lossy(&b[..b.len().min(120)]).to_string();
    if b.len() > 120 {
        format!("{s:?}... ({} bytes)", b.len())
    } else {
        format!("{s:?}")
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(60);
    let seed: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0x9e3779b97f4a7c15);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let lists = root.join("app/components/contentblocking/lists");

    let t = Instant::now();
    let engines = tools::build_engines(&lists, false);
    println!(
        "engines from the full lists in {:.0} ms: {} + {} rules (dropped {} $redirect, {} element-hiding)",
        t.elapsed().as_secs_f64() * 1000.0,
        engines.main_rules.rules.len(),
        engines.social_rules.rules.len(),
        engines.main_rules.dropped_redirect + engines.social_rules.dropped_redirect,
        engines.main_rules.dropped_cosmetic + engines.social_rules.dropped_cosmetic
    );
    let mut text = tools::read_lists(&lists, &tools::MAIN_LISTS);
    text += &tools::read_lists(&lists, &tools::SOCIAL_LISTS);
    let hosts = hosts_from_lists(&text);
    println!("{} hosts from the lists' ||host rules seed the URLs; seed {seed}, {seconds} s", hosts.len());

    // Report each panic once, with its message, instead of the default
    // backtrace spam; the input is printed by the loop.
    std::panic::set_hook(Box::new(|info| eprintln!("panic: {info}")));

    let mut rng = Rng(seed);
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let (mut runs, mut blocked, mut panics) = (0u64, 0u64, 0u64);
    let mut slowest = (Duration::ZERO, String::new());
    let mut bytes = 0u64;

    // Every fixed odd input first, against both engines.
    let mut fixed = vec![];
    for url in ODD_URLS {
        for host in ODD_HOSTS {
            fixed.push(Input { url: url.as_bytes().to_vec(), host: host.as_bytes().to_vec(),
                               source: host.as_bytes().to_vec(), ty: b"script".to_vec(), third_party: true });
        }
    }
    let fixed_count = fixed.len();
    let mut fixed = fixed.into_iter();

    while Instant::now() < deadline {
        let input = fixed.next().unwrap_or_else(|| generate(&mut rng, &hosts));
        for engine in [&engines.main, &engines.social] {
            let start = Instant::now();
            let result = catch_unwind(AssertUnwindSafe(|| {
                tools::ffi_check(engine, &input.url, &input.host, &input.source, &input.ty, input.third_party)
            }));
            let took = start.elapsed();
            runs += 1;
            bytes += input.url.len() as u64;
            match result {
                Ok(r) => blocked += r.matched as u64,
                Err(_) => {
                    panics += 1;
                    println!(
                        "PANIC on url={} host={} source={} type={} third_party={}",
                        show(&input.url), show(&input.host), show(&input.source), show(&input.ty), input.third_party
                    );
                }
            }
            if took > slowest.0 {
                slowest = (took, format!("url {} ({} bytes), type {}", show(&input.url[..input.url.len().min(60)]), input.url.len(), show(&input.ty)));
            }
        }
    }
    println!(
        "{runs} checks ({fixed_count} fixed odd inputs x 2 engines, the rest generated) in {seconds} s, {:.0} MB of URLs",
        bytes as f64 / 1e6
    );
    println!("blocked {blocked}, panics {panics}");
    println!("slowest check {:.1} ms: {}", slowest.0.as_secs_f64() * 1000.0, slowest.1);
    std::process::exit(if panics > 0 { 1 } else { 0 });
}
