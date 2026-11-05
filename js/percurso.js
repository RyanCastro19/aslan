'use strict';
/*
 * Percurso de correntes e pinos (ver docs/CORRENTES_E_PINOS.md). Lógica PURA: sem DOM, câmera, fala nem relógio global.
 *
 *  1. CENA 2.5D   cada pino (e cada objeto com pé visível) ganha X/Y na imagem, Z estimado em metros, camada (perto/meio/fundo/incerta)
 *                 e confiança. Pistas: altura aparente do pino (tamanho conhecido), ponto de contato no piso com a linha do horizonte
 *                 tirada dos próprios pinos inteiros, oclusão entre caixas e suavização no tempo. Câmera única: Z é ESTIMATIVA.
 *  2. CORRENTE    para cada par de pinos, procura nos pixels uma corrente pendurada entre os ganchos (curva com barriga): pixels amarelos
 *                 saturados ou escuros e finos contra fundo claro, que existem NA curva e não nas curvas paralelas vizinhas
 *                 (assim cadeira preta, sombra ou piso granilite não contam). Trecho atrás de objeto detectado é "oculto", não falta.
 *  3. GRAFO       nós = pinos (+ pontas soltas de corrente amarela), arestas = correntes ACEITAS. Uma aresta só existe se continuidade
 *                 visual, geometria dos ganchos, vão compatível com a profundidade e confiança fecharem juntas. Proximidade não basta.
 *                 As rejeitadas ficam guardadas com o motivo (depuração).
 *  4. TRAJETÓRIA  barreiras (correntes) por zona, corrente cruzando a frente, corredor entre barreiras e para onde ele vira.
 *  5. RELEVÂNCIA  pino perto, ou ligado à estrutura que chega perto, é relevante; pino solto e distante (com profundidade confiável) é
 *                 ignorado na decisão. Profundidade de baixa confiança NUNCA descarta nada.
 * Coordenadas de entrada: caixas [x,y,w,h] no quadro W×H; pixels RGBA de uma cópia reduzida (img.w×img.h) do MESMO quadro.
 * Lados: esquerda/direita DA IMAGEM; quem chama aplica a inversão (câmera frontal) como nas setas.
 */
