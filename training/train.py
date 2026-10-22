import argparse
import json
import math
import os
import sys
import time

import numpy as np
import torch

from audio import load_dir
from data import Mixer
from dfn import Dfn
from losses import total_loss

WEIGHTS = {'mr': 1.0, 'oa': 1.0, 'cut': 2.0, 'leak': 0.5, 'lsnr': 1.0}


def emit(**kw):
    sys.stdout.write(json.dumps(kw) + '\n')
    sys.stdout.flush()


def schedule(step, total, warmup, peak, floor=1e-6):
    if step < warmup:
        return peak * (step + 1) / warmup
    p = (step - warmup) / max(1, total - warmup)
    return floor + (peak - floor) * 0.5 * (1 + math.cos(math.pi * p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--clean', required=True)
    ap.add_argument('--noise', default='')
    ap.add_argument('--speech', default='')
    ap.add_argument('--out', required=True)
    ap.add_argument('--steps', type=int, default=0)
    ap.add_argument('--minutes', type=float, default=30.0)
    ap.add_argument('--batch', type=int, default=12)
    ap.add_argument('--clip', type=float, default=1.5)
    ap.add_argument('--lr', type=float, default=5e-5)
    ap.add_argument('--silent', type=float, default=0.3)
    ap.add_argument('--others', type=float, default=0.75)
    ap.add_argument('--threads', type=int, default=0)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--save-every', type=int, default=100)
    ap.add_argument('--resume', default='')
    args = ap.parse_args()
    if args.threads:
        torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    clean = load_dir(args.clean)
    noise = load_dir(args.noise, split='train') if args.noise else []
    speech = load_dir(args.speech, split='train') if args.speech else []
    if not clean:
        raise SystemExit('no clean speech found')
    emit(event='loaded', clean=len(clean), noise=len(noise), speech=len(speech), seconds=round(sum(len(c) for c in clean) / 48000, 1))
    model = Dfn(args.resume or args.base)
    model.train()
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
    mixer = Mixer(clean, noise, speech, seed=args.seed, seconds=args.clip, silent=args.silent, others=args.others)
    started = time.time()
    total = args.steps
    step = 0
    measured = []
    while True:
        if total and step >= total:
            break
        if not total and step == 4:
            per = float(np.mean(measured[1:]))
            total = max(20, int(args.minutes * 60 / per))
            emit(event='plan', steps=total, seconds_per_step=round(per, 2))
        warm = 20 if total == 0 else max(10, total // 20)
        lr = schedule(step, total or 1000, warm, args.lr)
        for g in opt.param_groups:
            g['lr'] = lr
        t0 = time.time()
        noisy, ref, parts = mixer.batch(args.batch)
        loss, terms = total_loss(model, noisy, ref, parts, WEIGHTS)
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step()
        measured.append(time.time() - t0)
        step += 1
        if step % 5 == 0 or step <= 3:
            emit(event='step', step=step, total=total, loss=round(float(loss), 4), mr=round(float(terms['mr']), 3), oa=round(float(terms['oa']), 3), cut=round(float(terms['cut']), 3), lsnr=round(float(terms['lsnr']), 3), leak=round(float(terms['leak']), 3), lr=lr, elapsed=round(time.time() - started, 1))
        if step % args.save_every == 0:
            model.save(args.out + '.partial')
    model.save(args.out)
    emit(event='done', steps=step, seconds=round(time.time() - started, 1))


if __name__ == '__main__':
    main()
