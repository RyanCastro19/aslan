'use strict';
// Correntes, pinos, trajetórias e profundidade (js/percurso.js) — cenas sintéticas desenhadas com a MESMA câmera que o módulo supõe
// (pinos de 0,95 m no piso, celular a 1,25 m, campo de visão 65°), mais a integração com a decisão (js/nucleo.js) e com o app (js/app.js).
// Validação nas fotos reais: treino/avaliar_percurso.js (precisa das fotos, que não vão para o git).
const test = require('node:test'), assert = require('node:assert/strict');
const PC = require('../js/percurso.js');
const {montar, d, sleep, criarNucleoVisio} = require('./apoio.js');

// ---------- cena sintética ----------
const P = PC.P;
function camera(W, H){ const f = PC.focal(W, H), yh = H/2; return {W, H, f, yh,
  proj: (X, Y, Z) => [W/2 + f*X/Z, yh + f*(P.alturaCamera - Y)/Z]}; }   // Y = altura acima do piso (m)
// pino no piso em (X, Z): caixa no QUADRO
function pino(cam, X, Z, larg = .3){
  const [x, yPe] = cam.proj(X, 0, Z), [, yTopo] = cam.proj(X, P.alturaPino, Z), w = cam.f*larg/Z;
  return {X, Z, bbox: [x - w/2, yTopo, w, yPe - yTopo]};
}
// Desenha na imagem pequena (w×h): parede clara em cima, piso claro embaixo, pinos listrados amarelo/preto com base preta e correntes.
function desenhar(cam, w, h, {pinos = [], correntes = [], retangulos = [], faixas = []}){
  const k = w/cam.W, px = new Uint8ClampedArray(w*h*4), hor = cam.yh*k;
  const pinta = (x, y, [r, g, b]) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return; const i = 4*(y*w + x); px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = 255; };
  let sem = 7; const rnd = () => (sem = (sem*16807) % 2147483647)/2147483647;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){ const v = y < hor*1.15 ? 228 : 200 + Math.round(rnd()*14) - 7; pinta(x, y, [v, v, v + 2]); }
  for (const f of faixas) for (let y = f.y0; y <= f.y1; y++) for (let x = f.x0; x <= f.x1; x++) pinta(x*k, y*k, f.cor);   // em coordenadas do quadro
  for (const p of pinos){
    const [x, y, bw, bh] = p.bbox.map(v => v*k), haste = Math.max(1.5, bw*.25);
    for (let yy = y; yy <= y + bh; yy++){
      const base = yy > y + bh*.82, meia = base ? bw/2 : haste/2, cor = base ? [25, 25, 25] : (Math.floor((yy - y)/Math.max(2, bh/12)) % 2 ? [235, 200, 30] : [25, 25, 25]);
      for (let xx = x + bw/2 - meia; xx <= x + bw/2 + meia; xx++) pinta(xx, yy, cor);
    }
  }
  // corrente: catenária aproximada em 3D entre os ganchos dos dois pinos, projetada; elos alternando a cor; `gap` apaga um trecho
  for (const c of correntes){
    const a = c.a, b = c.b, sag = c.barriga ?? .25, n = 400;
    for (let i = 0; i <= n; i++){
      const t = i/n; if (c.gap && t > c.gap[0] && t < c.gap[1]) continue;
      const X = a.X + (b.X - a.X)*t, Z = a.Z + (b.Z - a.Z)*t, Y = P.alturaPino*.96 - sag*4*t*(1 - t);
      const [u, v] = cam.proj(X, Y, Z), cor = c.cor || (Math.floor(t*20) % 2 ? [235, 200, 30] : [25, 25, 25]);
      for (let e = 0; e < (c.espessura || 2); e++) pinta(u*k, v*k + e, cor);
    }
  }
  for (const r of retangulos) for (let y = r.bbox[1]; y <= r.bbox[1] + r.bbox[3]; y += 1/k) for (let x = r.bbox[0]; x <= r.bbox[0] + r.bbox[2]; x += 1/k) pinta(x*k, y*k, r.cor || [40, 40, 45]);
  return {data: px, w, h};
}
const W = 960, H = 1280, w = 240, h = 320;
function analisar(cena, op = {}, outros = []){
  const cam = camera(W, H), img = desenhar(cam, w, h, cena);
  const pinos = cena.pinos.map((p, i) => ({id: i, bbox: p.bbox, score: .85}));
  const r = PC.criarPercurso(op).analisar({pinos, outros, img, W, H});
  if (process.env.DEP) console.log(JSON.stringify({z: r.cena.nos.map(n => [n.id, +(n.z ?? -1).toFixed(2), +n.confZ.toFixed(2)]), ok: r.grafo.arestas.map(a => [a.a, a.b, +a.confianca.toFixed(2), a.desvio3D]), rej: r.grafo.rejeitadas.map(a => [a.a, a.b, a.motivos.join(';'), a.medida && {c: +a.medida.cobertura.toFixed(2), ct: +a.medida.contraste.toFixed(2), v: +a.medida.visivel.toFixed(2), b: +a.medida.buraco.toFixed(2), p: +(a.medida.pontas ?? 0).toFixed(2)}])}));
  return r;
}
const ligadas = r => r.grafo.arestas.map(a => [a.a, a.b].sort().join('-')).sort();
const SEM_PROF = {confZDecide: 2};     // a profundidade nunca decide (comparação "sem profundidade")

