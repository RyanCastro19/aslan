"""Fotos de correntes e pinos (novos-objetos_provavel_percurso.zip) → conjunto YOLO com a classe nova "pino", somado ao banco unificado.

  python treino/percurso_fotos.py preparar FOTOS.zip|PASTA --banco PASTA_YOLO_FINAL [--dobra validacao|final]
      FOTOS:  o zip (ou pasta) com as fotos .jpeg e o percurso_video.mp4 (o vídeo vira 1 quadro por segundo, v_NNN.jpg, com ffmpeg)
      BANCO:  yolo-final/ do banco unificado (banco_unificado_fotos.zip, as 59 fotos das 10 classes) — entra inteiro no treino
  python treino/treinar.py --pasta treino/conjuntos/percurso/yolo-final         (treino normal; classes.txt traz a lista com "pino")

Rótulos de cada foto nova:
  - pino: as caixas REVISADAS de treino/conjuntos/percurso/anotacoes_pinos.json (no git);
  - as outras 10 classes (caixa, cadeira, pessoa, planta...): o modelo PUBLICADO rotula com nota >= --nota (pseudo-rótulo), só as classes que
    existem nesta sala; caixa que cai em cima de um pino é descartada. Sem isso, o treino aprenderia que a cadeira destas fotos "não é nada"
    e o modelo pioraria nas classes antigas.
Dobra "validacao": as 8 fotos com o grafo anotado à mão (grafo_esperado.json) e os quadros 41–50 do vídeo ficam fora do treino.
Dobra "final": tudo no treino (o modelo publicado).

Para ADICIONAR fotos novas no futuro: ponha as fotos na pasta, rode `percurso_fotos.py propor PASTA` (pré-anotação por prompt visual com
YOLOE a partir dos pinos já anotados; grava propostas_pinos.json), revise as caixas (apague o que não é pino), copie para anotacoes_pinos.json
e rode `preparar` + `treinar.py` de novo.
"""
import argparse
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
APP = RAIZ.parent
PASTA = RAIZ / 'conjuntos' / 'percurso'
from classes import CLASSES  # noqa: E402

PSEUDO = ['caixa', 'cadeira', 'pessoa', 'planta']   # classes antigas que aparecem nesta sala
VALIDACAO = {f'percurso_fotos ({n}).jpeg' for n in (1, 5, 7, 8, 9, 10, 11, 14)} | {f'v_{n:03d}.jpg' for n in range(41, 51)}


def abrir(entrada, tmp):
    entrada = Path(entrada)
    if entrada.suffix == '.zip':
        with zipfile.ZipFile(entrada) as z:
            z.extractall(tmp)
        entrada = Path(tmp)
    fotos = {p.name: p for p in entrada.rglob('*') if p.suffix.lower() in ('.jpg', '.jpeg', '.png') and not p.name.startswith('v_')}
    for v in entrada.rglob('*.mp4'):
        q = Path(tmp) / 'quadros'
        q.mkdir(exist_ok=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(v), '-vf', 'fps=1', str(q / 'v_%03d.jpg')], check=True)
        fotos.update({p.name: p for p in q.glob('v_*.jpg')})
    return fotos


def iou_dentro(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0, 0.0
    i = w * h
    aa, ab = (a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])
    return i / (aa + ab - i), i / aa


def pseudo_rotulos(img, nota):
    """Caixas das classes antigas pelo modelo publicado (mesmo pré-processamento do app, via treino/avaliar.py)."""
    import numpy as np  # noqa: F401
    import onnxruntime as ort
    from avaliar import letterbox, decodificar
    if not hasattr(pseudo_rotulos, 's'):
        meta = json.loads((APP / 'modelos' / 'fabrica' / 'rotulos.json').read_text())
        pseudo_rotulos.s = ort.InferenceSession(str(APP / 'modelos' / 'fabrica' / 'yolo-fabrica.onnx'))
        pseudo_rotulos.meta = meta
    s, meta = pseudo_rotulos.s, pseudo_rotulos.meta
    x, e, px, py = letterbox(img, meta['tamanho'])
    out = s.run([s.get_outputs()[0].name], {s.get_inputs()[0].name: x})[0]
    W, H = img.size
    return [(d['classe'], [d['caixa_px'][0] / W, d['caixa_px'][1] / H, d['caixa_px'][2] / W, d['caixa_px'][3] / H])
            for d in decodificar(out, meta['classes'][:10], e, px, py, W, H, nota_min=nota) if d['classe'] in PSEUDO]


def linha(classe, b):
    x1, y1, x2, y2 = (min(1.0, max(0.0, v)) for v in b)
    return f'{CLASSES.index(classe)} {(x1 + x2) / 2:.6f} {(y1 + y2) / 2:.6f} {x2 - x1:.6f} {y2 - y1:.6f}'


