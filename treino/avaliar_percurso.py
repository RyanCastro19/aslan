"""Confere a interpretação de correntes e pinos (js/percurso.js) nas fotos com o grafo anotado à mão, COM e SEM profundidade.

    python treino/avaliar_percurso.py FOTOS.zip|PASTA                 # pinos = caixas anotadas (mede só o grafo)
    python treino/avaliar_percurso.py FOTOS.zip|PASTA --pinos modelo  # pinos = detector publicado (mede o conjunto todo, como no app)
    (FOTOS = o novos-objetos_provavel_percurso.zip; gabarito em treino/conjuntos/percurso/grafo_esperado.json)

Os outros objetos (cadeira, caixa, pessoa...) vêm dos dois detectores do app e servem de "oclusores", como no app. A imagem de análise tem
lado maior 320 px, igual à cópia que o app entrega ao módulo. Imprime, por foto, as ligações esperadas e achadas, a profundidade de cada pino
e, no fim, acertos / falsas / perdidas com e sem profundidade e a concordância da ordem de distância.
Precisa de Pillow, onnxruntime e do Node (o mesmo código do app faz a interpretação).
"""
import argparse, json, subprocess, sys, tempfile, zipfile
from pathlib import Path
from PIL import Image, ImageOps

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / 'treino'))
GABARITO = RAIZ / 'treino' / 'conjuntos' / 'percurso' / 'grafo_esperado.json'


def detector(nome):
    import onnxruntime as ort
    from avaliar import letterbox, decodificar
    pasta = RAIZ / 'modelos' / nome
    meta = json.loads((pasta / 'rotulos.json').read_text())
    s = ort.InferenceSession(str(next(pasta.glob('*.onnx'))))

    def rodar(img, nota):
        x, e, px, py = letterbox(img, meta['tamanho'])
        out = s.run([s.get_outputs()[0].name], {s.get_inputs()[0].name: x})[0]
        return decodificar(out, meta['classes'], e, px, py, *img.size, nota_min=nota)
    return rodar


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('origem')
    ap.add_argument('--pinos', choices=['anotados', 'modelo'], default='anotados')
    ap.add_argument('--tamanho', type=int, default=320)
    a = ap.parse_args()
    gab = {k: v for k, v in json.loads(GABARITO.read_text(encoding='utf-8')).items() if not k.startswith('_')}
    fab, gen = detector('fabrica'), detector('generico')
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t); org = Path(a.origem)
        if org.suffix.lower() == '.zip':
            with zipfile.ZipFile(org) as z:
                z.extractall(tmp / 'zip')
            org = tmp / 'zip'
        fotos = {f.name: f for f in org.rglob('*') if f.name in gab}
        idx = []
        for nome, g in gab.items():
            if nome not in fotos:
                print('  falta a foto', nome); continue
            img = ImageOps.exif_transpose(Image.open(fotos[nome])).convert('RGB')
            W, H = img.size
            dets = fab(img, .3)
            outros = [d for d in dets if d['classe'] != 'pino' and d['nota'] >= .45] + [d for d in gen(img, .5)]
            pinos_mod = [d for d in dets if d['classe'] == 'pino' and d['nota'] >= .35]
            px = lambda d: [d['caixa_px'][0], d['caixa_px'][1], d['caixa_px'][2] - d['caixa_px'][0], d['caixa_px'][3] - d['caixa_px'][1]]
            peq = img.copy(); peq.thumbnail((a.tamanho, a.tamanho))
            n = f'{len(idx):04d}.rgb'; (tmp / n).write_bytes(peq.tobytes())
            idx.append({'arq': n, 'w': peq.size[0], 'h': peq.size[1], 'foto': nome, 'W': W, 'H': H, 'gabarito': g,
                        'pinosAnotados': [[b[0] * W, b[1] * H, (b[2] - b[0]) * W, (b[3] - b[1]) * H] for b in g['pinos']],
                        'pinosModelo': [{'bbox': px(d), 'score': d['nota']} for d in pinos_mod],
                        'outros': [{'class': d['classe'], 'bbox': px(d)} for d in outros]})
        if not idx:
            sys.exit('nenhuma foto do gabarito em ' + a.origem)
        (tmp / 'indice.json').write_text(json.dumps(idx))
        sys.exit(subprocess.call(['node', str(RAIZ / 'treino' / 'avaliar_percurso.js'), str(tmp), a.pinos]))


if __name__ == '__main__':
    main()
