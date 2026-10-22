import configparser
import io
import math
import tarfile

import numpy as np
import onnx
import torch
import torch.nn.functional as F

from onnxexec import Graph

ERB_WIDTHS = [2] * 13 + [5, 5, 7, 7, 8, 10, 12, 13, 15, 18, 20, 24, 28, 31, 37, 42, 50, 56, 67]
MEAN_NORM_INIT = (-60.0, -90.0)
UNIT_NORM_INIT = (0.001, 0.0001)
NAMES = ('enc', 'erb_dec', 'df_dec')


def read_tar(source):
    if isinstance(source, (bytes, bytearray)):
        handle = tarfile.open(fileobj=io.BytesIO(source), mode='r:gz')
    else:
        handle = tarfile.open(source, 'r:gz')
    files = {}
    with handle as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            data = tf.extractfile(member).read()
            for key in NAMES:
                if member.name.endswith(key + '.onnx'):
                    files[key] = data
            if member.name.endswith('config.ini'):
                files['config'] = data
    return files


def vorbis_window(n):
    i = torch.arange(n, dtype=torch.float64)
    s = torch.sin(0.5 * math.pi * (i + 0.5) / (n // 2))
    return torch.sin(0.5 * math.pi * s * s).float()


class Dfn(torch.nn.Module):
    def __init__(self, source):
        super().__init__()
        files = read_tar(source)
        cfg = configparser.ConfigParser()
        cfg.read_string(files['config'].decode())
        self.cfg_text = files['config']
        df = cfg['df']
        self.sr = int(df['sr'])
        self.fft = int(df['fft_size'])
        self.hop = int(df['hop_size'])
        self.nb_erb = int(df['nb_erb'])
        self.nb_df = int(df['nb_df'])
        self.order = int(df['df_order'])
        self.lookahead = int(df.get('df_lookahead', '0'))
        self.conv_lookahead = int(cfg['deepfilternet']['conv_lookahead'])
        if self.lookahead != 0 or self.conv_lookahead != 0:
            raise ValueError('only zero lookahead models can be trained')
        tau = float(df['norm_tau'])
        self.alpha = round(math.exp(-self.hop / (self.sr * tau)), 3)
        self.bins = self.fft // 2 + 1
        self.protos = {k: onnx.load_from_string(files[k]) for k in NAMES}
        self.graphs = torch.nn.ModuleDict({k: Graph(self.protos[k]) for k in NAMES})
        self.register_buffer('window', vorbis_window(self.fft))
        widths = torch.tensor(ERB_WIDTHS)
        assert int(widths.sum()) == self.bins
        self.register_buffer('band_of_bin', torch.repeat_interleave(torch.arange(len(ERB_WIDTHS)), widths))
        self.register_buffer('band_count', widths.float())
        self.register_buffer('erb_init', torch.linspace(MEAN_NORM_INIT[0], MEAN_NORM_INIT[1], self.nb_erb))
        self.register_buffer('unit_init', torch.linspace(UNIT_NORM_INIT[0], UNIT_NORM_INIT[1], self.nb_df))
        self.min_db = -10.0
        self.max_db_erb = 30.0
        self.max_db_df = 20.0

    def analysis(self, x):
        n = x.shape[-1]
        padded = F.pad(x, (self.hop, 0))
        spec = torch.stft(padded, n_fft=self.fft, hop_length=self.hop, win_length=self.fft, window=self.window, center=False, return_complex=True)
        return spec.transpose(1, 2) / self.fft

    def synthesis(self, spec, length):
        frames = torch.fft.irfft(spec, n=self.fft, dim=-1) * self.fft * self.window
        t = frames.shape[1]
        out = F.fold(frames.transpose(1, 2), output_size=(1, self.hop * (t + 1)), kernel_size=(1, self.fft), stride=(1, self.hop))
        return out.reshape(spec.shape[0], -1)[:, :length]

    def features(self, spec):
        b, t, _ = spec.shape
        power = spec.real ** 2 + spec.imag ** 2
        erb = torch.zeros(b, t, self.nb_erb, device=spec.device, dtype=power.dtype)
        erb.index_add_(2, self.band_of_bin, power)
        erb = 10 * torch.log10(erb / self.band_count + 1e-10)
        state = self.erb_init.expand(b, -1)
        out_e = []
        for i in range(t):
            state = erb[:, i] * (1 - self.alpha) + state * self.alpha
            out_e.append((erb[:, i] - state) / 40)
        feat_erb = torch.stack(out_e, dim=1).unsqueeze(1)
        low = spec[:, :, :self.nb_df]
        mag = low.abs()
        state = self.unit_init.expand(b, -1)
        out_c = []
        for i in range(t):
            state = mag[:, i] * (1 - self.alpha) + state * self.alpha
            out_c.append(low[:, i] / state.sqrt())
        cplx = torch.stack(out_c, dim=1)
        feat_spec = torch.stack([cplx.real, cplx.imag], dim=1)
        return feat_erb, feat_spec

    def network(self, feat_erb, feat_spec):
        e0, e1, e2, e3, emb, c0, lsnr = self.graphs['enc'](feat_erb, feat_spec)
        mask = self.graphs['erb_dec'](emb, e3, e2, e1, e0)[0]
        coefs = self.graphs['df_dec'](emb, c0)[0]
        return lsnr.squeeze(-1), mask.squeeze(1), coefs

    def apply(self, spec, lsnr, mask, coefs):
        b, t, f = spec.shape
        gains = mask[:, :, self.band_of_bin]
        masked = spec * gains
        c = coefs.reshape(b, t, self.nb_df, self.order, 2)
        c = torch.complex(c[..., 0], c[..., 1])
        low = spec[:, :, :self.nb_df]
        padded = F.pad(low.transpose(1, 2), (self.order - 1, 0)).transpose(1, 2)
        stack = padded.unfold(1, self.order, 1)
        df_out = (stack * c).sum(dim=-1)
        full = torch.cat([df_out, masked[:, :, self.nb_df:]], dim=2)
        l = lsnr.unsqueeze(-1)
        out = torch.where(l < self.min_db, torch.zeros_like(spec), torch.where(l > self.max_db_erb, spec, torch.where(l > self.max_db_df, masked, full)))
        return out

    def forward(self, x):
        spec = self.analysis(x)
        feat_erb, feat_spec = self.features(spec)
        lsnr, mask, coefs = self.network(feat_erb, feat_spec)
        enhanced = self.apply(spec, lsnr, mask, coefs)
        return {'spec': spec, 'enhanced': enhanced, 'lsnr': lsnr, 'mask': mask, 'coefs': coefs}

    def enhance(self, x):
        out = self.forward(x)
        return self.synthesis(out['enhanced'], x.shape[-1])

    def tar_bytes(self):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w:gz') as tf:
            for key in NAMES:
                data = self.graphs[key].patched(self.protos[key]).SerializeToString()
                info = tarfile.TarInfo('export/' + key + '.onnx')
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            info = tarfile.TarInfo('export/config.ini')
            info.size = len(self.cfg_text)
            tf.addfile(info, io.BytesIO(self.cfg_text))
        return buf.getvalue()

    def save(self, path):
        with open(path, 'wb') as fh:
            fh.write(self.tar_bytes())
