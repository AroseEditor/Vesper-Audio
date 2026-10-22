import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

PY = '3.12.10'
EMBED = f'https://www.python.org/ftp/python/{PY}/python-{PY}-embed-amd64.zip'
TORCH_INDEX = 'https://download.pytorch.org/whl/cpu'
PRUNE_DIRS = {'tests', 'test', '__pycache__'}
PRUNE_TOP = ['torch/include', 'torch/share']
PRUNE_EXT = {'.pdb', '.lib', '.h', '.hpp', '.cuh', '.pyi'}


def fetch(url, dest):
    with urllib.request.urlopen(url) as r, open(dest, 'wb') as f:
        shutil.copyfileobj(r, f)


def prune(site):
    for rel in PRUNE_TOP:
        path = os.path.join(site, *rel.split('/'))
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.isfile(path):
            os.remove(path)
    for root, dirs, files in os.walk(site):
        for d in list(dirs):
            if d in PRUNE_DIRS and os.sep + 'torch' + os.sep not in root + os.sep and not root.endswith(os.sep + 'torch'):
                shutil.rmtree(os.path.join(root, d), ignore_errors=True)
                dirs.remove(d)
        for f in files:
            if os.path.splitext(f)[1] in PRUNE_EXT:
                os.remove(os.path.join(root, f))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--corpus', required=True)
    ap.add_argument('--training', default=os.path.join(os.path.dirname(__file__), '..', 'training'))
    ap.add_argument('--keep', action='store_true')
    args = ap.parse_args()
    pack = os.path.join(args.out, 'pack')
    if os.path.isdir(pack):
        shutil.rmtree(pack)
    os.makedirs(pack)
    zip_path = os.path.join(args.out, 'python-embed.zip')
    if not os.path.exists(zip_path):
        fetch(EMBED, zip_path)
    python = os.path.join(pack, 'python')
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(python)
    site = os.path.join(python, 'Lib', 'site-packages')
    os.makedirs(site)
    with open(os.path.join(python, 'python312._pth'), 'w') as f:
        f.write('python312.zip\n.\nLib\\site-packages\n..\\training\n')
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--no-warn-script-location', '--target', site, '--index-url', TORCH_INDEX, '--extra-index-url', 'https://pypi.org/simple', 'torch', 'numpy', 'onnx'])
    prune(site)
    shutil.copytree(os.path.abspath(args.training), os.path.join(pack, 'training'), ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    shutil.copytree(args.corpus, os.path.join(pack, 'corpus'))
    out_zip = os.path.join(args.out, 'VesperTrainer-win-x64.zip')
    if os.path.exists(out_zip):
        os.remove(out_zip)
    with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for root, _, files in os.walk(pack):
            for name in files:
                full = os.path.join(root, name)
                z.write(full, os.path.relpath(full, pack))
    digest = hashlib.sha256(open(out_zip, 'rb').read()).hexdigest()
    with open(out_zip + '.sha256', 'w') as f:
        f.write(f'{digest}  VesperTrainer-win-x64.zip')
    print(out_zip, round(os.path.getsize(out_zip) / 1e6, 1), 'MB', digest)


if __name__ == '__main__':
    main()