test('percurso: profundidade 2.5D — Z pela altura do pino e pelo contato no piso, horizonte pelos próprios pinos, camadas perto/meio/fundo', () => {
  const cam = camera(W, H), pinos = [pino(cam, -.6, 2.2), pino(cam, .8, 3.4), pino(cam, .2, 7)];
  const c = PC.estimarCena(pinos.map((p, i) => ({id: i, bbox: p.bbox, score: .9})), [], W, H);
  assert.ok(Math.abs(c.horizonte - H/2) < 4, 'horizonte ' + c.horizonte);
  pinos.forEach((p, i) => assert.ok(Math.abs(c.nos[i].z - p.Z)/p.Z < .05, `Z ${c.nos[i].z} ≠ ${p.Z}`));
  assert.deepEqual(c.nos.map(n => n.camada), ['meio', 'meio', 'fundo']);
  const pe = pino(cam, 0, 1.3), cp = PC.estimarCena([{id: 0, bbox: [pe.bbox[0], pe.bbox[1], pe.bbox[2], H - pe.bbox[1]], score: .9}, ...pinos.map((p, i) => ({id: i + 1, bbox: p.bbox, score: .9}))], [], W, H);
  assert.equal(cp.nos[0].camada, 'perto', 'pé abaixo do quadro com horizonte conhecido: perto'); assert.ok(Math.abs(cp.nos[0].z - 1.3) < .35, cp.nos[0].z);
  assert.ok(c.nos.every(n => n.confZ > .6));
  // celular inclinado (horizonte deslocado): o horizonte sai dos pinos e o Z continua certo
  const desl = pinos.map((p, i) => ({id: i, bbox: [p.bbox[0], p.bbox[1] + 120, p.bbox[2], p.bbox[3]], score: .9}));
  const c2 = PC.estimarCena(desl, [], W, H);
  assert.ok(Math.abs(c2.horizonte - (H/2 + 120)) < 4);
  pinos.forEach((p, i) => assert.ok(Math.abs(c2.nos[i].z - p.Z)/p.Z < .05));
});

test('percurso: estimativa de BAIXA confiança — pino cortado/escondido ou sem horizonte fica "incerta" e NÃO é descartado por distância', () => {
  const cam = camera(W, H), perto = pino(cam, 0, 1.2), longe = pino(cam, .5, 8);
  // perto com o pé fora do quadro (cortado), longe sozinho: horizonte de 1 pino só
  const cortado = {id: 0, bbox: [perto.bbox[0], perto.bbox[1], perto.bbox[2], H - perto.bbox[1]], score: .9};
  const c = PC.estimarCena([cortado, {id: 1, bbox: longe.bbox, score: .9}], [], W, H);
  assert.ok(c.nos[0].confZ < .5 && c.nos[0].camada === 'incerta', JSON.stringify(c.nos[0].pistasZ));
  // pé escondido atrás de uma caixa detectada: sem a pista do piso
  const caixa = {bbox: [longe.bbox[0] - 40, longe.bbox[1] + longe.bbox[3]*.6, 200, 400], class: 'caixa'};
  const c2 = PC.estimarCena([{id: 0, bbox: longe.bbox, score: .9}], [caixa], W, H);
  assert.ok(c2.nos[0].pePorTras && c2.nos[0].confZ < .5);
  // pino incerto, sozinho e "longe" na estimativa: continua relevante (incerteza nunca descarta)
  const r = analisar({pinos: [longe]}, {}, [caixa]);
  assert.equal(r.grafo.nos[0].relevante, true); assert.match(r.grafo.nos[0].relevancia, /incerta/);
});

