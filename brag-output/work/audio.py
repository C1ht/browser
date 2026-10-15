# Music + SFX, one mix. A minor, 120 BPM (beat = 0.5s), 23s.
import numpy as np, wave
SR = 48000; DUR = 23.0; N = int(SR * DUR)
rng = np.random.default_rng(7)
def mtof(m): return 440.0 * 2 ** ((m - 69) / 12)
def env(n, a, r):
    e = np.ones(n); ai = max(1, int(a * SR)); e[:ai] = np.linspace(0, 1, ai)
    ri = max(1, int(r * SR)); e[-ri:] *= np.linspace(1, 0, ri); return e
def lp(x, fc):
    a = np.exp(-2 * np.pi * fc / SR); y = np.empty_like(x); s = 0.0
    for i in range(len(x)): s = (1 - a) * x[i] + a * s; y[i] = s
    return y
def lp_fast(x, fc, passes=2):
    # cheap smoothing via cumulative moving average approximation of one-pole
    k = max(1, int(SR / (2 * np.pi * fc)))
    for _ in range(passes):
        c = np.cumsum(np.concatenate([np.zeros(k), x])); x = (c[k:] - c[:-k]) / k
    return x
mus = np.zeros((N, 2)); sfx = np.zeros((N, 2))
def add(buf, start, sig, pan=0.0, gain=1.0):
    i = int(start * SR); j = min(N, i + len(sig))
    if j <= i: return
    l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
    buf[i:j, 0] += sig[:j - i] * gain * l * 1.414; buf[i:j, 1] += sig[:j - i] * gain * r * 1.414

chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]]  # Am F C G
roots = [45, 41, 36, 43]
def bar_of(t): return int(t // 2) % 4

# Pad: detuned saws, lowpassed, whole track
t_all = np.arange(N) / SR
for b in range(12):
    t0 = b * 2.0
    if t0 >= DUR: break
    ch = chords[b % 4] if t0 < 20 else [57, 60, 64, 69]
    length = 2.2 if t0 < 20 else DUR - t0
    n = int(length * SR); tt = np.arange(n) / SR
    sig = np.zeros(n)
    for m in ch:
        for d in (-0.08, 0.08):
            f = mtof(m + d); sig += 2 * ((tt * f) % 1) - 1
    sig = lp_fast(sig, 900 if 3.5 <= t0 < 20 else 600) / 8
    e = env(n, 0.25, 0.3)
    add(mus, t0, sig * e, pan=0, gain=0.22)
mus[:, :] *= np.clip(t_all / 1.2, 0, 1)[:, None]  # fade in

def pluck(m, dur=0.35, bright=1.0):
    n = int(dur * SR); tt = np.arange(n) / SR; f = mtof(m)
    s = np.sin(2 * np.pi * f * tt) + 0.35 * bright * np.sin(4 * np.pi * f * tt) + 0.12 * bright * np.sin(6 * np.pi * f * tt)
    return s * np.exp(-tt * 9) * env(n, 0.003, 0.05)

# Arp: 8ths from 3.5 to 16.5 and 18 to 20; quieter in hook (sparse quarter notes)
pattern = [0, 2, 1, 3, 2, 1, 3, 2]
for k in range(int(DUR / 0.25)):
    t0 = k * 0.25
    ch = chords[bar_of(t0)]
    if t0 < 3.5:
        if k % 4 == 0 and t0 >= 0.5: add(mus, t0, pluck(ch[pattern[k % 8]] + 12, 0.5, 0.6), pan=-0.2, gain=0.12)
    elif t0 < 16.5 or 18.0 <= t0 < 20.0:
        add(mus, t0, pluck(ch[pattern[k % 8]] + 12), pan=0.25 if k % 2 else -0.25, gain=0.13)

def kick():
    n = int(0.35 * SR); tt = np.arange(n) / SR
    f = 45 + 80 * np.exp(-tt * 30); ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-tt * 9)
def hat():
    n = int(0.06 * SR); x = rng.standard_normal(n); x = x - lp_fast(x, 6000, 1)
    return x * np.exp(-np.arange(n) / SR * 70)