def preparar(entrada, banco, dobra, nota):
    from PIL import Image
    anot = json.loads((PASTA / 'anotacoes_pinos.json').read_text(encoding='utf-8'))
    saida = PASTA / f'yolo-{dobra}'
    if saida.exists():
        shutil.rmtree(saida)
    for p in ('images/train', 'images/val', 'labels/train', 'labels/val'):
        (saida / p).mkdir(parents=True)
    banco = Path(banco)
    # banco unificado (10 classes): os índices não mudam, porque "pino" entrou no FIM de CLASSES
    n_banco = 0
    for parte in ('train', 'val'):
        for img in (banco / 'images' / parte).glob('*'):
            lab = banco / 'labels' / parte / (img.stem + '.txt')
            for destino in (['train', 'val'] if dobra == 'final' and parte == 'val' else ['train' if dobra == 'final' or parte == 'train' else 'val']):
                shutil.copy(img, saida / 'images' / destino / img.name)
                shutil.copy(lab, saida / 'labels' / destino / lab.name) if lab.exists() else (saida / 'labels' / destino / (img.stem + '.txt')).write_text('')
            n_banco += 1
    div = {'treino': [], 'validacao': [], 'pinos': 0, 'pseudo': {}}
    with tempfile.TemporaryDirectory() as tmp:
        fotos = abrir(entrada, tmp)
        for nome, caixas in anot['fotos'].items():
            if nome not in fotos:
                print('  falta a foto', nome)
                continue
            img = Image.open(fotos[nome]).convert('RGB')
            linhas = [linha('pino', b) for b in caixas]
            for c, b in pseudo_rotulos(img, nota):
                if any(max(iou_dentro(b, p)[0], iou_dentro(b, p)[1] * .8) > .4 for p in caixas):
                    continue
                linhas.append(linha(c, b))
                div['pseudo'][c] = div['pseudo'].get(c, 0) + 1
            parte = 'val' if dobra == 'validacao' and nome in VALIDACAO else 'train'
            base = 'perc_' + Path(nome).stem.replace(' ', '_').replace('(', '').replace(')', '')
            # dobra final: as fotos de validação ficam no treino E numa cópia em val (só referência dentro da amostra, como no banco unificado)
            for pt in [parte] + (['val'] if dobra == 'final' and nome in VALIDACAO else []):
                img.save(saida / 'images' / pt / (base + '.jpg'), quality=92)
                (saida / 'labels' / pt / (base + '.txt')).write_text('\n'.join(linhas) + ('\n' if linhas else ''))
            div['treino' if parte == 'train' else 'validacao'].append(nome)
            div['pinos'] += len(caixas)
    (saida / 'classes.txt').write_text('\n'.join(CLASSES) + '\n', encoding='utf-8')
    (saida / 'data.yaml').write_text(f'path: {saida}\ntrain: images/train\nval: images/val\nnames:\n' +
                                     ''.join(f'  {i}: {c}\n' for i, c in enumerate(CLASSES)))
    div['versao'] = f'percurso+banco ({dobra})'
    div['banco_unificado'] = n_banco
    (saida / 'divisao.json').write_text(json.dumps(div, ensure_ascii=False, indent=1))
    print(f"{saida}: {len(div['treino'])} fotos novas no treino, {len(div['validacao'])} na validação, {div['pinos']} pinos, "
          f"pseudo-rótulos {div['pseudo']}, banco unificado {n_banco}")


def propor(pasta, conf=0.3):
    """Pré-anotação de pinos em fotos novas por prompt visual (YOLOE), usando como exemplo duas fotos já anotadas."""
    import numpy as np
    from PIL import Image
    from ultralytics import YOLOE
    from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor
    anot = json.loads((PASTA / 'anotacoes_pinos.json').read_text(encoding='utf-8'))
    ref_pasta = Path(pasta)
    m = YOLOE('yoloe-11l-seg.pt')
    refs = [n for n in ('percurso_fotos (11).jpeg', 'percurso_fotos (14).jpeg') if (ref_pasta / n).exists()]
    if not refs:
        raise SystemExit('coloque na pasta também percurso_fotos (11).jpeg e (14).jpeg (exemplos de pino para o prompt visual)')
    saida = {}
    for f in sorted(ref_pasta.glob('*')):
        if f.suffix.lower() not in ('.jpg', '.jpeg', '.png'):
            continue
        cand = []
        for r in refs:
            W, H = Image.open(ref_pasta / r).size
            bb = np.array([[b[0] * W, b[1] * H, b[2] * W, b[3] * H] for b in anot['fotos'][r]])
            res = m.predict(str(f), refer_image=str(ref_pasta / r), visual_prompts=dict(bboxes=bb, cls=np.zeros(len(bb), dtype=int)),
                            predictor=YOLOEVPSegPredictor, conf=conf, verbose=False)[0]
            cand += list(zip(res.boxes.conf.tolist(), res.boxes.xyxyn.tolist()))
        cand.sort(key=lambda c: -c[0])
        fica = []
        for s, b in cand:
            if all(max(iou_dentro(b, f2)[0], iou_dentro(b, f2)[1] * .8) < .55 for _, f2 in fica):
                fica.append((s, b))
        saida[f.name] = [[round(v, 3) for v in b] + [round(s, 2)] for s, b in fica]
    (PASTA / 'propostas_pinos.json').write_text(json.dumps(saida, indent=0))
    print('propostas em', PASTA / 'propostas_pinos.json', '— revise antes de copiar para anotacoes_pinos.json')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('preparar')
    a.add_argument('entrada')
    a.add_argument('--banco', required=True)
    a.add_argument('--dobra', choices=['validacao', 'final'], default='final')
    a.add_argument('--nota', type=float, default=0.6)
    b = sub.add_parser('propor')
    b.add_argument('pasta')
    x = ap.parse_args()
    if x.cmd == 'preparar':
        preparar(x.entrada, x.banco, x.dobra, x.nota)
    else:
        propor(x.pasta)


if __name__ == '__main__':
    main()