test('percurso: pinos PERTO e LONGE na mesma imagem — a corrente perto é ligada; o pino solto do fundo é ignorado na decisão', () => {
  const cam = camera(W, H), a = pino(cam, -.9, 2), b = pino(cam, .9, 2.4), fundo = pino(cam, .05, 8);
  const r = analisar({pinos: [a, b, fundo], correntes: [{a, b}]});
  assert.deepEqual(ligadas(r), ['0-1']);
  assert.equal(r.grafo.nos[2].relevante, false); assert.match(r.grafo.nos[2].relevancia, /ignorado/);
  assert.deepEqual(r.ignorados, [2]);
  assert.ok(r.zonas.frente.length, 'a corrente perto cruza a frente'); assert.ok(r.zonas.frente[0].cruza);
});

test('percurso: correntes SOBREPOSTAS em planos diferentes — cada uma liga os pinos do seu plano, nenhuma ligação cruza os planos', () => {
  const cam = camera(W, H), a = pino(cam, -.6, 2), b = pino(cam, .6, 2.2), c = pino(cam, -1.8, 6.5), dd = pino(cam, 2.2, 6.8);
  const r = analisar({pinos: [a, b, c, dd], correntes: [{a, b}, {a: c, b: dd, barriga: .15}]});
  assert.deepEqual(ligadas(r), ['0-1', '2-3']);
  const frente = r.zonas.frente.map(z => z.aresta);
  assert.ok(frente.includes('0-1') && !frente.includes('2-3'), 'só a corrente perto é barreira à frente (a do fundo está além de ' + P.zonaPertoZ + ' m): ' + frente);
});

test('percurso: objetos de fundo parecidos — faixa amarela e preta pintada e cadeira escura entre dois pinos NÃO viram corrente', () => {
  const cam = camera(W, H), a = pino(cam, -.9, 2.5), b = pino(cam, .9, 2.5);
  // faixa larga amarela e preta (tipo fita de chão) atravessando a imagem entre os pinos, e um retângulo escuro grande (cadeira)
  const ya = a.bbox[1] + 40;
  const r = analisar({pinos: [a, b], faixas: [{x0: 0, x1: W, y0: ya + 60, y1: ya + 170, cor: [230, 195, 35]}], retangulos: [{bbox: [W*.35, ya - 30, W*.3, 330]}]});
  assert.deepEqual(ligadas(r), [], 'mancha larga não é linha fina: ' + JSON.stringify(r.grafo.rejeitadas.map(x => x.motivos)));
  // pino listrado distante e solto no fundo, parecido com os da frente: não entra no grafo nem na decisão
  const fundo = pino(cam, 0, 9);
  const r2 = analisar({pinos: [a, b, fundo], correntes: [{a, b}]});
  assert.deepEqual(ligadas(r2), ['0-1']); assert.deepEqual(r2.ignorados, [2]);
});

test('percurso: corrente PARCIALMENTE OCULTA atrás de um objeto detectado é aceita; a mesma falta sem objeto (corrente partida) não é', () => {
  const cam = camera(W, H), a = pino(cam, -1, 2.5), b = pino(cam, 1, 2.5);
  const [ux] = cam.proj(-.25, 0, 2.5), [vx] = cam.proj(.25, 0, 2.5), caixa = {bbox: [ux, 300, vx - ux, 900], class: 'caixa'};
  const oculta = analisar({pinos: [a, b], correntes: [{a, b, gap: [.38, .62]}], retangulos: [{bbox: caixa.bbox, cor: [160, 120, 80]}]}, {}, [caixa]);
  assert.deepEqual(ligadas(oculta), ['0-1']);
  assert.ok(oculta.grafo.arestas[0].medida.ocultoRel > .1, 'trecho oculto registrado');
  const partida = analisar({pinos: [a, b], correntes: [{a, b, gap: [.3, .7]}]});
  assert.deepEqual(ligadas(partida), [], 'buraco sem objeto na frente é falta de evidência');
  assert.match(partida.grafo.rejeitadas[0].motivos.join(' '), /continuidade|interrup/);
});

