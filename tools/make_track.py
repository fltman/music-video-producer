#!/usr/bin/env python3
"""Syntetiserar demospåret ``assets/track.wav``.

Ett 4/4-spår på 128 BPM, 32 takter (exakt 60 sekunder), 44100 Hz, 16-bitars
stereo. Trumelementen är medvetet lagda i tydligt åtskilda frekvensband så att
oscillatorerna i musikvideoproducenten har något distinkt att trigga på:

    bastrumma   35–110 Hz    sinus 55→40 Hz med snabb dämpning, lågpassad
    basgång     100–150 Hz   ren sinus, en ton per takt
    virvel      180–620 Hz   bandpassat brus + kropp på 190/260 Hz
    ackordstick 590–1870 Hz  rena sinustoner, var åttonde takt
    hi-hat      8–14 kHz     högpassat brus

Bandpassen är branta just för att grannbanden ska vara tomma: ett gate på
180–400 Hz ska höra virveln och ingenting annat.

Determinism (CONTRACT.md §2): allt brus kommer ur en egen seedad LCG. Ingen
användning av ``random`` och inga systemberoenden — bara Python 3 stdlib.

Körs som ``python3 tools/make_track.py [utfil]``.
"""

import array
import math
import os
import sys
import wave

# ---------------------------------------------------------------- grundmått

SR = 44100
BPM = 128.0
BARS = 32
BEATS_PER_BAR = 4
SEC_PER_BEAT = 60.0 / BPM              # 0,46875 s
SEC_PER_BAR = SEC_PER_BEAT * BEATS_PER_BAR   # 1,875 s
DURATION = BARS * SEC_PER_BAR          # exakt 60,0 s
TOTAL = int(round(DURATION * SR))      # 2 646 000 sampel

FADE_IN = 0.05
FADE_OUT = 1.80
TARGET_DBFS = -1.0                     # normaliseringsmål

# Mixnivåer före normalisering.
GAIN_KICK = 0.95
GAIN_BASS = 0.46
GAIN_SNARE = 0.52
GAIN_HAT_CLOSED = 0.17
GAIN_HAT_OPEN = 0.21
GAIN_CHORD = 0.50


# ------------------------------------------------------------------ slumpen

class Lcg:
    """Linjär kongruensgenerator (samma konstanter som glibc). Seedad, alltid."""

    def __init__(self, seed):
        self.state = seed & 0xFFFFFFFF

    def bipolar(self):
        """Nästa tal i [-1, 1)."""
        self.state = (self.state * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.state / 2147483648.0 - 1.0


# ------------------------------------------------------------------- filter

def biquad_lowpass(f0, q):
    """RBJ-lågpass. Returnerar (b0, b1, b2, a1, a2) normaliserade mot a0."""
    w0 = 2.0 * math.pi * f0 / SR
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2.0 * q)
    b0 = (1.0 - cw) / 2.0
    b1 = 1.0 - cw
    b2 = b0
    a0 = 1.0 + alpha
    a1 = -2.0 * cw
    a2 = 1.0 - alpha
    return (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)


def biquad_highpass(f0, q):
    """RBJ-högpass."""
    w0 = 2.0 * math.pi * f0 / SR
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2.0 * q)
    b0 = (1.0 + cw) / 2.0
    b1 = -(1.0 + cw)
    b2 = b0
    a0 = 1.0 + alpha
    a1 = -2.0 * cw
    a2 = 1.0 - alpha
    return (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)


