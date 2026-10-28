"""Puts the site recording on the monitor in the photo and scores it.

    python -I showcase/composite.py          (run from the site folder, after record.mjs)

Reads  showcase/screen.mp4, showcase/track.json, showcase/monitor.webp
Writes showcase/freefall-showcase.mp4  (1080x1920, the monitor shot)
       showcase/freefall-screen.mp4    (1650x900, the flat recording with the same sound)
"""
import json
import subprocess
import wave

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from scipy import signal

DIR = 'showcase'
OUT_W, OUT_H = 1080, 1920
REC_W, REC_H = 1650, 900
FPS = 30
SR = 48000
# inner edge of the display, measured on the 941x1672 photo: TL, TR, BR, BL
QUAD = [(81.5, 629.5), (858.5, 622.5), (862.5, 1052.5), (77.5, 1054.5)]
ZOOM = 0.07          # slow push-in over the whole video
FADE_IN, FADE_OUT = 0.6, 1.0


def sstep(a, b, v):
    t = np.clip((v - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- picture
def build_static():
    photo = Image.open(f'{DIR}/monitor.webp').convert('RGB')
    sx, sy = OUT_W / photo.width, OUT_H / photo.height
    bg = photo.resize((OUT_W, OUT_H), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=35, threshold=2))

    q = np.array([(x * sx, y * sy) for x, y in QUAD])
    c = q.mean(axis=0)
    q = c + (q - c) * (1 + 0.8 / np.linalg.norm(q - c, axis=1, keepdims=True))  # bleed 0.8px under the bezel
    bx, by = int(np.floor(q[:, 0].min())) - 2, int(np.floor(q[:, 1].min())) - 2
    bw, bh = int(np.ceil(q[:, 0].max())) + 2 - bx, int(np.ceil(q[:, 1].max())) + 2 - by
    rel = q - [bx, by]

    pw = int(round(max(np.linalg.norm(rel[1] - rel[0]), np.linalg.norm(rel[2] - rel[3]))))
    ph = int(round(max(np.linalg.norm(rel[3] - rel[0]), np.linalg.norm(rel[2] - rel[1]))))
    src = [(0, 0), (pw, 0), (pw, ph), (0, ph)]
    A, B = [], []
    for (x, y), (u, v) in zip(rel, src):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        B += [u, v]
    coeffs = np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()

    ss = 4
    m = Image.new('L', (bw * ss, bh * ss), 0)
    ImageDraw.Draw(m).polygon([(x * ss, y * ss) for x, y in rel], fill=255)
    mask = m.resize((bw, bh), Image.LANCZOS)

    # glass: a soft diagonal sheen and a thin shadow where the panel meets the bezel
    yy, xx = np.mgrid[0:ph, 0:pw].astype(np.float32)
    s = xx / pw * 0.8 + yy / ph * 0.45
    sheen = 0.06 * np.exp(-((s - 0.36) / 0.15) ** 2) + 0.025 * (1 - yy / ph)
    edge = np.minimum.reduce([xx, yy, pw - 1 - xx, ph - 1 - yy])
    dark = 0.5 * np.exp(-edge / 2.2)

    # light the screen throws onto the bezel and the scene around it
    pad = 160
    gx, gy = max(0, bx - pad), max(0, by - pad)
    gw, gh = min(OUT_W, bx + bw + pad) - gx, min(OUT_H, by + bh + pad) - gy
    gm = Image.new('L', (gw, gh), 0)
    gm.paste(mask, (bx - gx, by - gy))
    glow = np.asarray(gm.filter(ImageFilter.GaussianBlur(55)), np.float32) / 255
    inside = np.zeros((gh, gw), np.float32)
    inside[by - gy:by - gy + bh, bx - gx:bx - gx + bw] = np.asarray(mask, np.float32) / 255
    glow = np.clip(glow - inside, 0, 1)[..., None]

    center = (q[:, 0].mean(), q[:, 1].mean())
    gray = lambda v: Image.fromarray(np.clip(v * 255, 0, 255).astype(np.uint8)).convert('RGB')
    return dict(bg=bg, bx=bx, by=by, bw=bw, bh=bh, pw=pw, ph=ph, coeffs=coeffs, mask=mask,
                sheen=gray(sheen), keep=gray(1 - dark), glow=gray(glow[..., 0]), gbox=(gx, gy, gw, gh), center=center)


def compose(frame, st, t, total):
    f = frame.resize((st['pw'], st['ph']), Image.LANCZOS)
    mean = np.array(f.resize((1, 1), Image.BOX).getpixel((0, 0)), float) / 255
    f = ImageChops.screen(ImageChops.multiply(f, st['keep']), st['sheen'])
    warped = f.transform((st['bw'], st['bh']), Image.PERSPECTIVE, st['coeffs'], Image.BILINEAR)

    canvas = st['bg'].copy()
    gx, gy, gw, gh = st['gbox']
    lum = float(mean @ [0.3, 0.55, 0.15])
    tint = tuple(int(c * 255 * (0.06 + 0.34 * lum ** 2)) for c in mean)
    spill = ImageChops.multiply(st['glow'], Image.new('RGB', (gw, gh), tint))
    canvas.paste(ImageChops.add(canvas.crop((gx, gy, gx + gw, gy + gh)), spill), (gx, gy))
    canvas.paste(warped, (st['bx'], st['by']), st['mask'])

    k = t / total
    z = 1 + ZOOM * (0.5 - 0.5 * np.cos(np.pi * k))
    if z > 1.0005:
        cx, cy = st['center']
        box = (cx - cx / z, cy - cy / z, cx + (OUT_W - cx) / z, cy + (OUT_H - cy) / z)
        canvas = canvas.resize((OUT_W, OUT_H), Image.BICUBIC, box=box)

    fade = min(1.0, t / FADE_IN, (total - t) / FADE_OUT)
    if fade < 1:
        canvas = Image.eval(canvas, lambda v, f=max(0.0, fade): int(v * f))
    return canvas


# ---------------------------------------------------------------- sound
def one_pole(x, tc):
    a = 1 - np.exp(-1 / (tc * SR))
    return signal.lfilter([a], [1, -(1 - a)], x)


def varying_filter(x, freqs, kind, q=0.8, block=256):
    out = np.empty_like(x)
    zi = np.zeros(2)
    for i in range(0, len(x), block):
        f = float(np.clip(freqs[min(i, len(freqs) - 1)], 30, SR / 2.2))
        w0 = 2 * np.pi * f / SR
        alpha = np.sin(w0) / (2 * q)
        cw = np.cos(w0)
        if kind == 'band':
            b = np.array([alpha, 0, -alpha])
        else:
            b = np.array([(1 - cw) / 2, 1 - cw, (1 - cw) / 2])
        a = np.array([1 + alpha, -2 * cw, 1 - alpha])
        out[i:i + block], zi = signal.lfilter(b / a[0], a / a[0], x[i:i + block], zi=zi)
    return out


def boom(n, at, power, rng):
    out = np.zeros(n)
    i0 = int(at * SR)
    dur = int(1.8 * SR)
    t = np.arange(min(dur, n - i0)) / SR
    if len(t) == 0:
        return out
    freq = 150 * (30 / 150) ** np.clip(t / 1.2, 0, 1)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    env = np.minimum(t / 0.02, 1) * np.exp(-t / 0.38)
    out[i0:i0 + len(t)] += np.sin(phase) * env * 0.9 * power
    nz = rng.standard_normal(len(t))
    nz = signal.lfilter(*signal.butter(2, 900 / (SR / 2)), nz)
    out[i0:i0 + len(t)] += nz * np.exp(-t / 0.22) * 1.2 * power
    return out


def tick(n, at):
    out = np.zeros(n)
    i0 = int(at * SR)
    t = np.arange(int(0.08 * SR)) / SR
    if i0 + len(t) > n:
        return out
    f = 1800 * (900 / 1800) ** (t / 0.05)
    out[i0:i0 + len(t)] = signal.sawtooth(2 * np.pi * np.cumsum(f) / SR, 0.5) * 0.05 * np.exp(-t / 0.018)
    return out


def score(track, total):
    L = track['layout']
    H = L['H']
    ys = np.array(track['scroll'], float)
    n = int(total * SR)
    tf = np.arange(len(ys)) / FPS
    ts = np.arange(n) / SR
    per = lambda v: np.interp(ts, tf, v)

    vel = np.abs(np.diff(ys, prepend=ys[0])) / (60 / FPS)          # px per 60 Hz frame, like the site
    vel = np.convolve(vel, np.ones(3) / 3, mode='same')
    v = np.clip(vel, 0, 80) / 80
    st, po = L['story'], L['portal']
    p = np.clip((ys - st['top']) / (st['h'] - H), 0, 1)
    in_story = ys < st['top'] + st['h']
    fall = in_story & (p < 0.47)
    crowd = in_story & (p >= 0.47) & (p < 0.86)
    wind_g = np.where(fall, 0.06 + v * 0.6, np.where(crowd, 0.04 + v * 0.3, 0.02 + v * 0.35))
    wind_f = np.where(fall, 380 + v * 1500 + p * 600, np.where(crowd, 180 + v * 400, 260 + v * 900))
    w = np.clip((ys - po['top']) / (po['h'] - H), 0, 1)
    in_portal = (ys + H >= po['top']) & (ys <= po['top'] + po['h'])
    open_ = np.maximum(sstep(0.1, 0.3, w) * (1 - sstep(0.9, 1, w)), sstep(0.78, 0.9, w)) * in_portal

    rng = np.random.default_rng(7)
    on = np.clip((ts - track['clicks'][0]) / 0.5, 0, 1)            # sound starts when "Enter with sound" is clicked
    gain_w = one_pole(per(wind_g), 0.08)
    freq_w = one_pole(per(wind_f), 0.12)
    left = varying_filter(rng.standard_normal(n), freq_w, 'band') * gain_w
    right = varying_filter(rng.standard_normal(n), freq_w * 1.06, 'band') * gain_w

    g_d = one_pole(per(open_ * 0.09), 0.4)
    f_d = one_pole(per(220 + open_ * 900), 0.4)
    sawL = sum(signal.sawtooth(2 * np.pi * f * ts) for f in (55, 82.4, 110.3))
    sawR = sum(signal.sawtooth(2 * np.pi * f * ts) for f in (55.6, 82.9, 110.0))
    left += varying_filter(sawL, f_d, 'low', q=0.7) * g_d
    right += varying_filter(sawR, f_d, 'low', q=0.7) * g_d

    hits = np.zeros(n)
    for thr, power in ((0.47, 1.0), (0.585, 0.7)):
        for i in range(1, len(p)):
            if in_story[i] and p[i - 1] < thr <= p[i] and p[i] - p[i - 1] < 0.05:
                hits += boom(n, tf[i], power, rng)
    for c in track['clicks']:
        hits += tick(n, c)
    left = (left + hits) * on * 0.8
    right = (right + hits) * on * 0.8

    fade = np.clip(np.minimum(ts / FADE_IN, (total - ts) / FADE_OUT), 0, 1)
    mix = np.stack([left, right], axis=1) * fade[:, None]
    ref = np.percentile(np.abs(mix), 99.95) + 1e-9
    mix = np.tanh(mix / ref * 1.1) / np.tanh(1.1) * 0.88
    with wave.open(f'{DIR}/score.wav', 'wb') as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((mix * 32767).astype('<i2').tobytes())


# ---------------------------------------------------------------- run
WORKERS = 3  # each worker runs its own decoder and x264, so keep an eye on RAM
X264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-rc-lookahead', '20', '-threads', '3', '-pix_fmt', 'yuv420p']


def render_segment(args):
    k, i0, i1, total = args
    st = build_static()
    src = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', f'{DIR}/screen.mp4', '-vf', f'select=between(n\\,{i0}\\,{i1 - 1})',
                            '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    out = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{OUT_W}x{OUT_H}',
                            '-r', str(FPS), '-i', '-', *X264, f'{DIR}/_seg{k}.mp4'], stdin=subprocess.PIPE)
    size = REC_W * REC_H * 3
    i = i0
    while i < i1:
        raw = src.stdout.read(size)
        if len(raw) < size:
            break
        frame = Image.frombuffer('RGB', (REC_W, REC_H), raw, 'raw', 'RGB', 0, 1)
        out.stdin.write(compose(frame, st, i / FPS, total).tobytes())
        i += 1
    out.stdin.close()
    out.wait()
    src.wait()
    return k, i - i0