test('percurso: mudança de PERSPECTIVA — corrente que se afasta da câmera (quase vertical na imagem) vira barreira lateral; dois lados formam corredor', () => {
  const cam = camera(W, H), e1 = pino(cam, -.55, 2), e2 = pino(cam, -.55, 3.8), d1 = pino(cam, .55, 2), d2 = pino(cam, .55, 3.8);
  const r = analisar({pinos: [e1, e2, d1, d2], correntes: [{a: e1, b: e2}, {a: d1, b: d2}]});
  assert.deepEqual(ligadas(r), ['0-1', '2-3']);
  assert.ok(r.zonas.esquerda.length && r.zonas.direita.length);
  assert.equal(r.zonas.frente.length, 0, 'as paredes do corredor não bloqueiam a frente');
  assert.equal(r.corredor && r.corredor.direcao, 'frente');
  // corredor que vira: a parede do fundo (corrente atravessando lá longe) fecha a frente → o corredor segue para o lado aberto
  const f1 = pino(cam, .3, 5.4);
  const r2 = analisar({pinos: [e1, e2, d1, d2, f1], correntes: [{a: e1, b: e2}, {a: d1, b: d2}, {a: e2, b: f1}]});
  assert.ok(ligadas(r2).includes('1-4'));
});

test('percurso: objetos que PARECEM ligados mas não estão — pino do fundo entre os pinos da frente; corrente do fundo atrás do gancho de um pino da frente', () => {
  const cam = camera(W, H), a = pino(cam, -.7, 2.2), b = pino(cam, .7, 2.2);
  // pino do fundo bem no meio, entre os dois da frente na imagem (parece "no caminho" da corrente, mas está 7 m atrás)
  const c = pino(cam, .1, 9);
  const r = analisar({pinos: [a, b, c], correntes: [{a, b}]});
  assert.deepEqual(ligadas(r), ['0-1']);
  const rec = r.grafo.rejeitadas.filter(x => x.a === 2 || x.b === 2).map(x => x.motivos.join('; ')).join(' | ');
  assert.ok(rec.length, 'as ligações com o pino do fundo foram avaliadas e recusadas');
  assert.deepEqual(r.ignorados, [2]);
  // corrente do FUNDO (8 m, barriga de 0,5 m) que, na imagem, passa exatamente pelo gancho de um pino da frente (3,2 m):
  // sem profundidade, parece que a corrente está presa nele; com profundidade, ele está em outro plano e a corrente do fundo é uma só.
  const p = pino(cam, 0, 3.2), f1 = pino(cam, -2.6, 8), f2 = pino(cam, 2.6, 8);
  const cena = {pinos: [p, f1, f2], correntes: [{a: f1, b: f2, barriga: .5}]};
  const com = analisar(cena), sem = analisar(cena, SEM_PROF);
  assert.deepEqual(ligadas(com), ['1-2'], JSON.stringify(com.grafo.rejeitadas.map(x => [x.a, x.b, x.motivos])));
  assert.deepEqual(com.grafo.arestas[0].sobreposto, [0], 'o pino da frente foi visto sobre a corrente e separado pela profundidade');
  assert.notDeepEqual(ligadas(sem), ['1-2'], 'sem profundidade a interpretação erra: ' + ligadas(sem));
  assert.ok(sem.grafo.rejeitadas.some(x => x.a === 1 && x.b === 2 && /passa pelo gancho/.test(x.motivos.join(' '))));
});

test('percurso: pino DISTANTE que faz parte da trajetória continua relevante (estrutura ligada ao que está perto)', () => {
  const cam = camera(W, H), a = pino(cam, -.8, 1.8), b = pino(cam, -.9, 3.8), c = pino(cam, -1, 6.2), solto = pino(cam, 1.6, 7);
  const r = analisar({pinos: [a, b, c, solto], correntes: [{a, b}, {a: b, b: c}]});
  assert.deepEqual(ligadas(r), ['0-1', '1-2']);
  assert.equal(r.grafo.nos[2].relevante, true); assert.match(r.grafo.nos[2].relevancia, /estrutura/);
  assert.equal(r.grafo.nos[3].relevante, false);
});

