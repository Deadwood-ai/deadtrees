"""Ask a reasoning model for rough area numbers on the measured reference patches.

Same truth and quantities as decisions_magnitude.py (share of the tile, from the editors'
corrected masks), but the model writes the numbers itself instead of answering a ladder of
yes/no questions. Backends: Sol through the Codex app-server transport, or Luna through the
OpenAI Responses API. Small stratified samples first: every patch with a large error plus
random others.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import random
import re
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
from scipy.stats import spearmanr

from decisions_crops import image_url
from decisions_magnitude import measured
from decisions_patches import images
from model_transport import invoke
from sol_issue_finder import NoTools

QUANTITIES = ('dw_cover', 'fc_cover', 'dw_missed', 'dw_wrong', 'fc_missed', 'fc_wrong')
PROMPT = '''Aerial drone image tile, about 51 m by 51 m at about 5 cm per pixel. Image 1 is raw RGB,
Image 2 the DEADWOOD prediction (blue fill with outline), Image 3 the FOREST prediction (gold).
Darkened areas are outside the area of interest; ignore them.

Rules: deadwood means standing dead trees and dead parts of standing trees (grey, white, brown
or burnt crowns and branches); lying trunks, logs and debris are not deadwood. Forest means all
tree canopy, including standing dead trees; grass, crops, low shrubs and gaps between crowns
are not forest.

Estimate these areas as a percentage of the whole visible tile (0 to 100). Rough is fine, but
look carefully: compare each overlay with the raw image region by region.
- dw_cover: area of real deadwood, whatever the blue shows
- fc_cover: area of real tree canopy, whatever the gold shows
- dw_missed: real deadwood without blue
- dw_wrong: blue on things that are not deadwood
- fc_missed: real tree canopy without gold
- fc_wrong: gold on things that are not tree canopy

Return only JSON: {"dw_cover": n, "fc_cover": n, "dw_missed": n, "dw_wrong": n, "fc_missed": n, "fc_wrong": n}'''


def jpeg(image):
    stream = io.BytesIO()
    image.convert('RGB').save(stream, 'JPEG', quality=90)
    return stream.getvalue()


def parse(text):
    found = re.search(r'\{.*\}', text, re.S)
    values = json.loads(found.group(0))
    return {q: float(values[q]) for q in QUANTITIES}


def ask_sol(directory, out, effort):
    out.mkdir(parents=True, exist_ok=True)
    named = [(f'{i + 1}', jpeg(im)) for i, im in enumerate(images(directory))]
    for attempt in range(1, 5):
        try:
            text, receipt = invoke(PROMPT, named, out, 'gpt-6.1-sol', effort, NoTools())
            return parse(text), receipt.get('usage')
        except ValueError as e:
            if not any(t in str(e) for t in ('serverOverloaded', 'at capacity', 'stream disconnected')) or attempt == 4:
                raise
            time.sleep(60 * attempt)


def ask_luna(directory, key, effort):
    content = [{'type': 'input_text', 'text': PROMPT}] + [
        {'type': 'input_image', 'image_url': image_url(im), 'detail': 'original'} for im in images(directory)]
    payload = {'model': 'gpt-6-luna', 'input': [{'role': 'user', 'content': content}]}
    if effort:
        payload['reasoning'] = {'effort': effort}
    for attempt in range(4):
        try:
            request = Request('https://api.openai.com/v1/responses', data=json.dumps(payload).encode(), method='POST',
                              headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
            with urlopen(request, timeout=300) as response:
                raw = json.loads(response.read(2_000_001))
            break
        except HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise RuntimeError(f'HTTP {e.code}: {e.read(400).decode(errors="replace")}') from None
            time.sleep(10 * (attempt + 1))
    text = ''.join(c.get('text', '') for item in raw.get('output', []) if item.get('type') == 'message'
                   for c in item.get('content', []))
    return parse(text), raw.get('usage')


def sample(truth_dir, n, seed=1):
    dirs = sorted(d for d in truth_dir.iterdir() if (d / 'truth.json').exists())
    m = {d: measured(json.loads((d / 'truth.json').read_text())) for d in dirs}
    big = [d for d in dirs if max(m[d][q] for q in QUANTITIES[2:]) > 10 or m[d]['dw_cover'] > 10]
    rest = [d for d in dirs if d not in big]
    random.Random(seed).shuffle(big); random.Random(seed).shuffle(rest)
    take = big[:n // 2]
    return take + rest[:n - len(take)]


def report(rows):
    out = {}
    for q in QUANTITIES:
        est = np.array([r['estimate'][q] for r in rows]); true = np.array([r['measured'][q] for r in rows])
        big, called = true > 10, est > 10
        out[q] = {'n': len(rows), 'spearman': round(float(spearmanr(est, true).statistic), 2),
                  'mae_pp': round(float(np.abs(est - true).mean()), 1),
                  'big_caught': f'{int((called & big).sum())}/{int(big.sum())}',
                  'false_big': f'{int((called & ~big).sum())}/{int((~big).sum())}'}
    return out


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--truth', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--backend', choices=('sol', 'luna'), required=True)
    p.add_argument('--effort', default='high')
    p.add_argument('--key-file', type=Path, help='OpenAI key file, Luna only')
    p.add_argument('--n', type=int, default=20)
    p.add_argument('--workers', type=int, default=4)
    a = p.parse_args()
    key = None
    if a.backend == 'luna':
        from decisions_runner import read_key
        key = read_key(a.key_file)
    a.run.mkdir(parents=True, exist_ok=True)

    def one(directory):
        path = a.run / f'{directory.name}.json'
        if path.exists():
            return json.loads(path.read_text())
        truth = json.loads((directory / 'truth.json').read_text())
        try:
            if a.backend == 'sol':
                estimate, usage = ask_sol(directory, a.run / 'trials' / directory.name, a.effort)
            else:
                estimate, usage = ask_luna(directory, key, a.effort)
        except Exception as e:
            print(directory.name, type(e).__name__, str(e)[:200])
            return None
        r = {'patch_id': truth['patch_id'], 'measured': measured(truth), 'estimate': estimate, 'usage': usage}
        path.write_text(json.dumps(r))
        return r

    with ThreadPoolExecutor(a.workers) as pool:
        rows = [r for r in pool.map(one, sample(a.truth, a.n)) if r]
    result = report(rows)
    (a.run / 'scores.json').write_text(json.dumps(result, indent=1) + '\n')
    for q, e in result.items():
        print(f"{q:10s} n={e['n']} spearman={e['spearman']:+.2f} mae={e['mae_pp']}pp "
              f"big caught {e['big_caught']}, small called big {e['false_big']}")