(function(g){
  const P = {
    // câmera e cena (valores padrão; a escala em metros é aproximada)
    fovLongo: 65,            // campo de visão (graus) no lado maior do quadro
    alturaPino: .95,         // altura típica de um pedestal de sinalização (m)
    alturaCamera: 1.25,      // celular na altura do peito (m), usado só para o ponto de contato quando não há horizonte pelos pinos
    bordaRel: .012,          // caixa a menos disso da borda está cortada
    horizonteEma: .3,        // suavização do horizonte entre quadros
    zEma: .4,                // suavização do Z de cada pino entre quadros
    camadas: [[1.8, 'perto'], [4.5, 'meio'], [Infinity, 'fundo']],
    confCamadaMin: .4,       // abaixo disso a camada é 'incerta'
    // corrente
    ganchoRel: .06, deslocRel: .03, folgaCima: 4, folgaLado: 6, custoHit: .15, janelaMax: 60000,
    yR: 105, yRB: 42, yG: 85, yGR: .6,             // amarelo (também fraco): R e G acima de B
    escuroMax: 95, contrasteEscuro: 45, anel: 3,   // escuro e fino: mais escuro que o anel em volta
    visivelMin: .4, coberturaMin: .6, buracoMax: .25, contrasteMin: .3,
    vaoMin: .35, vaoMax: 6.5,             // vão plausível de uma corrente entre dois pinos (m)
    grauMax: 3, pinoConfMin: .35, planoTol: .35, desvio3DMax: 1.0, barrigas3D: [0, .1, .2, .35, .5, .7, .9], pontasMin: .5, inclinadoRel: .32, amareloMin: .15, coberturaEscuroMin: .8, contrasteEscuroMin: .55, pontasEscuroMin: .7,
    soltaCompMin: 18, soltaAlong: 3.5,   // ponta solta: mancha amarela alongada que sai de um gancho
    // relevância e decisão
    zRelevante: 4.5, confZDecide: .5, zonaPertoZ: 3.5, frenteCobre: .5
  };
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const camadaDe = (z, conf, p = P) => !(conf >= p.confCamadaMin) || !Number.isFinite(z) ? 'incerta' : p.camadas.find(([lim]) => z < lim)[1];
  const focal = (W, H, p = P) => (Math.max(W, H)/2)/Math.tan(p.fovLongo*Math.PI/360);
  const mediana = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n-1)/2] : (s[n/2-1] + s[n/2])/2) : null; };

  // ---------- 1. CENA 2.5D ----------
  // pinos: [{bbox, score, class?}]  outros: caixas de outros objetos (para oclusão)  estado: {horizonte, conf} do quadro anterior (opcional)
  function estimarCena(pinos, outros, W, H, estado = {}, p = P){
    const f = focal(W, H, p), mb = p.bordaRel*Math.max(W, H);
    const nos = pinos.map((q, i) => {
      const [x, y, w, h] = q.bbox, pe = y + h;
      const cortadoTopo = y <= mb, cortadoPe = pe >= H - mb, cortadoLado = x <= mb || x + w >= W - mb;
      // pé escondido atrás de outro objeto: o pé cai dentro de uma caixa cujo pé está mais baixo (mais perto)
      const pePorTras = outros.some(o => { const [ox, oy, ow, oh] = o.bbox; return x + w/2 >= ox && x + w/2 <= ox + ow && pe >= oy && pe <= oy + oh && oy + oh > pe + .02*H; });
      return {id: q.id ?? i, tipo: 'pino', subtipo: q.subtipo || null, bbox: q.bbox.slice(), score: q.score, cx: x + w/2, topo: y, pe, h,
        cortadoTopo, cortadoPe, cortadoLado, pePorTras, inteiro: !cortadoTopo && !cortadoPe && !pePorTras};
    });
    // horizonte: cada pino inteiro dá uma estimativa (y_h = pé − altura_px × alturaCamera/alturaPino, câmera aproximadamente nivelada)
    const hs = nos.filter(n => n.inteiro && n.h > .03*H).map(n => n.pe - n.h*p.alturaCamera/p.alturaPino);
    let horizonte = null, confH = 0, origemH = 'presumido (câmera nivelada)';
    if (hs.length){
      const m = mediana(hs), disp = hs.length > 1 ? mediana(hs.map(v => Math.abs(v - m)))/H : .08;
      horizonte = m; confH = clamp01((hs.length >= 2 ? .85 : .55) - disp*4); origemH = hs.length + ' pino(s) inteiro(s)';
    }
    if (Number.isFinite(estado.horizonte)){
      if (horizonte === null){ horizonte = estado.horizonte; confH = (estado.conf || 0)*.8; origemH = 'quadros anteriores'; }
      else { horizonte = estado.horizonte + p.horizonteEma*(horizonte - estado.horizonte); confH = Math.max(confH, (estado.conf || 0)*.8); }
    }
    if (horizonte === null){ horizonte = H/2; confH = .2; }
    for (const n of nos){
      const pistas = [];
      if (!n.cortadoTopo && !n.cortadoPe && !n.pePorTras && n.h > 2) pistas.push({z: f*p.alturaPino/n.h, w: 1, nome: 'altura'});
      if (!n.cortadoPe && !n.pePorTras && n.pe - horizonte > 2) pistas.push({z: f*p.alturaCamera/(n.pe - horizonte), w: confH, nome: 'contato no piso'});
      if (!pistas.length && n.pePorTras && !n.cortadoTopo && n.topo - horizonte > 2 && p.alturaCamera > p.alturaPino + .1)   // pé escondido: topo do pino abaixo do horizonte (fraco)
        pistas.push({z: f*(p.alturaCamera - p.alturaPino)/(n.topo - horizonte), w: .3*confH, nome: 'topo (pé escondido)'});
      if (!pistas.length && n.cortadoPe && !n.cortadoTopo && n.h > 2){                   // pé abaixo do quadro: está perto. Limite: Z < f·alturaCamera/(H − horizonte)
        const zMax = horizonte < H - 2 ? f*p.alturaCamera/(H - horizonte) : 1.5;
        const zTopo = n.topo - horizonte > 2 ? f*(p.alturaCamera - p.alturaPino)/(n.topo - horizonte) : null;   // topo do pino abaixo do horizonte
        pistas.push({z: Math.min(zTopo ?? zMax, zMax), w: .75*confH, nome: 'pé abaixo do quadro (perto)'});
      }
      if (!pistas.length){ n.z = null; n.confZ = 0; n.pistasZ = []; continue; }
      const sw = pistas.reduce((s, q) => s + q.w, 0), lz = pistas.reduce((s, q) => s + q.w*Math.log(q.z), 0)/sw;
      let conf = clamp01(.35 + .25*pistas.length + .2*Math.min(1, n.score || 0) - (n.cortadoLado ? .15 : 0));
      if (pistas.length >= 2){ const dz = Math.abs(Math.log(pistas[0].z/pistas[1].z)); conf *= clamp01(1 - dz/.7); }
      else conf *= pistas[0].w;
      n.z = Math.exp(lz); n.confZ = clamp01(conf); n.pistasZ = pistas.map(q => q.nome);
    }
    // oclusão: pino que cobre parte de outro está na frente. Contradição com os Z estimados baixa a confiança dos dois.
    for (const a of nos) for (const b of nos){
      if (a === b || a.z == null || b.z == null) continue;
      const [ax, ay, aw, ah] = a.bbox, [bx, by, bw, bh] = b.bbox;
      const ix = Math.min(ax + aw, bx + bw) - Math.max(ax, bx), iy = Math.min(ay + ah, by + bh) - Math.max(ay, by);
      if (ix > .3*Math.min(aw, bw) && iy > 0 && a.pe > b.pe + .02*H && a.z > b.z*1.1){ a.confZ *= .6; b.confZ *= .6; a.contradicao = b.contradicao = true; }
    }
    for (const n of nos){
      n.x = n.z == null ? null : (n.cx - W/2)*n.z/f;                                    // lateral no piso (m), + = direita da imagem
      n.camada = camadaDe(n.z, n.confZ, p);
    }
    return {nos, horizonte, confHorizonte: confH, origemHorizonte: origemH, f, W, H};
  }

  // ---------- 2. CORRENTE ENTRE DOIS GANCHOS ----------
  function lum(px, i){ return .299*px[i] + .587*px[i+1] + .114*px[i+2]; }
  // amarelo, mesmo fraco (corrente fina misturada ao fundo neutro): R e G acima de B. Parede e piso são cinza neutro.
  function ehAmarelo(px, i, p){ const r = px[i], gg = px[i+1], b = px[i+2]; return r >= p.yR && gg >= p.yG && r - b >= p.yRB && gg - b >= p.yRB*.55 && gg >= p.yGR*r; }
  // amarelo FORTE (elo de corrente bem visto): o único que conta como prova sobre uma CAIXA detectada (papelão é amarelado; sobre outros objetos vale o amarelo comum)
  function amareloForte(px, i){ const r = px[i], gg = px[i+1], b = px[i+2]; return r >= 150 && r - b >= 110 && gg >= .6*r && gg - b >= 70; }
  // Máscara PREGUIÇOSA de "pixel de corrente" (1 = amarelo, 2 = escuro e FINO: mais escuro que o anel em volta, 0 = nada).
  // Cada pixel só é calculado quando algum caminho passa por ele (a maior parte da imagem nunca é tocada) e fica guardado no quadro.
  function mascaraCorrente(img, p = P){
    const {data, w, h} = img, m = new Int8Array(w*h).fill(-1), R = p.anel;
    const dirs = []; for (let k = 0; k < 8; k++) dirs.push(Math.round(R*Math.cos(k*Math.PI/4)), Math.round(R*Math.sin(k*Math.PI/4)));
    function calc(x, y){
      const i = y*w + x, j = 4*i;
      if (ehAmarelo(data, j, p)) return 1;
      const L = lum(data, j); if (L > p.escuroMax) return 0;
      let n = 0, claro = 0;
      for (let k = 0; k < 16; k += 2){ const xx = x + dirs[k], yy = y + dirs[k+1]; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; n++; if (lum(data, 4*(yy*w + xx)) >= L + p.contrasteEscuro) claro++; }
      return n && claro >= n*.5 ? 2 : 0;
    }
    const get = (x, y) => { if (x < 0 || y < 0 || x >= w || y >= h) return 0; const i = y*w + x; let v = m[i]; if (v < 0) v = m[i] = calc(x, y); return v; };
    return {w, h, get, forte: (x, y) => x >= 0 && y >= 0 && x < w && y < h && amareloForte(data, 4*(y*w + x)), amarelo: (x, y) => x >= 0 && y >= 0 && x < w && y < h && ehAmarelo(data, 4*(y*w + x), p), completa(){ const o = new Uint8Array(w*h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y*w + x] = get(x, y); return o; }};
  }
  const amostra = (pts, t) => pts[Math.min(pts.length - 1, Math.max(0, Math.round(t*(pts.length - 1))))];
  const dentro = (b, x, y, m = 0) => x >= b[0] - m && x <= b[0] + b[2] + m && y >= b[1] - m && y <= b[1] + b[3] + m;
  // Caminho de A a B que passa pelo maior número de pixels de corrente: menor custo (Dijkstra 8-vizinhos) numa janela entre os ganchos,
  // passo sobre pixel de corrente custa custoHit, passo fora custa 1. A corrente não precisa ser uma parábola: a perspectiva entorta a barriga
  // e perto do gancho ela cai quase na vertical. Restrições físicas: não sobe acima da reta entre os ganchos (está pendurada) e não desce
  // abaixo do pé dos pinos (não atravessa o piso).
  let SC = null;
  function scratch(N){
    if (!SC || SC.dist.length < N){ const M = Math.max(N, SC ? SC.dist.length*2 : 0);
      SC = {dist: new Float32Array(M), de: new Int32Array(M), vis: new Int32Array(M), mk: new Uint8Array(M), lim: new Float32Array(4096), hd: new Float32Array(4*M), hi: new Int32Array(4*M), ger: 0}; }
    if (SC.ger > 2e9){ SC.vis.fill(0); SC.ger = 0; }
    return SC;
  }
  function caminhoDP(m, w, h, A, B, limInf, p){
    const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0]) - p.folgaLado)), x1 = Math.min(w - 1, Math.ceil(Math.max(A[0], B[0]) + p.folgaLado));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1]) - p.folgaCima)), y1 = Math.min(h - 1, Math.max(y0 + 2, Math.ceil(limInf)));
    const W = x1 - x0 + 1, H = y1 - y0 + 1, N = W*H; if (W < 2 || H < 2 || N > p.janelaMax) return null;
    const ax = Math.round(A[0]) - x0, ay = Math.round(A[1]) - y0, bx = Math.round(B[0]) - x0, by = Math.round(B[1]) - y0;
    if (ax < 0 || ay < 0 || ax >= W || ay >= H || bx < 0 || by < 0 || bx >= W || by >= H) return null;
    const dxAB = B[0] - A[0], dyAB = B[1] - A[1], horiz = Math.abs(dxAB) >= Math.abs(dyAB);
    // buffers reaproveitados entre chamadas (o quadro inteiro chama isto dezenas de vezes): sem alocação nem limpeza por chamada, por "geração"
    const S = scratch(N), dist = S.dist, de = S.de, vis = S.vis, mk = S.mk, ger = ++S.ger;
    // máscara da janela num vetor (0 = fora da corrente), e "acima da reta entre os ganchos" pré-calculado por coluna
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mk[y*W + x] = m.get(x + x0, y + y0) ? 1 : 0;
    const lim = S.lim; for (let x = 0; x < W; x++){ const t = Math.abs(dxAB) < 1 ? -1 : (x + x0 - A[0])/dxAB; lim[x] = t <= 0 || t >= 1 ? -1e9 : A[1] + t*dyAB - p.folgaCima - y0; }
    let hd = S.hd, hi = S.hi, n = 0;
    const push = (d, i) => { if (n === hd.length){ const a = new Float32Array(hd.length*2), b = new Int32Array(hd.length*2); a.set(hd); b.set(hi); S.hd = hd = a; S.hi = hi = b; }
      let k = n++; while (k){ const q = (k - 1) >> 1; if (hd[q] <= d) break; hd[k] = hd[q]; hi[k] = hi[q]; k = q; } hd[k] = d; hi[k] = i; };
    const pop = () => { const top = hi[0], d = hd[--n], i = hi[n]; let k = 0;
      for (;;){ const l = 2*k + 1; if (l >= n) break; const r = l + 1, mn = r < n && hd[r] < hd[l] ? r : l; if (hd[mn] >= d) break; hd[k] = hd[mn]; hi[k] = hi[mn]; k = mn; }
      hd[k] = d; hi[k] = i; return top; };
    // A*: estimativa = custoHit × distância octil até o alvo (nunca superestima), então o caminho é o mesmo do Dijkstra, com menos passos
    const ch = p.custoHit, hx = (x, y) => { const dx = Math.abs(x - bx), dy = Math.abs(y - by); return ch*(Math.max(dx, dy) + .414*Math.min(dx, dy)); };
    const s0 = ay*W + ax, alvo = by*W + bx; vis[s0] = ger; dist[s0] = 0; de[s0] = -1; push(hx(ax, ay), s0);
    const VX = [1, -1, 0, 0, 1, 1, -1, -1], VY = [0, 0, 1, -1, 1, -1, 1, -1], VC = [1, 1, 1, 1, 1.414, 1.414, 1.414, 1.414];
    let achou = false;
    while (n){
      const i = pop(); if (vis[i] === -ger) continue; vis[i] = -ger; if (i === alvo){ achou = true; break; }   // -ger = fechado
      const d = dist[i], x = i % W, y = (i - x)/W;
      for (let k = 0; k < 8; k++){
        const nx = x + VX[k], ny = y + VY[k]; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny*W + nx, vj = vis[j]; if (vj === -ger || ny < lim[nx]) continue;
        const nd = d + VC[k]*(mk[j] ? ch : 1);
        if (vj !== ger || nd < dist[j]){ vis[j] = ger; dist[j] = nd; de[j] = i; push(nd + hx(nx, ny), j); }
      }
    }
    if (!achou) return null;
    const pts = []; for (let i = alvo; i >= 0; i = de[i]){ const x = i % W; pts.push([x + x0, (i - x)/W + y0]); if (i === s0) break; }
    pts.reverse();
    return {pts, horiz};
  }
  // Mede a corrente entre os ganchos de a e b. kx, ky: quadro → imagem pequena. oclusores: caixas (no quadro) de objetos que podem esconder a corrente.
  function medirCorrente(img, mask, a, b, oclusores, kx, ky, p = P, oclusoresClasse = []){
    // Gancho = topo do pino. Pino inclinado (caixa larga: perspectiva da lente perto das bordas) tem o topo num dos lados da caixa: testa os dois.
    const ganchos = n => { const y = (n.topo + p.ganchoRel*n.h)*ky, lean = n.bbox[2] > p.inclinadoRel*n.h;
      return lean ? [[(n.bbox[0] + .15*n.bbox[2])*kx, y], [(n.bbox[0] + .85*n.bbox[2])*kx, y]] : [[n.cx*kx, y]]; };
    const limInf = Math.max(a.pe, b.pe)*ky;
    let c = null, A, B, vao = 0;
    for (const GA of ganchos(a)) for (const GB of ganchos(b)){
      const v = Math.hypot(GB[0] - GA[0], GB[1] - GA[1]); if (v < 6) continue;
      const cc = caminhoDP(mask, img.w, img.h, GA, GB, limInf, p); if (!cc) continue;
      let hs = 0; for (const [x, y] of cc.pts) if (mask.get(x, y)) hs++;
      if (!c || hs/cc.pts.length > c.taxa){ c = cc; c.taxa = hs/cc.pts.length; A = GA; B = GB; vao = v; }
    }
    if (!c) return null;
    const caixas = [a.bbox, b.bbox].map(q => [q[0]*kx, q[1]*ky, q[2]*kx, q[3]*ky]), ocl = oclusores.map(q => [q[0]*kx, q[1]*ky, q[2]*kx, q[3]*ky]);
    const desl = Math.max(3, Math.round(p.deslocRel*Math.max(img.w, img.h)));
    const hit = (x, y) => mask.get(x, y) > 0;
    const perto = (x, y) => hit(x, y) || hit(x + 1, y) || hit(x - 1, y) || hit(x, y + 1) || hit(x, y - 1);
    let vis = 0, ocultos = 0, hits = 0, amarelos = 0, buraco = 0, maiorBuraco = 0, paral = 0, paralN = 0, total = 0; const seq = [];
    for (const [x, y] of c.pts){
      if (caixas.some(q => dentro(q, x, y, 1))) continue;                     // sobre os próprios pinos (listras amarelas): ignora
      total++;
      // sobre outro objeto detectado: corrente AMARELA vista ali está na frente dele (conta); o resto é "oculto", não é prova nem falta
      const sobre = oclusores.findIndex((q, k) => dentro(ocl[k], x, y));
      if (sobre >= 0){ if (oclusoresClasse[sobre] === 'caixa' ? mask.forte(x, y) : mask.get(x, y) === 1){ vis++; hits++; amarelos++; buraco = 0; seq.push(1); continue; } ocultos++; continue; }
      vis++;
      if (perto(x, y)){ hits++; if (mask.get(x, y) === 1 || mask.get(x, y + 1) === 1 || mask.get(x, y - 1) === 1 || mask.get(x + 1, y) === 1 || mask.get(x - 1, y) === 1) amarelos++; buraco = 0; seq.push(1); } else { buraco++; if (buraco > maiorBuraco) maiorBuraco = buraco; seq.push(0); }
      for (const s of [-1, 1]){ paralN++; if (c.horiz ? perto(x, y + s*desl) : perto(x + s*desl, y)) paral++; }
    }
    if (!total || !vis) return {pts: c.pts, visivel: 0, ocultoRel: total ? ocultos/total : 0, cobertura: 0, buraco: 1, contraste: 0, fundo: 0, amarelo: 0, nota: 0, vaoPx: vao, A, B};
    const cobertura = hits/vis, fundo = paral/paralN;
    // as duas pontas (o trecho que chega a cada gancho) precisam ter corrente: um caminho que só "sobe pelo vazio" até um gancho não liga
    const q = Math.max(2, Math.round(seq.length*.2)), med = a => a.length ? a.reduce((s, v) => s + v, 0)/a.length : 0;
    const pontas = Math.min(med(seq.slice(0, q)), med(seq.slice(-q)));
    const r = {pts: c.pts, visivel: vis/total, ocultoRel: ocultos/total, cobertura, buraco: maiorBuraco/total, contraste: cobertura - fundo, fundo,
      amarelo: hits ? amarelos/hits : 0, vaoPx: vao, A, B, pontas};
    r.nota = r.cobertura*clamp01(r.contraste/.6)*(1 - r.buraco);
    // só escuro (sem amarelo): bordas de objetos, rodapé e juntas do piso também são escuras e finas; exige mais
    r.soEscuro = r.amarelo < p.amareloMin;
    return r;
  }

  // ---------- 3. GRAFO ----------
  function vaoMetros(a, b, f){
    if (a.z == null || b.z == null) return null;
    return Math.hypot(a.x - b.x, a.z - b.z);
  }
  function montarGrafo(cena, img, mask, oclusores, kx, ky, p = P, classesOcl = []){
    const nos = cena.nos.filter(n => (n.score ?? 1) >= p.pinoConfMin), pares = [], rejeitadas = [];
    for (let i = 0; i < nos.length; i++) for (let j = i + 1; j < nos.length; j++){
      const a = nos[i], b = nos[j];
      // filtro barato antes de procurar nos pixels: com as duas profundidades confiáveis e vão impossível, nem procura a corrente
      const vm0 = vaoMetros(a, b, cena.f);
      if (vm0 != null && Math.min(a.confZ, b.confZ) >= p.confZDecide && (vm0 < p.vaoMin || vm0 > p.vaoMax)){
        rejeitadas.push({a: a.id, b: b.id, medida: null, vaoM: vm0, confZ: Math.min(a.confZ, b.confZ), motivos: ['profundidades incompatíveis (vão estimado ' + vm0.toFixed(1) + ' m)']}); continue;
      }
      const m = medirCorrente(img, mask, a, b, oclusores, kx, ky, p, classesOcl);
      const ar = {a: a.id, b: b.id, medida: m, motivos: []};
      if (!m){ ar.motivos.push('ganchos colados na imagem'); rejeitadas.push(ar); continue; }
      if (m.visivel < p.visivelMin) ar.motivos.push('pouco trecho visível (' + Math.round(m.visivel*100) + '%)');
      if (m.cobertura < p.coberturaMin) ar.motivos.push('sem continuidade visual (' + Math.round(m.cobertura*100) + '%)');
      if (m.buraco > p.buracoMax) ar.motivos.push('interrupção longa na curva');
      if (m.visivel >= p.visivelMin && m.pontas < p.pontasMin) ar.motivos.push('a corrente não chega a um dos ganchos');
      if (m.contraste < p.contrasteMin) ar.motivos.push('não é linha fina (o entorno parece igual)');
      if (m.soEscuro && (m.cobertura < p.coberturaEscuroMin || m.contraste < p.contrasteEscuroMin || m.pontas < p.pontasEscuroMin)) ar.motivos.push('só pixels escuros e evidência fraca (pode ser borda ou junta do piso)');
      // profundidade: o vão no piso precisa ser de uma corrente. Só VETA se as duas profundidades forem confiáveis.
      const vm = vaoMetros(a, b, cena.f), confZ = Math.min(a.confZ, b.confZ);
      ar.vaoM = vm; ar.confZ = confZ;
      if (vm != null && confZ >= p.confZDecide && (vm < p.vaoMin || vm > p.vaoMax)) ar.motivos.push('profundidades incompatíveis (vão estimado ' + vm.toFixed(1) + ' m)');
      // trajeto 3D: com as duas profundidades confiáveis, a curva vista precisa caber numa corrente pendurada ENTRE os dois ganchos no espaço
      // (projeção da catenária para várias barrigas). Uma corrente de outro plano que só passa perto de um gancho na imagem não cabe.
      if (vm != null && confZ >= p.confZDecide && m.visivel >= p.visivelMin){
        ar.desvio3D = desvio3D(cena, a, b, m.pts, kx, ky, p);
        if (ar.desvio3D > p.desvio3DMax) ar.motivos.push('trajeto incompatível com a profundidade dos dois pinos (desvio ' + ar.desvio3D.toFixed(1) + ')');
      }
      const confDet = Math.min(a.score ?? 1, b.score ?? 1);
      ar.confianca = clamp01(m.nota*(.6 + .4*confDet)*(vm == null || confZ < p.confZDecide ? .85 : 1));
      // a curva passa pelo gancho de OUTRO pino? Então a corrente provavelmente está presa nele (são duas correntes, a–k e k–b), a não ser que
      // a profundidade mostre que esse pino está em outro plano (só está na frente ou atrás na imagem: sobreposição visual, não ligação).
      if (!ar.motivos.length) for (const k of nos){
        if (k === a || k === b) continue;
        const G = [k.cx*kx, (k.topo + p.ganchoRel*k.h)*ky], tol = Math.max(3, .04*m.vaoPx);
        let melhor = Infinity, idx = -1;
        m.pts.forEach((q, i) => { const d = Math.hypot(q[0] - G[0], q[1] - G[1]); if (d < melhor){ melhor = d; idx = i; } });
        const t = idx/(m.pts.length - 1);
        if (melhor > tol || t < .12 || t > .88) continue;
        const zLin = a.z != null && b.z != null ? a.z + (b.z - a.z)*t : null;
        const outroPlano = zLin != null && k.z != null && Math.min(a.confZ, b.confZ, k.confZ) >= p.confZDecide && Math.abs(Math.log(k.z/zLin)) > p.planoTol;
        if (outroPlano){ ar.sobreposto = (ar.sobreposto || []).concat(k.id); continue; }
        ar.motivos.push('passa pelo gancho de outro pino (' + k.id + ')' + (zLin == null || k.z == null ? ', profundidade indisponível' : ''));
      }
      if (ar.motivos.length) rejeitadas.push(ar); else pares.push(ar);
    }
    // cada pino segura no máximo grauMax correntes: escolha gulosa pela melhor confiança
    // corrente de outro plano que passa sobre o gancho de um pino k (ar.sobreposto): as "ligações" de k que são só pedaços dela saem.
    // Uma corrente explica os mesmos pixels melhor que duas presas num pino que, pela profundidade, está em outro plano.
    for (const E of pares.filter(x => x.sobreposto)) for (const k of E.sobreposto)
      for (let i = pares.length - 1; i >= 0; i--){
        const x = pares[i]; if (x === E || (x.a !== k && x.b !== k) || !mesmaCurvaUmLado(x.medida, E.medida)) continue;
        x.motivos.push('é só um pedaço da corrente ' + E.a + '-' + E.b + ', que passa na frente/atrás deste pino em outro plano'); rejeitadas.push(x); pares.splice(i, 1);
      }
    // melhor confiança primeiro; empate: a corrente mais curta (a mais longa que contém a curta passa por outro gancho ou por dentro de caixas)
    pares.sort((x, y) => (y.confianca - x.confianca) || (x.medida.vaoPx - y.medida.vaoPx));
    const grau = new Map(), arestas = [];
    for (const ar of pares){
      if ((grau.get(ar.a) || 0) >= p.grauMax || (grau.get(ar.b) || 0) >= p.grauMax){ ar.motivos.push('pino já tem correntes demais'); rejeitadas.push(ar); continue; }
      grau.set(ar.a, (grau.get(ar.a) || 0) + 1); grau.set(ar.b, (grau.get(ar.b) || 0) + 1); arestas.push(ar);
    }
    // corrente sobre outra corrente melhor: duas arestas que compartilham um pino e seguem quase a mesma curva → fica a melhor
    for (let i = arestas.length - 1; i >= 0; i--){
      const e = arestas[i];
      const k = arestas.findIndex((o, k) => k < i && (o.a === e.a || o.a === e.b || o.b === e.a || o.b === e.b) && mesmaCurva(o.medida, e.medida));
      if (k < 0) continue;
      // fica a que está inteira sobre a outra (ou a mais curta): a longa só "pegou carona" na curva dela e subiu até um gancho de outro plano
      const o = arestas[k], oDentro = mesmaCurvaUmLado(o.medida, e.medida), eDentro = mesmaCurvaUmLado(e.medida, o.medida);
      // as duas cobrem os mesmos pixels (pino de outro plano alinhado na imagem): decide a profundidade, pela curva 3D que melhor explica o trecho
      const d3 = x => { const A = nos.find(n => n.id === x.a), B = nos.find(n => n.id === x.b);
        return x.desvio3D ?? (A.z != null && B.z != null ? desvio3D(cena, A, B, x.medida.pts, kx, ky, p) : null); };
      let sai = oDentro && !eDentro ? e : eDentro && !oDentro ? o : null;
      if (!sai){ const dO = d3(o), dE = d3(e); sai = dO != null && dE != null && Math.abs(dO - dE) > .1 ? (dO < dE ? e : o) : (o.medida.vaoPx <= e.medida.vaoPx ? e : o); }
      sai.motivos.push('mesma curva de uma corrente já aceita (pino alinhado no meio)'); rejeitadas.push(sai); arestas.splice(arestas.indexOf(sai), 1);
      if (sai !== e) i = arestas.length;
    }
    return {nos, arestas, rejeitadas};
  }
  // Desvio entre o caminho visto e a melhor catenária 3D projetada entre os ganchos (mediana da distância, em unidades de max(6 px, 8% do vão)).
  function desvio3D(cena, a, b, pts, kx, ky, p){
    const {f, horizonte, W} = cena, Y0 = p.alturaPino*.96;
    const proj = (X, Y, Z) => [(W/2 + f*X/Z)*kx, (horizonte + f*(p.alturaCamera - Y)/Z)*ky];
    const PA = proj(a.x, Y0, a.z), PB = proj(b.x, Y0, b.z), esc = Math.max(6, .08*Math.hypot(PB[0] - PA[0], PB[1] - PA[1]));
    let melhor = Infinity;
    for (const sag of p.barrigas3D){
      const ds = [];
      for (let k = 1; k < 16; k++){
        const t = k/16, X = a.x + (b.x - a.x)*t, Z = a.z + (b.z - a.z)*t, Y = Math.max(0, Y0 - sag*4*t*(1 - t)), [u, v] = proj(X, Y, Z);
        let d = Infinity; for (let j = 0; j < pts.length; j += 2){ const q = pts[j], e = Math.hypot(q[0] - u, q[1] - v); if (e < d) d = e; }
        ds.push(d);
      }
      ds.sort((x, y) => x - y); melhor = Math.min(melhor, ds[ds.length >> 1]/esc);
    }
    return melhor;
  }
  function mesmaCurva(m1, m2){
    let n = 0, perto = 0;
    for (let k = 1; k < 8; k++){
      const p1 = amostra(m1.pts, k/8); let d = Infinity;
      for (let j = 1; j < 16; j++){ const p2 = amostra(m2.pts, j/16); d = Math.min(d, Math.hypot(p1[0] - p2[0], p1[1] - p2[1])); }
      n++; if (d < .03*Math.max(m1.vaoPx, m2.vaoPx) + 2) perto++;
    }
    return perto/n >= .6 || (m2 !== m1 && mesmaCurvaUmLado(m2, m1));
  }
  function mesmaCurvaUmLado(m1, m2){
    let n = 0, perto = 0;
    for (let k = 1; k < 8; k++){
      const p1 = amostra(m1.pts, k/8); let d = Infinity;
      for (let j = 1; j < 16; j++){ const p2 = amostra(m2.pts, j/16); d = Math.min(d, Math.hypot(p1[0] - p2[0], p1[1] - p2[1])); }
      n++; if (d < .03*Math.max(m1.vaoPx, m2.vaoPx) + 2) perto++;
    }
    return perto/n >= .6;
  }
  // Pontas soltas: corrente AMARELA que sai de um gancho e termina sem outro pino (ex.: sai do quadro). Manchas amarelas finas e alongadas.
  function pontasSoltas(img, mask, nos, arestas, kx, ky, p = P){
    const {w, h} = img, m = new Uint8Array(w*h), caixas = nos.map(n => [n.bbox[0]*kx - 1, n.bbox[1]*ky - 1, n.bbox[2]*kx + 2, n.bbox[3]*ky + 2]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y*w + x] = mask.amarelo(x, y) ? 1 : 0;
    for (const q of caixas){                       // pixels sobre os próprios pinos (listras amarelas) não contam
      const xa = Math.max(0, Math.ceil(q[0])), xb = Math.min(w - 1, Math.floor(q[0] + q[2])), ya = Math.max(0, Math.ceil(q[1])), yb = Math.min(h - 1, Math.floor(q[1] + q[3]));
      for (let y = ya; y <= yb; y++) m.fill(0, y*w + xa, y*w + xb + 1);
    }
    const vis = new Uint8Array(w*h), saida = [];
    for (let s = 0; s < w*h; s++){
      if (!m[s] || vis[s]) continue;
      const fila = [s]; vis[s] = 1; const px = [];
      while (fila.length){
        const q = fila.pop(); px.push(q); const x = q % w, y = (q - x)/w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){        // 8-conectado: os elos têm buracos
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const k = ny*w + nx; if (m[k] && !vis[k]){ vis[k] = 1; fila.push(k); }
        }
      }
      if (px.length < p.soltaCompMin) continue;
      // eixo principal
      let mx = 0, my = 0; for (const q of px){ mx += q % w; my += Math.floor(q/w); } mx /= px.length; my /= px.length;
      let sxx = 0, syy = 0, sxy = 0; for (const q of px){ const dx = q % w - mx, dy = Math.floor(q/w) - my; sxx += dx*dx; syy += dy*dy; sxy += dx*dy; }
      const tr = sxx + syy, det = sxx*syy - sxy*sxy, l1 = tr/2 + Math.sqrt(Math.max(0, tr*tr/4 - det)), l2 = tr/2 - Math.sqrt(Math.max(0, tr*tr/4 - det));
      if (!(l2 > 0) || Math.sqrt(l1/l2) < p.soltaAlong) continue;                          // precisa ser alongada (linha), não mancha
      const ang = .5*Math.atan2(2*sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang);
      let tmin = Infinity, tmax = -Infinity, pmin, pmax;
      for (const q of px){ const t = (q % w - mx)*ux + (Math.floor(q/w) - my)*uy; if (t < tmin){ tmin = t; pmin = q; } if (t > tmax){ tmax = t; pmax = q; } }
      const P1 = [pmin % w, Math.floor(pmin/w)], P2 = [pmax % w, Math.floor(pmax/w)];
      // um extremo precisa encostar num gancho (topo de pino); o outro é a ponta solta
      let melhor = null;
      for (const n of nos){
        const G = [n.cx*kx, (n.topo + P.ganchoRel*n.h)*ky], tol = Math.max(4, .35*n.h*ky);
        for (const [E, O] of [[P1, P2], [P2, P1]]){ const d = Math.hypot(E[0] - G[0], E[1] - G[1]); if (d <= tol && (!melhor || d < melhor.d)) melhor = {d, n, ponta: O}; }
      }
      if (!melhor) continue;
      // já explicada por uma aresta entre dois pinos?
      if (arestas.some(a => (a.a === melhor.n.id || a.b === melhor.n.id) && pertoDaCurva(a.medida, melhor.ponta))) continue;
      saida.push({de: melhor.n.id, ponta: [melhor.ponta[0]/kx, melhor.ponta[1]/ky], comprimentoPx: (tmax - tmin)/kx, pixels: px.length,
        saiDoQuadro: melhor.ponta[0] <= 1 || melhor.ponta[1] <= 1 || melhor.ponta[0] >= w - 2 || melhor.ponta[1] >= h - 2, confianca: clamp01(.4 + .1*Math.sqrt(l1/l2))});
    }
    return saida;
  }
  function pertoDaCurva(m, Q){ for (let k = 0; k <= 16; k++){ const c = amostra(m.pts, k/16); if (Math.hypot(c[0] - Q[0], c[1] - Q[1]) < 6) return true; } return false; }

  // ---------- 4 e 5. TRAJETÓRIA E RELEVÂNCIA ----------
  // Pontos de uma corrente no QUADRO, com a profundidade interpolada entre os pinos das pontas.
  function pontosAresta(ar, nosPorId, kx, ky, n = 12){
    const a = nosPorId.get(ar.a), b = nosPorId.get(ar.b), pts = [];
    for (let k = 0; k <= n; k++){
      const t = k/n, [u, v] = amostra(ar.medida.pts, t);
      const z = a.z != null && b.z != null ? a.z + t*(b.z - a.z) : (a.z ?? b.z ?? null);
      pts.push({x: u/kx, y: v/ky, z});
    }
    return pts;
  }
  const zonaX = (x, W) => x < W/3 ? 'esquerda' : x > 2*W/3 ? 'direita' : 'frente';
  function interpretar(cena, grafo, soltas, W, H, kx, ky, p = P){
    const porId = new Map(grafo.nos.map(n => [n.id, n]));
    // componentes conectados (estrutura): um pino distante continua relevante se a estrutura dele chega perto
    const pai = new Map(grafo.nos.map(n => [n.id, n.id])), raiz = i => { while (pai.get(i) !== i) i = pai.get(i); return i; };
    for (const a of grafo.arestas) pai.set(raiz(a.a), raiz(a.b));
    const comp = new Map();
    for (const n of grafo.nos){ const r = raiz(n.id); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(n); }
    const pertoConfiavel = n => n.z != null && n.confZ >= p.confZDecide && n.z <= p.zRelevante;
    const longeConfiavel = n => n.z != null && n.confZ >= p.confZDecide && n.z > p.zRelevante;
    for (const n of grafo.nos){
      const irmaos = comp.get(raiz(n.id)), ligado = grafo.arestas.some(a => a.a === n.id || a.b === n.id) || soltas.some(s => s.de === n.id);
      if (!longeConfiavel(n)) n.relevancia = n.z == null || n.confZ < p.confZDecide ? 'incerta (mantido)' : 'perto';
      else if (ligado && irmaos.some(pertoConfiavel)) n.relevancia = 'estrutura (longe, ligado ao que está perto)';
      else n.relevancia = 'ignorado (longe e solto)';
      n.relevante = !n.relevancia.startsWith('ignorado');
    }
    // barreiras por zona: trechos de corrente na faixa de interesse (Z até zonaPertoZ, ou Z desconhecido)
    const zonas = {esquerda: [], frente: [], direita: []};
    for (const ar of grafo.arestas){
      const pts = pontosAresta(ar, porId, kx, ky).filter(q => q.z == null || q.z <= p.zonaPertoZ);
      ar.zonas = {};
      if (!pts.length) continue;
      const xs = pts.map(q => q.x), x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(W, Math.max(...xs));
      const cobreFrente = Math.max(0, Math.min(x1, 2*W/3) - Math.max(x0, W/3))/(W/3);
      const zMin = Math.min(...pts.map(q => q.z ?? Infinity));
      const perto = Number.isFinite(zMin) ? clamp01(1.4 - zMin/p.zonaPertoZ) : .5;
      const contagem = {esquerda: 0, frente: 0, direita: 0}; for (const q of pts) contagem[zonaX(q.x, W)]++;
      for (const z of ['esquerda', 'frente', 'direita']){
        const presente = z === 'frente' ? cobreFrente >= p.frenteCobre : contagem[z] >= 2;
        if (!presente) continue;
        const peso = clamp01(ar.confianca*(.5 + .5*perto));
        // caixa (no quadro) do trecho da corrente nessa zona: vira o "obstáculo corrente" da zona na decisão
        const pz = pts.filter(q => zonaX(q.x, W) === z); if (!pz.length) continue;
        const bx0 = Math.max(0, Math.min(...pz.map(q => q.x)) - 2), bx1 = Math.min(W, Math.max(...pz.map(q => q.x)) + 2);
        const by0 = Math.max(0, Math.min(...pz.map(q => q.y)) - 2), by1 = Math.min(H, Math.max(...pz.map(q => q.y)) + 2);
        const zz = Math.min(...pz.map(q => q.z ?? Infinity));     // distância do trecho DESTA zona (a corrente pode se afastar de um lado ao outro)
        zonas[z].push({aresta: ar.a + '-' + ar.b, peso, zMin: Number.isFinite(zz) ? zz : null, confZ: ar.confZ ?? 0, cruza: z === 'frente', bbox: [bx0, by0, Math.max(2, bx1 - bx0), Math.max(2, by1 - by0)]});
        ar.zonas[z] = peso;
      }
    }
    for (const s of soltas){                       // ponta solta: barreira do lado em que ela está (perto), peso menor
      const n = porId.get(s.de); if (!n) continue;
      if (n.z != null && n.confZ >= p.confZDecide && n.z > p.zonaPertoZ) continue;
      const z = zonaX((n.cx + s.ponta[0])/2, W), x0 = Math.max(0, Math.min(n.cx, s.ponta[0])), y0 = Math.max(0, Math.min(n.topo, s.ponta[1]));
      zonas[z].push({aresta: s.de + '-solta', peso: clamp01(s.confianca*.7), zMin: n.z, confZ: n.confZ, cruza: false,
        bbox: [x0, y0, Math.max(2, Math.min(W, Math.max(n.cx, s.ponta[0])) - x0), Math.max(2, Math.min(H, Math.max(n.pe, s.ponta[1])) - y0)]});
    }
    // corredor: barreira dos dois lados (ou uma barreira lateral e pinos relevantes do outro); direção pela parte mais distante
    let corredor = null;
    const lateral = lado => zonas[lado].length > 0 || grafo.nos.some(n => n.relevante && zonaX(n.cx, W) === lado && grafo.arestas.some(a => a.a === n.id || a.b === n.id));
    if (lateral('esquerda') && lateral('direita')){
      // meio do corredor perto × longe: compara o centro dos pinos ligados mais próximos e mais distantes de cada lado
      const lig = grafo.nos.filter(n => n.relevante && n.z != null && grafo.arestas.some(a => a.a === n.id || a.b === n.id));
      const esq = lig.filter(n => n.cx < W/2), dir = lig.filter(n => n.cx >= W/2);
      let direcao = 'frente', conf = .4;
      if (esq.length && dir.length){
        const longe = l => l.reduce((m, n) => n.z > m.z ? n : m), perto = l => l.reduce((m, n) => n.z < m.z ? n : m);
        const meioPerto = (perto(esq).cx + perto(dir).cx)/2, meioLonge = (longe(esq).cx + longe(dir).cx)/2, d = (meioLonge - meioPerto)/W;
        direcao = d > .12 ? 'direita' : d < -.12 ? 'esquerda' : 'frente';
        conf = clamp01(.4 + Math.min(...lig.map(n => n.confZ))*.5);
      }
      // corrente cruzando a frente LÁ NO FUNDO do corredor: o corredor vira para o lado sem barreira
      if (zonas.frente.length && direcao === 'frente'){
        const fundo = zonas.frente.every(b => b.zMin != null && b.zMin > 2);
        if (fundo){ const pe = zonas.esquerda.reduce((s, b) => s + b.peso, 0), pd = zonas.direita.reduce((s, b) => s + b.peso, 0); direcao = pe > pd ? 'direita' : 'esquerda'; conf *= .8; }
      }
      corredor = {direcao, confianca: conf};
    }
    const ignorados = grafo.nos.filter(n => !n.relevante).map(n => n.id);
    // pinos além da faixa de interesse (Z confiável > zonaPertoZ): fazem parte da estrutura (grafo, corredor), mas não são obstáculo
    // agora; a parte da corrente que chega perto já entra como barreira da zona. Profundidade incerta: o pino continua obstáculo.
    const longe = grafo.nos.filter(n => n.relevante && n.z != null && n.confZ >= p.confZDecide && n.z > p.zonaPertoZ).map(n => n.id);
    return {zonas, corredor, ignorados, longe};
  }

  // ---------- Fachada com estado (horizonte e Z suavizados entre quadros) ----------
  function criarPercurso(op = {}){
    const p = Object.assign({}, P, op);
    let estado = {}, anteriores = [];
    function analisar({pinos, outros = [], img, W, H}){
      const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
      if (!Array.isArray(pinos) || !pinos.length || !img || !img.data || !(W > 0) || !(H > 0)){ anteriores = []; return null; }
      const kx = img.w/W, ky = img.h/H;
      const cena = estimarCena(pinos, outros, W, H, estado, p);
      // suavização temporal do Z por pino (casa pela caixa mais parecida do quadro anterior)
      for (const n of cena.nos){
        if (n.z == null) continue;
        const ant = anteriores.find(a => a.z != null && iou(a.bbox, n.bbox) > .3);
        if (ant){ n.z = ant.z + p.zEma*(n.z - ant.z)*(1 + (n.confZ - ant.confZ)); n.z = Math.max(.2, n.z); n.confZ = Math.min(1, Math.max(n.confZ, ant.confZ*.9) + .05); n.camada = camadaDe(n.z, n.confZ, p); n.x = (n.cx - W/2)*n.z/cena.f; }
      }
      estado = {horizonte: cena.horizonte, conf: cena.confHorizonte};
      anteriores = cena.nos.map(n => ({bbox: n.bbox, z: n.z, confZ: n.confZ}));
      const ocl = outros.map(o => o.bbox);
      const mask = mascaraCorrente(img, p);
      const grafo = montarGrafo(cena, img, mask, ocl, kx, ky, p, outros.map(o => o.class));
      const soltas = pontasSoltas(img, mask, grafo.nos, grafo.arestas, kx, ky, p);
      const trajeto = interpretar(cena, grafo, soltas, W, H, kx, ky, p);
      const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
      return {cena, grafo, soltas, ...trajeto, ms, kx, ky};
    }
    return {analisar, reset(){ estado = {}; anteriores = []; }, P: p};
  }
  function iou(a, b){
    const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0]+a[2], b[0]+b[2]), y1 = Math.min(a[1]+a[3], b[1]+b[3]);
    if (x1 <= x0 || y1 <= y0) return 0; const i = (x1-x0)*(y1-y0); return i/(a[2]*a[3] + b[2]*b[3] - i);
  }
  // Subtipo pelo visual (atributo, não classe): listrado amarelo e preto × cromado. Amostra a coluna central da caixa.
  function subtipoPino(img, bbox, kx, ky, p = P){
    const x = Math.round((bbox[0] + bbox[2]/2)*kx), y0 = Math.round((bbox[1] + .15*bbox[3])*ky), y1 = Math.round((bbox[1] + .7*bbox[3])*ky);
    let am = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let dx = -1; dx <= 1; dx++){ const xx = x + dx; if (xx < 0 || y < 0 || xx >= img.w || y >= img.h) continue; n++; if (ehAmarelo(img.data, 4*(y*img.w + xx), p)) am++; }
    return !n ? null : am/n > .12 ? 'listrado' : 'cromado';
  }

  const api = {P, estimarCena, medirCorrente, montarGrafo, pontasSoltas, interpretar, criarPercurso, subtipoPino, camadaDe, focal, mascaraCorrente, caminhoDP, amostra};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else g.VisioPercurso = api;
})(typeof window !== 'undefined' ? window : globalThis);