test('percurso: proximidade sozinha não é ligação — dois pinos lado a lado sem corrente ficam sem aresta; corrente amarela que sai do quadro vira ponta solta', () => {
  const cam = camera(W, H), a = pino(cam, -.4, 2.5), b = pino(cam, .4, 2.5);
  assert.deepEqual(ligadas(analisar({pinos: [a, b]})), []);
  const fora = {X: -3.5, Z: 2.5};
  const r = analisar({pinos: [a, b], correntes: [{a, b: fora, cor: [235, 200, 30], barriga: .15}]});
  assert.deepEqual(ligadas(r), []);
  assert.ok(r.soltas.some(s => s.de === 0), JSON.stringify(r.soltas));
  assert.ok(r.zonas.esquerda.some(z => /solta/.test(z.aresta)));
});

test('percurso: custo por quadro baixo (imagem pequena de 240×320, 6 pinos)', () => {
  const cam = camera(W, H), ps = [pino(cam, -1, 2), pino(cam, 1, 2), pino(cam, -1, 4), pino(cam, 1, 4), pino(cam, -1.2, 6), pino(cam, 1.2, 6)];
  const img = desenhar(cam, w, h, {pinos: ps, correntes: [{a: ps[0], b: ps[2]}, {a: ps[1], b: ps[3]}, {a: ps[2], b: ps[4]}, {a: ps[3], b: ps[5]}]});
  const pc = PC.criarPercurso(), pinos = ps.map((p, i) => ({id: i, bbox: p.bbox, score: .9}));
  for (let i = 0; i < 3; i++) pc.analisar({pinos, img, W, H});
  const t0 = performance.now(); for (let i = 0; i < 10; i++) pc.analisar({pinos, img, W, H});
  const ms = (performance.now() - t0)/10;
  assert.ok(ms < 40, ms.toFixed(1) + ' ms');
});

// ---------- decisão (js/nucleo.js) ----------
test('decisão: corredor de correntes sugere a direção só dentro da folga; seta da parede tem precedência; sem corredor nada muda', () => {
  const N = criarNucleoVisio(), base = {modo: 'probabilidade', agora: 1000, lados: {confirmado: true}, grupos: [], pendentes: [], candidatos: [], deteccao: {estado: 'ok', tCaptura: 990}};
  const sem = N.decidirOrientacao(base);
  assert.equal(sem.escolha, 'frente');
  const cor = N.decidirOrientacao(Object.assign({}, base, {corredor: {direcao: 'direita', confianca: .8, idadeMs: 100}}));
  assert.equal(cor.escolha, 'direita'); assert.ok(cor.motivos.some(m => /corredor/.test(m)));
  const fraco = N.decidirOrientacao(Object.assign({}, base, {corredor: {direcao: 'direita', confianca: .3, idadeMs: 100}}));
  assert.equal(fraco.escolha, 'frente', 'corredor de baixa confiança não muda nada');
  const velho = N.decidirOrientacao(Object.assign({}, base, {corredor: {direcao: 'direita', confianca: .9, idadeMs: 9000}}));
  assert.equal(velho.escolha, 'frente');
  const seta = N.decidirOrientacao(Object.assign({}, base, {corredor: {direcao: 'direita', confianca: .9, idadeMs: 100}, seta: {direcao: 'esquerda', idadeMs: 100}}));
  assert.equal(seta.escolha, 'esquerda');
  // corredor apontando para um lado muito mais bloqueado: não segue
  const g = [{cls: 'caixa', info: N.CLASSES.caixa, z: 'direita', n: 1, area: .2}];
  const bloq = N.decidirOrientacao(Object.assign({}, base, {grupos: g, corredor: {direcao: 'direita', confianca: .9, idadeMs: 100}}));
  assert.notEqual(bloq.escolha, 'direita');
  assert.deepEqual(N.decidirOrientacao(Object.assign({}, base, {corredor: null})), sem);
});

test('decisão: "corrente" e "pino" são obstáculos falados; a corrente entra no cálculo da chance de bloqueio da zona', () => {
  const N = criarNucleoVisio(), base = {modo: 'probabilidade', agora: 1000, lados: {confirmado: true}, pendentes: [], candidatos: [], deteccao: {estado: 'ok', tCaptura: 990}};
  const g = [{cls: 'corrente', info: N.CLASSES.corrente, z: 'frente', n: 1, area: .12}];
  const dec = N.decidirOrientacao(Object.assign({}, base, {grupos: g}));
  assert.notEqual(dec.escolha, 'frente'); assert.ok(dec.probabilidades.frente > .7);
  assert.match(N.planejar(g, dec).texto, /^Corrente à frente\. Vá pela/);
  assert.equal(N.CLASSES.pino.s, 'pino');
});

