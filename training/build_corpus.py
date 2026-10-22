import argparse
import io
import os
import tarfile
import zipfile

import numpy as np

from audio import read_wav, write_wav

RATE = 16000
LICENSES = """Vesper Audio trainer corpus

noise/   DEMAND (Thiemann, Ito, Vincent), Zenodo 1227121, Creative Commons Attribution 4.0 International. 40 second excerpts, 16 kHz.
speech/en  LibriSpeech dev-clean (Panayotov et al.), CC BY 4.0. Short excerpts, 16 kHz.
speech/hi  OpenSLR SLR104 Hindi-English code-switching test set (MUCS 2021), CC BY-SA 4.0. Short excerpts, 16 kHz.
"""


def excerpt(x, seconds, offset=0.0):
    a = int(offset * RATE)
    return x[a:a + int(seconds * RATE)]


def demand(zips, out):
    n = 0
    for path in zips:
        env = os.path.basename(path).split('_')[0]
        with zipfile.ZipFile(path) as z:
            for ch in ('ch01.wav', 'ch09.wav'):
                name = f'{env}/{ch}'
                if name not in z.namelist():
                    continue
                x, rate = read_wav_bytes(z.read(name))
                if rate != RATE:
                    continue
                write_wav(os.path.join(out, 'noise', f'{env.lower()}-{ch[:4]}.wav'), excerpt(x, 40.0, 30.0), RATE)
                n += 1
    return n


def read_wav_bytes(data):
    import wave
    w = wave.open(io.BytesIO(data), 'rb')
    raw = w.readframes(w.getnframes())
    x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    if w.getnchannels() > 1:
        x = x.reshape(-1, w.getnchannels()).mean(axis=1)
    return x, w.getframerate()


def libri(root, out, per_speaker):
    import soundfile as sf
    n = 0
    for spk in sorted(os.listdir(root)):
        taken = 0
        for ch in sorted(os.listdir(os.path.join(root, spk))):
            for f in sorted(os.listdir(os.path.join(root, spk, ch))):
                if not f.endswith('.flac') or taken >= per_speaker:
                    continue
                x, rate = sf.read(os.path.join(root, spk, ch, f), dtype='float32')
                if rate != RATE or not 5.0 < len(x) / RATE < 15.0:
                    continue
                write_wav(os.path.join(out, 'speech', f'en-{spk}-{taken}.wav'), x, RATE)
                taken += 1
                n += 1
    return n


def hindi(archive, out, per_file, seconds, seed):
    rng = np.random.default_rng(seed)
    n = 0
    with tarfile.open(archive, 'r:gz') as tf:
        for member in tf:
            if not member.name.endswith('.wav'):
                continue
            x, rate = read_wav_bytes(tf.extractfile(member).read())
            if rate != RATE or len(x) < seconds * RATE * 2:
                continue
            taken = 0
            for _ in range(60):
                a = int(rng.integers(0, len(x) - int(seconds * RATE)))
                seg = x[a:a + int(seconds * RATE)]
                if float(np.sqrt(np.mean(seg ** 2))) > 0.01:
                    write_wav(os.path.join(out, 'speech', f'hi-{n:03d}.wav'), seg, RATE)
                    taken += 1
                    n += 1
                if taken >= per_file:
                    break
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--demand', required=True)
    ap.add_argument('--libri', required=True)
    ap.add_argument('--slr104', required=True)
    ap.add_argument('--libri-per-speaker', type=int, default=3)
    ap.add_argument('--hindi-per-file', type=int, default=5)
    ap.add_argument('--hindi-seconds', type=float, default=8.0)
    args = ap.parse_args()
    os.makedirs(os.path.join(args.out, 'noise'), exist_ok=True)
    os.makedirs(os.path.join(args.out, 'speech'), exist_ok=True)
    zips = [os.path.join(args.demand, f) for f in sorted(os.listdir(args.demand)) if f.endswith('_16k.zip')]
    print('noise clips', demand(zips, args.out))
    print('english clips', libri(args.libri, args.out, args.libri_per_speaker))
    print('hindi-english clips', hindi(args.slr104, args.out, args.hindi_per_file, args.hindi_seconds, 3))
    with open(os.path.join(args.out, 'LICENSES.txt'), 'w') as f:
        f.write(LICENSES)


if __name__ == '__main__':
    main()
