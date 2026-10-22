import os
import wave

import numpy as np
import torch
import torch.nn.functional as F

RATE = 48000


def read_wav(path):
    w = wave.open(path, 'rb')
    channels = w.getnchannels()
    width = w.getsampwidth()
    rate = w.getframerate()
    raw = w.readframes(w.getnframes())
    w.close()
    if width == 2:
        x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif width == 4:
        x = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0
    elif width == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError('unsupported sample width %d' % width)
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    return x, rate


def write_wav(path, x, rate=RATE):
    w = wave.open(path, 'wb')
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes((np.clip(x, -1.0, 1.0) * 32767).astype('<i2').tobytes())
    w.close()


def resample(x, src, dst=RATE):
    if src == dst:
        return x
    n_out = int(round(len(x) * dst / src))
    spec = torch.fft.rfft(torch.from_numpy(x).double())
    keep = n_out // 2 + 1
    out = torch.zeros(keep, dtype=spec.dtype)
    m = min(keep, spec.shape[0])
    out[:m] = spec[:m]
    y = torch.fft.irfft(out, n=n_out) * (n_out / len(x))
    return y.float().numpy()


def load_dir(path, rate=RATE, limit=None, split='all'):
    out = []
    names = [n for n in sorted(os.listdir(path)) if n.lower().endswith('.wav')]
    for i, name in enumerate(names):
        if split == 'train' and i % 7 == 0:
            continue
        if split == 'val' and i % 7 != 0:
            continue
        x, r = read_wav(os.path.join(path, name))
        out.append(resample(x, r, rate))
        if limit and len(out) >= limit:
            break
    return out


def rms(x):
    return float(np.sqrt(np.mean(x ** 2) + 1e-12))