// ---------- app (js/app.js) ----------
async function rodar(fab, vals = {}, extra = {}){
  globalThis.VisioYolo = {carregar: async op => /generico/.test(op.modelo) ? {classes: ['person'], dispose(){}, detect: async () => []}
    : {classes: ['caixa', 'pino'], versao: 'v-fab', conjunto: 't', assinaturas: false, provedor: 'mock', falas: {pino: {s: 'pino', p: 'pinos', g: 'm', prio: 2, off: -.1}}, dispose(){}, detect: async () => fab.map(p => Object.assign({}, p))}};
  try {
    const a = await montar(Object.assign({vals: Object.assign({modelo: 'fabrica', generico: 'desligado', percurso: 'ligado', modo: 'probabilidade'}, vals)}, extra));
    await a.iniciar(); await sleep(400); a.encerrar(); return a;
  } finally { delete globalThis.VisioYolo; }
}
// quadro 640×480 do app simulado; a cena é desenhada no quadro e copiada para os 320×240 que o app lê
function cenaApp(){
  const cam = camera(640, 480), a = pino(cam, -.9, 2.2), b = pino(cam, .9, 2.4);
  const img = desenhar(cam, 320, 240, {pinos: [a, b], correntes: [{a, b}]});
  return {quadro: () => ({data: img.data, width: 320, height: 240}), fab: [d('pino', a.bbox, .85), d('pino', b.bbox, .85)]};
}

test('app: dois pinos com corrente entre eles → "Corrente à frente…", sem caixa de pino/corrente na tela; desligado → só os pinos', async () => {
  const {quadro, fab} = cenaApp();
  const a = await rodar(fab, {}, {quadro, comPercurso: true});
  assert.ok(a.falas.some(t => /Corrente à frente/.test(t)), a.falas.join(' | '));
  assert.match(a.els.pEstado.textContent, /2 pinos · 1 corrente/);
  const b = await rodar(fab, {percurso: 'desligado'}, {quadro, comPercurso: true});
  assert.ok(!b.falas.some(t => /orrente/.test(t)), b.falas.join(' | '));
  assert.ok(b.falas.some(t => /pino/i.test(t)), 'pinos continuam sendo obstáculos: ' + b.falas.join(' | '));
});

test('app (regressão): sem pino na imagem, com ou sem o módulo do percurso, as falas são IDÊNTICAS', async () => {
  const fab = [d('caixa', [20, 200, 150, 150], .85)];
  const quadro = () => ({data: new Uint8ClampedArray(320*240*4).fill(200), width: 320, height: 240});
  const com = await rodar(fab, {}, {quadro, comPercurso: true}), sem = await rodar(fab, {}, {quadro});
  assert.ok(com.falas.length > 0);
  assert.deepEqual(com.falas, sem.falas);
});

test('decisão: pino e corrente com DISTÂNCIA estimada confiável pesam pela distância (não pela área); sem distância, regra antiga', () => {
  const N = criarNucleoVisio(), I = N.CLASSES;
  const dec = grupos => N.decidirOrientacao({modo: 'probabilidade', agora: 100, grupos, deteccao: {estado: 'ok', tCaptura: 90}});
  const g = (cls, dist, area = .3) => ({cls, info: I[cls], z: 'frente', n: 1, area, ...(dist == null ? {} : {dist})});
  const perto = dec([g('corrente', .8)]).probabilidades.frente, meio = dec([g('corrente', 2.2)]).probabilidades.frente, longe = dec([g('corrente', 5)]).probabilidades.frente;
  assert.ok(perto > .9 && meio < perto && longe < meio && longe < .4, [perto, meio, longe].join(' '));
  // a corrente comprida (área grande na imagem) lá a 5 m não bloqueia a frente como uma caixa grande perto
  assert.ok(dec([g('caixa', null)]).probabilidades.frente > .9);
  // validarPredicoes preserva a distância válida e recusa a inválida
  const v = N.validarPredicoes([{class: 'pino', score: .9, bbox: [10, 10, 20, 80], distancia: {z: 2.5, conf: .8}}, {class: 'pino', score: .9, bbox: [50, 10, 20, 80], distancia: {z: NaN, conf: 1}}], 640, 480).validas;
  assert.deepEqual(v[0].distancia, {z: 2.5, conf: .8}); assert.equal(v[1].distancia, undefined);
});
