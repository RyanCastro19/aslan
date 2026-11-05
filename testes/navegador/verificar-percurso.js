'use strict';
/*
 * Verificação OPCIONAL num Chromium real (Playwright), fora do `npm test`: correntes, pinos e profundidade (js/percurso.js).
 * Câmera FALSA alimentada por um vídeo .y4m feito de uma foto do percurso; modelos REAIS. Sem internet.
 *   ffmpeg -loop 1 -i foto.jpg -vf "scale=480:640" -t 2 -r 15 -pix_fmt yuv420p camera.y4m
 *   CAMERA=camera.y4m SAIDA=pasta NOME=percurso node testes/navegador/verificar-percurso.js "Corrente" [percurso=desligado]
 * Confere: tela limpa com a depuração desligada (padrão), sobreposição com a depuração ligada, tempo do módulo e falas.
 * Os argumentos sem "=" são trechos que alguma fala precisa conter ("!trecho": nenhuma fala pode conter).
 */
const {chromium} = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const RAIZ = path.join(__dirname, '..', '..'), CAM = process.env.CAMERA, NOME = process.env.NOME || 'percurso';
if (!CAM) { console.error('Defina CAMERA (vídeo .y4m, ver o comentário no topo).'); process.exit(2); }
const SAIDA = process.env.SAIDA || path.dirname(CAM); fs.mkdirSync(SAIDA, {recursive: true});
const args = process.argv.slice(2), esperas = args.filter(a => !a.includes('=')), sel = Object.fromEntries(args.filter(a => a.includes('=')).map(a => a.split('=')));
const TIPOS = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream'};
const servir = () => new Promise(ok => {
  const srv = http.createServer((req, res) => {
    const f = path.join(RAIZ, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache'}); fs.createReadStream(f).pipe(res);
  }).listen(0, '127.0.0.1', () => ok(srv));
});
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'FALHA') + ' ' + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const srv = await servir(), base = 'http://localhost:' + srv.address().port + '/';
  const browser = await chromium.launch({args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + CAM]});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, permissions: ['camera']});
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.abort('internetdisconnected'));
  await ctx.addInitScript(() => {
    window.__falas = []; window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    if (window.speechSynthesis) speechSynthesis.speak = u => { window.__falas.push(u.text); };
  });
  const page = await ctx.newPage(), erros = [];
  page.on('pageerror', e => erros.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
  const txt = id => page.textContent('#' + id);
  await page.goto(base + 'visioindustria.html');
  ok(!(await page.isChecked('#depPercurso')), 'depuração do percurso desligada por padrão');
  for (const [id, v] of Object.entries(sel)) await page.selectOption('#' + id, v);
  await page.click('#btnIniciar');
  await page.waitForTimeout(9000);
  ok(true, 'percurso: ' + await txt('pEstado') + ' · ' + await txt('pTempo') + ' · fábrica ' + await txt('mInf') + ' · ciclo ' + await txt('mCic'));
  await page.locator('#stage').screenshot({path: path.join(SAIDA, NOME + '-limpa.png')});
  await page.check('#depPercurso');
  await page.waitForTimeout(3000);
  await page.locator('#stage').screenshot({path: path.join(SAIDA, NOME + '-depuracao.png')});
  await page.locator('#painelPercurso').screenshot({path: path.join(SAIDA, NOME + '-painel.png')});
  ok(true, 'percurso com depuração: ' + await txt('pEstado') + ' · ' + await txt('pTempo'));
  ok(true, 'chance de bloqueio: ' + (await txt('oProb')).replace(/\s+/g, ' '));
  if (process.env.MOTIVOS) console.log('     motivos: ' + await txt('oMot'));
  const falas = await page.evaluate(() => window.__falas.slice());
  ok(falas.length > 0, 'falas: ' + falas.join(' | '));
  for (const e of esperas){
    if (e.startsWith('!')) ok(!falas.some(f => f.includes(e.slice(1))), 'nenhuma fala com "' + e.slice(1) + '"');
    else ok(falas.some(f => f.includes(e)), 'fala com "' + e + '"');
  }
  await page.click('#btnEncerrar');
  const csp = await page.evaluate(() => window.__csp);
  ok(!csp.length, 'sem violação de CSP ' + csp.join(', '));
  ok(!erros.filter(e => !/jsdelivr|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)).length, 'sem erros na página ' + erros.join(' | '));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