def butter_q(order):
    """Q-värden för en Butterworthkaskad: ett biquadsteg per polpar.

    Att kaskadkoppla identiska steg vore enklare men sänker passbandet i onödan.
    Med rätt Q per steg blir passbandet platt och flanken 6·order dB/oktav —
    branta flanker är hela poängen: grannbanden ska vara tomma.
    """
    return [1.0 / (2.0 * math.sin((2 * k + 1) * math.pi / (2 * order)))
            for k in range(order // 2)]


def butter_lowpass(f0, order=4):
    """Lågpasskaskad av Butterworthtyp. −3 dB vid f0."""
    return [biquad_lowpass(f0, q) for q in butter_q(order)]


def butter_highpass(f0, order=4):
    """Högpasskaskad av Butterworthtyp."""
    return [biquad_highpass(f0, q) for q in butter_q(order)]


def run_biquad(buf, coeffs):
    """Kör ett biquadsteg över en lista med sampel. Returnerar ny lista."""
    b0, b1, b2, a1, a2 = coeffs
    x1 = x2 = y1 = y2 = 0.0
    out = [0.0] * len(buf)
    for i, x0 in enumerate(buf):
        y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        out[i] = y0
        x2, x1 = x1, x0
        y2, y1 = y1, y0
    return out


def noise_bed(seed, length, stages):
    """Filtrerad brusbädd som varje slag läser ur på en egen förskjutning.

    Att filtrera en enda lång bädd i stället för varje slag för sig ger både
    fart och variation: slagen låter olika utan att någon slump smyger in.
    """
    buf = [0.0] * length
    lcg = Lcg(seed)
    for i in range(length):
        buf[i] = lcg.bipolar()
    for coeffs in stages:
        buf = run_biquad(buf, coeffs)
    peak = max(abs(v) for v in buf) or 1.0
    return [v / peak for v in buf]


# ------------------------------------------------------------- vågformer

def make_kick():
    """Bastrumma: sinus som sveper 55→40 Hz med ~120 ms dämpning.

    Den snabba dämpningen sprider annars energi långt upp i registret — därför
    lågpassas slaget hårt, så att virvelbandet förblir tomt mellan virvelslagen.
    """
    dur = 0.19
    n = int(dur * SR)
    out = [0.0] * (n + 512)
    phase = 0.0
    for i in range(n):
        t = i / SR
        freq = 40.0 + 15.0 * math.exp(-t / 0.028)
        phase += 2.0 * math.pi * freq / SR
        env = math.exp(-t / 0.038)
        if t < 0.0015:                       # mjukt anslag, inga klick
            env *= t / 0.0015
        rem = dur - t
        if rem < 0.025:                      # mjuk utrullning i svansen
            env *= 0.5 - 0.5 * math.cos(math.pi * rem / 0.025)
        out[i] = math.sin(phase) * env
    for coeffs in butter_lowpass(130.0, 4):
        out = run_biquad(out, coeffs)
    peak = max(abs(v) for v in out) or 1.0
    return [v / peak for v in out]


def make_envelope(dur, attack, tau, tail=0.02):
    """Exponentiellt fallande hölje med kort anslag och mjuk avslutning.

    Anslaget är en höjd cosinus. Ett hölje med tvärt anslag sprider energi långt
    utanför bruskällans passband — det är höljet, inte filtret, som avgör hur
    rent ett kort slag håller sig inom sitt band.
    """
    n = int(dur * SR)
    env = [0.0] * n
    for i in range(n):
        t = i / SR
        v = math.exp(-t / tau)
        if t < attack:
            v *= 0.5 - 0.5 * math.cos(math.pi * t / attack)
        rem = dur - t
        if rem < tail:
            v *= 0.5 - 0.5 * math.cos(math.pi * rem / tail)
        env[i] = v
    return env


def make_snare_body():
    """Virvelns tonala kropp: två sinustoner i 190–260 Hz."""
    dur = 0.16
    n = int(dur * SR)
    out = [0.0] * n
    for i in range(n):
        t = i / SR
        env = math.exp(-t / 0.045)
        if t < 0.002:
            env *= t / 0.002
        rem = dur - t
        if rem < 0.02:
            env *= 0.5 - 0.5 * math.cos(math.pi * rem / 0.02)
        out[i] = env * (
            0.62 * math.sin(2.0 * math.pi * 190.0 * t)
            + 0.38 * math.sin(2.0 * math.pi * 260.0 * t)
        )
    return out


def make_tone(freq, dur, attack, tau, lowpass=0.0):
    """Ren sinuston med exponentiellt fallande hölje.

    Anslag och avslutning är höjda cosinusramper, inte raka. Ett rakt anslag
    lägger ett hörn i vågformen och ett hörn sprider energi flera oktaver upp —
    just det som skulle smutsa ner grannbanden. Basen lågpassas dessutom, så att
    inte ens höljets spektralsvans når upp i virvelbandet.
    """
    n = int(dur * SR)
    out = [0.0] * (n + (256 if lowpass else 0))
    for i in range(n):
        t = i / SR
        env = math.exp(-t / tau)
        if t < attack:
            env *= 0.5 - 0.5 * math.cos(math.pi * t / attack)
        rem = dur - t
        if rem < 0.03:
            env *= 0.5 - 0.5 * math.cos(math.pi * rem / 0.03)
        out[i] = env * math.sin(2.0 * math.pi * freq * t)
    if lowpass:
        peak_before = max(abs(v) for v in out) or 1.0
        for coeffs in butter_lowpass(lowpass, 4):
            out = run_biquad(out, coeffs)
        peak = max(abs(v) for v in out) or 1.0
        out = [v * peak_before / peak for v in out]
    return out


# ------------------------------------------------------------------ arrang

# Basgång i d-moll (i–VI–VII): en ton per takt, allt ligger i 100–150 Hz —
# ovanför bastrummans register men väl inne i basbandet.
D3, BB2, C3 = 146.83, 116.54, 130.81
BASS_ROOTS = [D3, D3, BB2, C3]
WHOLE_STEP_DOWN = 2.0 ** (-2.0 / 12.0)

# Ackorden håller sig i 590–1870 Hz, med tyngd över 1 kHz där varken virvel
# eller bas har något — mellanregistret blir därmed ett eget, rent band.
CHORDS = [
    [587.33, 880.00, 1174.66, 1396.91],      # d-moll
    [587.33, 880.00, 1174.66, 1396.91],      # d-moll
    [698.46, 932.33, 1174.66, 1864.66],      # B♭-dur
    [659.26, 783.99, 1046.50, 1567.98],      # C-dur
]
CHORD_WEIGHTS = [0.55, 0.75, 1.0, 1.0]


def section_of(bar):
    """Låtens form: intro 4, fullt 8, break 4, fullt 16."""
    if bar < 4:
        return 'intro'
    if bar < 12:
        return 'full'
    if bar < 16:
        return 'break'
    return 'full'


def equal_power(pan):
    """Panorering -1…1 → (vänster, höger) med konstant effekt."""
    a = (pan + 1.0) * math.pi / 4.0
    return math.cos(a), math.sin(a)


# -------------------------------------------------------------------- mix

def add_into(left, right, start, waveform, gain_l, gain_r):
    """Lägger en vågform i mixen vid ett sampelindex."""
    if start >= TOTAL:
        return
    if start < 0:
        waveform = waveform[-start:]
        start = 0
    n = min(len(waveform), TOTAL - start)
    for i in range(n):
        v = waveform[i]
        left[start + i] += v * gain_l
        right[start + i] += v * gain_r


def render():
    left = array.array('d', [0.0]) * TOTAL
    right = array.array('d', [0.0]) * TOTAL

    kick = make_kick()

    # Virvel: bandpassat brus med tyngdpunkt kring 350 Hz. Taket är brant
    # (sjätte ordningen) och lagt lågt, så att ackordbandet över 1 kHz blir
    # virvelfritt.
    snare_stages = butter_highpass(180.0, 4) + butter_lowpass(620.0, 6)
    # Hi-hat: brant högpassat brus, taket lagt på 14 kHz.
    hat_stages = butter_highpass(8000.0, 4) + butter_lowpass(14000.0, 4)

    bed_len = int(2.0 * SR)
    snare_bed_l = noise_bed(0x5EED1, bed_len, snare_stages)
    snare_bed_r = noise_bed(0x5EED2, bed_len, snare_stages)
    hat_bed_l = noise_bed(0x5EED3, bed_len, hat_stages)
    hat_bed_r = noise_bed(0x5EED4, bed_len, hat_stages)

    snare_env = make_envelope(0.26, 0.004, 0.075)
    snare_body = make_snare_body()
    hat_closed_env = make_envelope(0.075, 0.0004, 0.017)
    hat_open_env = make_envelope(0.34, 0.0004, 0.105)

    tone_cache = {}

    def tone(freq, dur, attack, tau, lowpass=0.0):
        key = (round(freq, 4), round(dur, 4), attack, tau, lowpass)
        if key not in tone_cache:
            tone_cache[key] = make_tone(freq, dur, attack, tau, lowpass)
        return tone_cache[key]

    def bed_slice(bed, env, index):
        """Brusbädd × hölje, med en förskjutning som varierar per slag."""
        n = len(env)
        off = (index * 4801) % (bed_len - n)
        return [bed[off + i] * env[i] for i in range(n)]

    hit = 0        # räknare för virvelslag
    hat_hit = 0    # räknare för hi-hat-slag

    for bar in range(BARS):
        section = section_of(bar)
        bar_t = bar * SEC_PER_BAR
        drums = section != 'break'
        bass = section == 'full'
        root = BASS_ROOTS[bar % 4]

        if drums:
            # Bastrumma på var fjärdedel.
            for beat in range(BEATS_PER_BAR):
                s = int((bar_t + beat * SEC_PER_BEAT) * SR)
                add_into(left, right, s, kick, GAIN_KICK, GAIN_KICK)

            # Virvel på 2 och 4.
            for beat in (1, 3):
                s = int((bar_t + beat * SEC_PER_BEAT) * SR)
                add_into(left, right, s, bed_slice(snare_bed_l, snare_env, hit),
                         GAIN_SNARE, 0.0)
                add_into(left, right, s, bed_slice(snare_bed_r, snare_env, hit + 7),
                         0.0, GAIN_SNARE)
                add_into(left, right, s, snare_body, GAIN_SNARE * 0.9, GAIN_SNARE * 0.9)
                hit += 1

            # Hi-hat på var åttondel, öppen på var fjärde.
            for eighth in range(8):
                s = int((bar_t + eighth * SEC_PER_BEAT / 2.0) * SR)
                openhat = eighth % 4 == 3
                env = hat_open_env if openhat else hat_closed_env
                gain = GAIN_HAT_OPEN if openhat else GAIN_HAT_CLOSED
                pan = -0.35 if eighth % 2 == 0 else 0.35
                gl, gr = equal_power(pan)
                add_into(left, right, s, bed_slice(hat_bed_l, env, hat_hit), gain * gl, 0.0)
                add_into(left, right, s, bed_slice(hat_bed_r, env, hat_hit + 11), 0.0, gain * gr)
                hat_hit += 1

        if bass:
            # Fyra basnoter per takt: 1, &2, 3, &4 — sista tonen ett helt steg ned.
            for slot, length in ((0, 3), (3, 1), (4, 2), (6, 2)):
                freq = root * WHOLE_STEP_DOWN if slot == 6 else root
                dur = length * SEC_PER_BEAT / 2.0 * 0.85
                s = int((bar_t + slot * SEC_PER_BEAT / 2.0) * SR)
                w = tone(freq, dur, 0.022, dur * 0.55, lowpass=170.0)
                add_into(left, right, s, w, GAIN_BASS, GAIN_BASS)

        # Ackordstick: var åttonde takt, samt varje takt i breaket.
        stabs = []
        if section == 'break':
            stabs.append((0.0, 1.0, 1.70))
            stabs.append((2.0 * SEC_PER_BEAT, 0.55, 0.85))
        elif section == 'full' and bar % 8 == 0:
            stabs.append((0.0, 1.0, 0.95))

        for offset, level, dur in stabs:
            chord = CHORDS[bar % 4]
            s = int((bar_t + offset) * SR)
            for j, freq in enumerate(chord):
                pan = -0.6 + 1.2 * j / (len(chord) - 1)
                gl, gr = equal_power(pan)
                w = tone(freq, dur, 0.014, dur * 0.42)
                # Övertyngd uppåt: sticket ska höras tydligt över 900 Hz.
                g = GAIN_CHORD * level * CHORD_WEIGHTS[j] * 1.6 / len(chord)
                add_into(left, right, s, w, g * gl, g * gr)

    return left, right


def finish(left, right):
    """Mjuk in-/uttoning och normalisering till −1 dBFS."""
    fade_in = int(FADE_IN * SR)
    fade_out = int(FADE_OUT * SR)
    for i in range(fade_in):
        g = 0.5 - 0.5 * math.cos(math.pi * i / fade_in)
        left[i] *= g
        right[i] *= g
    for i in range(fade_out):
        idx = TOTAL - 1 - i
        g = 0.5 - 0.5 * math.cos(math.pi * i / fade_out)
        left[idx] *= g
        right[idx] *= g

    peak = 0.0
    for i in range(TOTAL):
        a = abs(left[i])
        if a > peak:
            peak = a
        a = abs(right[i])
        if a > peak:
            peak = a
    scale = (10.0 ** (TARGET_DBFS / 20.0)) / peak if peak > 0 else 1.0
    return scale, peak


def write_wav(path, left, right, scale):
    data = array.array('h', [0]) * (TOTAL * 2)
    for i in range(TOTAL):
        l = int(round(left[i] * scale * 32767.0))
        r = int(round(right[i] * scale * 32767.0))
        data[2 * i] = -32768 if l < -32768 else (32767 if l > 32767 else l)
        data[2 * i + 1] = -32768 if r < -32768 else (32767 if r > 32767 else r)
    if sys.byteorder == 'big':
        data.byteswap()

    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def main(argv):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = argv[1] if len(argv) > 1 else os.path.join(root, 'assets', 'track.wav')

    left, right = render()
    scale, peak = finish(left, right)
    write_wav(out, left, right, scale)

    size = os.path.getsize(out)
    print(f'Skrev {out}')
    print(f'  {DURATION:.1f} s · {BPM:.0f} BPM · {BARS} takter · {SR} Hz · 16-bitars stereo')
    print(f'  {size / 1048576:.1f} MiB · topp före normalisering {peak:.3f} → {TARGET_DBFS:.0f} dBFS')
    print('  Band: bastrumma 35–110 · bas 100–150 · virvel 180–400 · '
          'ackord 1100–2000 · hi-hat 8000–14000 Hz')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
