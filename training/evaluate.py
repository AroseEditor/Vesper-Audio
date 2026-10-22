import argparse
import json

import numpy as np
import torch

from audio import RATE, load_dir
from data import crop, scale_to
from dfn import Dfn
from losses import frame_db

LENGTH = 3 * RATE


def sisdr(est, ref):
    est = est - est.mean(-1, keepdim=True)
    ref = ref - ref.mean(-1, keepdim=True)
    alpha = (est * ref).sum(-1, keepdim=True) / (ref.pow(2).sum(-1, keepdim=True) + 1e-9)
    target = alpha * ref
    noise = est - target
    return 10 * torch.log10(target.pow(2).sum(-1) / (noise.pow(2).sum(-1) + 1e-9) + 1e-9)


def scenarios(clean, noise, speech, rng, count):
    items = []
    for _ in range(count):
        target = crop(clean, rng, LENGTH, loud=True)
        other = crop(speech, rng, LENGTH, loud=True) if speech else np.zeros(LENGTH, dtype=np.float32)
        bed = crop(noise, rng, LENGTH, loud=True) if noise else np.zeros(LENGTH, dtype=np.float32)
        items.append({
            'clean': (target, target),
            'noise10': (target + scale_to(bed, 10.0, target), target),
            'noise0': (target + scale_to(bed, 0.0, target), target),
            'speech5': (target + scale_to(other, 5.0, target), target),
            'speech0': (target + scale_to(other, 0.0, target), target),
            'quiet': (target * 0.1 + scale_to(bed, 10.0, target * 0.1), target * 0.1),
            'others_only': (scale_to(other, 0.0, target), np.zeros(LENGTH, dtype=np.float32)),
            'noise_only': (scale_to(bed, 0.0, target), np.zeros(LENGTH, dtype=np.float32)),
        })
    return items


@torch.no_grad()
def evaluate(model, clean, noise, speech, count=16, seed=7):
    model.eval()
    rng = np.random.default_rng(seed)
    items = scenarios(clean, noise, speech, rng, count)
    result = {}
    for name in items[0]:
        cut, gain, supp = [], [], []
        for item in items:
            mix, tgt = item[name]
            x = torch.from_numpy(mix.astype(np.float32))[None]
            ref = torch.from_numpy(tgt.astype(np.float32))[None]
            out = model.enhance(x)
            ident = model.synthesis(model.analysis(x), x.shape[-1])
            ref_wav = model.synthesis(model.analysis(ref), ref.shape[-1])
            if name in ('others_only', 'noise_only'):
                supp.append(float(10 * torch.log10(ident.pow(2).mean() / (out.pow(2).mean() + 1e-12) + 1e-12)))
                continue
            e_ref, e_out = frame_db(ref_wav), frame_db(out)
            speech_frames = e_ref > -55.0
            cut.append(float(((e_ref - e_out > 3.0) & speech_frames).float().sum() / speech_frames.float().sum().clamp_min(1)))
            gain.append(float(sisdr(out, ref_wav) - sisdr(ident, ref_wav)))
        if supp:
            result[name] = {'suppression_db': round(float(np.mean(supp)), 1)}
        else:
            result[name] = {'cut_rate': round(float(np.mean(cut)) * 100, 1), 'sisdr_gain_db': round(float(np.mean(gain)), 1)}
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--clean', required=True)
    ap.add_argument('--noise', default='')
    ap.add_argument('--speech', default='')
    ap.add_argument('--count', type=int, default=16)
    ap.add_argument('--threads', type=int, default=4)
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    model = Dfn(args.model)
    out = evaluate(model, load_dir(args.clean), load_dir(args.noise, split='val') if args.noise else [], load_dir(args.speech, split='val') if args.speech else [], args.count)
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