for k in range(int(DUR / 0.5)):
    t0 = k * 0.5
    if 3.5 <= t0 < 16.5 or 18.0 <= t0 < 20.0:
        add(mus, t0, kick(), gain=0.42)
    if 7.5 <= t0 < 16.5 or 18.0 <= t0 < 20.0:
        add(mus, t0 + 0.25, hat(), pan=0.3, gain=0.05)
# Bass: root on each beat, sine + soft harmonic
for k in range(int(DUR / 0.5)):
    t0 = k * 0.5
    if 3.5 <= t0 < 16.5 or 18.0 <= t0 < 20.0:
        n = int(0.45 * SR); tt = np.arange(n) / SR; f = mtof(roots[bar_of(t0)])
        s = (np.sin(2 * np.pi * f * tt) + 0.25 * np.sin(4 * np.pi * f * tt)) * env(n, 0.01, 0.15)
        add(mus, t0, s, gain=0.2)
# Riser into PASS (16.5 -> 18.0)
n = int(1.5 * SR); tt = np.arange(n) / SR
x = rng.standard_normal(n); x = lp_fast(x, 1200, 1) * (tt / 1.5) ** 2
add(mus, 16.5, x, gain=0.25)
# Hits: PASS (18.0) and outro (20.0): chord stab + kick
def stab(ch, dur=2.5):
    n = int(dur * SR); tt = np.arange(n) / SR; s = np.zeros(n)
    for m in ch: s += np.sin(2 * np.pi * mtof(m) * tt) + 0.3 * np.sin(4 * np.pi * mtof(m) * tt)
    return s / len(ch) * np.exp(-tt * 1.6)
add(mus, 18.0, kick(), gain=0.55); add(mus, 18.0, stab([69, 72, 76, 81], 1.8), gain=0.16)
add(mus, 20.0, kick(), gain=0.5); add(mus, 20.0, stab([57, 64, 69, 72, 76], 3.0), gain=0.2)
add(mus, 20.0, pluck(81, 2.5, 0.4) * 1.0, gain=0.12); add(mus, 21.0, pluck(88, 2.0, 0.3), pan=0.3, gain=0.07)

# ---------- SFX (in key, soft) ----------
def tick(m=81, g=1.0):
    n = int(0.12 * SR); tt = np.arange(n) / SR
    return np.sin(2 * np.pi * mtof(m) * tt) * np.exp(-tt * 40) * g
def click():
    n = int(0.03 * SR); x = rng.standard_normal(n); x = lp_fast(x, 3000, 1)
    return x * np.exp(-np.arange(n) / SR * 160)
strike_notes = [69, 72, 76, 79, 81, 84]
for i, m in enumerate(strike_notes): add(sfx, 1.5 + i * 0.22, tick(m), pan=-0.5 + i * 0.2, gain=0.16)
# whoosh into reveal
n = int(0.6 * SR); tt = np.arange(n) / SR
x = lp_fast(rng.standard_normal(n), 900, 2) * np.sin(np.pi * tt / 0.6) ** 2
add(sfx, 3.15, x, gain=0.5)
add(sfx, 3.6, tick(57, 1.0), gain=0.12)
for i in range(22): add(sfx, 7.9 + i * 0.05, click(), pan=0.1, gain=0.12 + 0.03 * rng.random())
add(sfx, 9.1, click(), gain=0.25)
for i in range(14): add(sfx, 9.5 + i * (1.0 / 13), tick(88 if i % 2 else 86, 1), pan=0.35, gain=0.05)
add(sfx, 10.6, tick(76) + 0.0, pan=0.3, gain=0.14); add(sfx, 10.63, tick(81), pan=0.3, gain=0.1)
for t0 in (14.45, 15.25):
    add(sfx, t0, click(), gain=0.3); add(sfx, t0, tick(76 if t0 < 15 else 81), gain=0.08)
for i in range(34): add(sfx, 16.75 + i * 0.02, click(), pan=-0.1, gain=0.06)
add(sfx, 18.0, tick(93), gain=0.1)

mix = mus * 0.9 + sfx
# gentle glue: soft clip + normalize to -1 dBFS
mix = np.tanh(mix * 1.1) / np.tanh(1.1)
mix *= 10 ** (-1 / 20) / np.max(np.abs(mix))
fade = np.clip((DUR - t_all) / 0.6, 0, 1); mix *= fade[:, None]
pcm = (mix * 32767).astype('<i2')
with wave.open('audio.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('ok')
