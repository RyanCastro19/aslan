'use strict';
// Usado por treino/avaliar_percurso.py: aplica js/percurso.js (o mesmo código do app) às fotos com grafo anotado, com e sem profundidade.
const fs = require('fs'), path = require('path');
const VP = require(path.join(__dirname, '..', 'js', 'percurso.js'));
const dir = process.argv[2], modo = process.argv[3] || 'anotados';
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'indice.json'), 'utf8'));
const iou = (a, b) => { const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]), h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0; const i = w*h; return i/(a[2]*a[3] + b[2]*b[3] - i); };
const par = (a, b) => [a, b].sort((x, y) => x - y).join('-');

function avaliar(usarZ){
  const c = {acertos: 0, falsas: 0, perdidas: 0, paresOrdem: 0, ordemCerta: 0, pinosAchados: 0, pinosAnotados: 0}; let ms = 0;
  const linhas = [];
  for (const it of idx){
    const rgb = fs.readFileSync(path.join(dir, it.arq)), px = new Uint8ClampedArray(it.w*it.h*4);
    for (let i = 0; i < it.w*it.h; i++){ px[4*i] = rgb[3*i]; px[4*i+1] = rgb[3*i+1]; px[4*i+2] = rgb[3*i+2]; px[4*i+3] = 255; }
    const anot = it.pinosAnotados;
    // pinos de entrada e o índice do gabarito de cada um (modelo: o pino anotado de maior IoU, se > 0,3)
    const entrada = modo === 'modelo' ? it.pinosModelo : anot.map(b => ({bbox: b, score: .8}));
    const gabDe = entrada.map(p => { if (modo !== 'modelo') return entrada.indexOf(p);
      let m = -1, best = .3; anot.forEach((b, k) => { const v = iou(p.bbox, b); if (v > best){ best = v; m = k; } }); return m; });
    c.pinosAnotados += anot.length; c.pinosAchados += new Set(gabDe.filter(k => k >= 0)).size;
    const perc = VP.criarPercurso(usarZ ? {} : {confZDecide: 2});   // confZDecide 2: nenhuma profundidade é "confiável" → sem uso de Z
    const r = perc.analisar({pinos: entrada.map((p, i) => ({id: i, bbox: p.bbox, score: p.score})), outros: it.outros, img: {data: px, w: it.w, h: it.h}, W: it.W, H: it.H});
    if (r) ms += r.ms;
    const achadas = r ? r.grafo.arestas.map(e => gabDe[e.a] >= 0 && gabDe[e.b] >= 0 ? par(gabDe[e.a], gabDe[e.b]) : 'x' + e.a + '-' + e.b) : [];
    const esperadas = it.gabarito.arestas.map(e => par(e[0], e[1]));
    const ok = achadas.filter(e => esperadas.includes(e)).length;
    c.acertos += ok; c.falsas += achadas.length - ok; c.perdidas += esperadas.length - ok;
    // ordem de distância: para cada par de pinos do gabarito com Z estimado, o mais perto pela estimativa é o mais perto anotado?
    const ordem = it.gabarito.ordem_distancia || [], zDe = {};
    if (r) r.cena.nos.forEach(n => { if (gabDe[n.id] >= 0 && n.z != null) zDe[gabDe[n.id]] = n.z; });
    for (let i = 0; i < ordem.length; i++) for (let j = i + 1; j < ordem.length; j++){
      const zi = zDe[ordem[i]], zj = zDe[ordem[j]]; if (zi == null || zj == null) continue;
      c.paresOrdem++; if (zi <= zj) c.ordemCerta++;
    }
    if (process.env.DETALHE && r) for (const e of [...r.grafo.rejeitadas.filter(e => e.medida && e.medida.cobertura > .3), ...r.grafo.arestas.map(e => Object.assign({}, e, {motivos: ["ACEITA desvio3D " + e.desvio3D + " vao " + e.vaoM]}))])
      linhas.push('    recusada ' + e.a + '-' + e.b + ': ' + e.motivos.join('; ') + ' ' + JSON.stringify({cobertura: +e.medida.cobertura.toFixed(2),
        contraste: +e.medida.contraste.toFixed(2), visivel: +e.medida.visivel.toFixed(2), buraco: +e.medida.buraco.toFixed(2), pontas: +(e.medida.pontas ?? 0).toFixed(2), amarelo: +e.medida.amarelo.toFixed(2)}));
    linhas.push(it.foto.padEnd(26) + ' esperadas ' + (esperadas.join(',') || '-').padEnd(9) + ' achadas ' + (achadas.join(',') || '-').padEnd(9) +
      (r ? ' | Z ' + r.cena.nos.map(n => (gabDe[n.id] >= 0 ? gabDe[n.id] : '?') + ':' + (n.z == null ? '?' : n.z.toFixed(1) + 'm') + '/' + n.confZ.toFixed(2)).join(' ') : ' | sem pinos'));
  }
  return {c, ms: ms/idx.length, linhas};
}

const com = avaliar(true), sem = avaliar(false);
console.log('Pinos: ' + (modo === 'modelo' ? 'detector publicado' : 'caixas anotadas') + '\n\nCOM profundidade');
com.linhas.forEach(l => console.log('  ' + l));
console.log('\nSEM profundidade (vão em metros, desvio 3D e planos desligados)');
sem.linhas.forEach(l => console.log('  ' + l));
const fmt = x => `acertos ${x.c.acertos}, falsas ${x.c.falsas}, perdidas ${x.c.perdidas}`;
console.log('\nLigações COM profundidade: ' + fmt(com) + ` · ${com.ms.toFixed(0)} ms por foto (Node)`);
console.log('Ligações SEM profundidade: ' + fmt(sem));
console.log(`Ordem de distância: ${com.c.ordemCerta} de ${com.c.paresOrdem} pares certos`);
if (modo === 'modelo') console.log(`Pinos anotados achados pelo detector: ${com.c.pinosAchados} de ${com.c.pinosAnotados}`);