def main():
    from multiprocessing import Pool
    from pathlib import Path

    track = json.load(open(f'{DIR}/track.json'))
    frames = len(track['scroll'])
    total = frames / FPS
    print(f'{frames} frames, {total:.1f}s')
    score(track, total)
    print('score written')

    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f'{DIR}/screen.mp4', '-i', f'{DIR}/score.wav',
                    '-map', '0:v', '-map', '1:a', *X264[:5], '19', *X264[6:], '-c:a', 'aac', '-b:a', '192k', '-shortest',
                    '-movflags', '+faststart', f'{DIR}/freefall-screen.mp4'], check=True)
    print('flat recording written', flush=True)

    cuts = np.linspace(0, frames, WORKERS + 1).astype(int)
    jobs = [(k, cuts[k], cuts[k + 1], total) for k in range(WORKERS)]
    with Pool(WORKERS) as pool:
        for k, n in pool.imap_unordered(render_segment, jobs):
            print(f'segment {k + 1}/{WORKERS} done ({n} frames)', flush=True)

    Path(f'{DIR}/_segs.txt').write_text(''.join(f"file '_seg{k}.mp4'\n" for k in range(WORKERS)))
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', f'{DIR}/_segs.txt', '-i', f'{DIR}/score.wav',
                    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
                    '-movflags', '+faststart', f'{DIR}/freefall-showcase.mp4'], check=True)
    for k in range(WORKERS):
        Path(f'{DIR}/_seg{k}.mp4').unlink()
    Path(f'{DIR}/_segs.txt').unlink()
    print('done')


if __name__ == '__main__':
    main()
