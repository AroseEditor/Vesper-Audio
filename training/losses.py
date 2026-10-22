import torch
import torch.nn.functional as F

GAMMA = 0.3
N_FFTS = (256, 512, 1024, 2048)


def spectrum(x, n_fft):
    window = torch.hann_window(n_fft, device=x.device)
    return torch.stft(x, n_fft, hop_length=n_fft // 4, window=window, return_complex=True, normalized=True)


def compress(y):
    mag = y.abs().clamp_min(1e-12)
    return mag.pow(GAMMA), y / mag * mag.pow(GAMMA)


def multires(out, ref, factor=500.0, factor_complex=500.0):
    total = out.new_zeros(())
    for n in N_FFTS:
        y_mag, y_c = compress(spectrum(out, n))
        s_mag, s_c = compress(spectrum(ref, n))
        total = total + F.mse_loss(y_mag, s_mag) * factor + F.mse_loss(torch.view_as_real(y_c), torch.view_as_real(s_c)) * factor_complex
    return total


def over_attenuation(out, ref, factor=500.0):
    y_mag, _ = compress(spectrum(out, 1024))
    s_mag, _ = compress(spectrum(ref, 1024))
    return F.relu(s_mag - y_mag).pow(2).mean() * factor


def frame_db(x, frame=960, hop=480):
    frames = x.unfold(-1, frame, hop)
    return 10 * torch.log10(frames.pow(2).mean(-1) + 1e-10)


def cut_penalty(out, ref, floor_db=-55.0, slack_db=1.5):
    e_ref = frame_db(ref)
    e_out = frame_db(out)
    speech = (e_ref > floor_db).float()
    drop = F.relu(e_ref - e_out - slack_db)
    return (drop * speech).sum() / speech.sum().clamp_min(1.0)


def leak_penalty(out, ref, silence_db=-65.0, ceiling_db=-62.0):
    e_ref = frame_db(ref)
    e_out = frame_db(out)
    quiet = (e_ref < silence_db).float()
    excess = F.relu(e_out - ceiling_db)
    return (excess * quiet).sum() / quiet.sum().clamp_min(1.0)


def local_snr(model, ref, parts):
    s = model.analysis(ref)
    n = model.analysis(parts)
    e_s = (s.real ** 2 + s.imag ** 2).sum(-1)
    e_n = (n.real ** 2 + n.imag ** 2).sum(-1)
    return (10 * torch.log10((e_s + 1e-9) / (e_n + 1e-9))).clamp(-15.0, 35.0)


def total_loss(model, noisy, ref, parts, weights):
    out = model(noisy)
    n = noisy.shape[-1]
    wav = model.synthesis(out['enhanced'], n)
    ref_wav = model.synthesis(model.analysis(ref), n)
    terms = {
        'mr': multires(wav, ref_wav),
        'oa': over_attenuation(wav, ref_wav),
        'cut': cut_penalty(wav, ref_wav),
        'leak': leak_penalty(wav, ref_wav),
        'lsnr': F.mse_loss(out['lsnr'], local_snr(model, ref, parts)) * 1e-3,
    }
    loss = sum(weights[k] * v for k, v in terms.items())
    return loss, terms
