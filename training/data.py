import numpy as np
import torch

from audio import RATE, rms



def db_gain(db):
    return 10 ** (db / 20.0)


def synth_rir(rng, rt60):
    n = int(rt60 * RATE)
    t = np.arange(n) / RATE
    tail = rng.standard_normal(n) * np.exp(-6.9 * t / rt60)
    direct = int(0.004 * RATE)
    rir = np.zeros(n + direct)
    rir[direct:] = tail * 0.3
    rir[direct] = 1.0
    return rir.astype(np.float32), direct


def convolve(x, rir):
    n = len(x)
    size = 1
    while size < n + len(rir):
        size *= 2
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(rir, size), size)[:n]
    return y.astype(np.float32)


def crop(pool, rng, length, loud=False):
    for _ in range(12):
        x = pool[rng.integers(len(pool))]
        if len(x) <= length:
            out = np.zeros(length, dtype=np.float32)
            at = rng.integers(0, length - len(x) + 1)
            out[at:at + len(x)] = x
        else:
            at = rng.integers(0, len(x) - length + 1)
            out = x[at:at + length].copy()
        if not loud or rms(out) > 0.004:
            return out
    return out


def synth_noise(rng, length):
    kind = rng.integers(4)
    white = rng.standard_normal(length).astype(np.float32)
    if kind == 0:
        spec = np.fft.rfft(white)
        f = np.maximum(np.arange(len(spec)), 1)
        return np.fft.irfft(spec / f ** rng.uniform(0.3, 1.0), length).astype(np.float32)
    if kind == 1:
        k = int(rng.integers(20, 120))
        low = np.convolve(white, np.ones(k) / k, mode='same')
        env = np.zeros(length, dtype=np.float32)
        for _ in range(int(rng.integers(1, 5))):
            n = int(rng.uniform(0.15, 0.7) * RATE)
            at = int(rng.integers(0, max(1, length - n)))
            env[at:at + n] = np.sin(np.linspace(0, np.pi, n)) ** 0.7
        return (low * env).astype(np.float32)
    if kind == 2:
        t = np.arange(length) / RATE
        hum = np.sin(2 * np.pi * rng.choice([50.0, 60.0, 100.0, 120.0]) * t) * rng.uniform(0.2, 1.0)
        return (hum + 0.3 * white).astype(np.float32)
    n = int(rng.integers(RATE // 100, RATE // 20))
    out = np.zeros(length, dtype=np.float32)
    for _ in range(int(rng.integers(1, 6))):
        at = int(rng.integers(0, max(1, length - n)))
        out[at:at + n] += white[:n] * np.exp(-np.arange(n) / (n / 4.0))
    return out


def scale_to(x, snr_db, ref):
    return x * (rms(ref) / (10 ** (snr_db / 20.0)) / rms(x))


class Mixer:
    def __init__(self, clean, noise, speech, seed=0, seconds=1.5, silent=0.15, others=0.6):
        self.silent = silent
        self.others = others
        self.length = int(seconds * RATE)
        self.clean = clean
        self.noise = noise
        self.speech = speech
        self.rng = np.random.default_rng(seed)

    def sample(self):
        rng = self.rng
        target = crop(self.clean, rng, self.length, loud=True)
        gain = rng.choice([-18.0, -12.0, -6.0, 0.0, 3.0], p=[0.1, 0.2, 0.3, 0.3, 0.1])
        target = target * db_gain(gain)
        silent = rng.random() < self.silent
        mix_target = np.zeros(self.length, dtype=np.float32) if silent else target
        ref_target = mix_target
        if not silent and rng.random() < 0.15:
            rir, direct = synth_rir(rng, rng.uniform(0.2, 0.6))
            mix_target = convolve(target, rir)
            ref_target = convolve(target, rir[:direct + int(0.05 * RATE)])
        anchor = target if not silent else np.full(self.length, 0.05 * db_gain(float(rng.choice([-12.0, -6.0, 0.0, 3.0]))), dtype=np.float32)
        parts = np.zeros(self.length, dtype=np.float32)
        near_clean = rng.random() < 0.12
        if not near_clean:
            if self.speech and rng.random() < (0.85 if silent else self.others):
                for _ in range(int(rng.integers(1, 3))):
                    other = crop(self.speech, rng, self.length, loud=True)
                    if rng.random() < 0.3:
                        rir, _ = synth_rir(rng, rng.uniform(0.2, 0.6))
                        other = convolve(other, rir)
                    parts += scale_to(other, float(rng.choice([-5.0, 0.0, 5.0, 10.0, 15.0])), anchor)
            if self.noise and rng.random() < 0.8:
                for _ in range(int(rng.integers(1, 3))):
                    parts += scale_to(crop(self.noise, rng, self.length, loud=True), float(rng.choice([-5.0, 0.0, 5.0, 10.0, 20.0, 30.0])), anchor)
            if rng.random() < 0.35:
                parts += scale_to(synth_noise(rng, self.length), float(rng.choice([-5.0, 0.0, 5.0, 10.0, 20.0])), anchor)
        noisy = mix_target + parts
        peak = float(np.abs(noisy).max())
        if peak > 0.98:
            k = 0.98 / peak
            noisy, ref_target, parts = noisy * k, ref_target * k, parts * k
        return noisy.astype(np.float32), ref_target.astype(np.float32), parts.astype(np.float32)

    def batch(self, size):
        items = [self.sample() for _ in range(size)]
        return tuple(torch.from_numpy(np.stack([i[k] for i in items])) for k in range(3))
