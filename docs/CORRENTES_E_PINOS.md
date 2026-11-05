# Correntes, pinos e profundidade (05/11/2026)

Pedido do Ryan: reconhecer os **pinos** (pedestais de sinalização) e as **correntes** penduradas entre eles, entender que juntos formam as
paredes de um percurso (labirinto), estimar a **profundidade** de cada elemento (2.5D) e usar isso na orientação, sem piorar o que já
funciona. Proximidade na imagem não pode ser tratada como prova de ligação, e a profundidade não pode ser o único critério.

## O que mudou no app

| Parte | Onde | O quê |
|---|---|---|
| Classe nova "pino" | `treino/classes.py`, `modelos/fabrica/` | O YOLO da fábrica passou de 10 para 11 classes. "pino" entrou no **fim** da lista, então os índices antigos não mudam |
| Módulo novo | `js/percurso.js` | Lógica pura (sem DOM): cena 2.5D, corrente entre ganchos, grafo, zonas, corredor e relevância |
| Integração | `js/app.js` | Roda na mesma tarefa de detecção, depois das setas e do detector genérico, usando a mesma cópia reduzida do quadro (lado maior 320 px) |
| Decisão | `js/nucleo.js` | Corrente vira obstáculo "corrente" na região onde está; o corredor entre correntes vira uma sugestão no modo Guia por probabilidade |
| Painel | `visioindustria.html` | Seção "Correntes e pinos": estado, tempo por quadro, liga/desliga o módulo e a caixa **Depuração** (desligada por padrão) |

Sem nenhum pino na imagem, o módulo devolve nada e o app se comporta **exatamente** como antes (há um teste que confere as falas com e sem o
módulo).

## Como funciona (`js/percurso.js`)

1. **Cena 2.5D.** Para cada pino, uma estimativa de distância Z em metros e uma confiança, com duas pistas independentes:
   - *altura aparente*: o pedestal tem altura conhecida (~0,95 m), então Z ≈ f × 0,95 / altura em pixels;
   - *contato com o piso*: o pé do pino em relação à linha do horizonte. O horizonte é tirado dos próprios pinos inteiros (cada um diz onde
     ele está); sem isso, usa a altura da câmera (~1,25 m).
   Quando as duas concordam, a confiança sobe; quando discordam, cai. Pino cortado pela borda vira limite (no máximo/no mínimo), não número.
   Um pino que tapa outro precisa estar mais perto; se a estimativa disser o contrário, a confiança cai. Z e horizonte são suavizados entre
   quadros. Cada pino recebe uma camada: perto (< 1,8 m), meio (< 4,5 m), fundo, ou **incerta** quando a confiança é baixa.
2. **Corrente.** Para cada par de pinos, procura nos pixels uma corrente pendurada entre os **ganchos** (topo do pino): o melhor caminho
   que desce entre os dois ganchos sobre pixels de corrente (amarelo saturado, ou escuro e fino contra fundo mais claro). Depois mede:
   cobertura, se as curvas paralelas vizinhas também têm "corrente" (então é textura ou borda, não linha fina), maior interrupção, se as duas
   pontas chegam aos ganchos e quanto do trecho está atrás de um objeto detectado (oculto conta como desconhecido, não como falta).
3. **Grafo.** Nós são os pinos; uma aresta (ligação) só é aceita se tudo fechar junto:
   - evidência visual suficiente (cobertura, contraste com o entorno, sem buraco longo sem objeto na frente, pontas nos ganchos);
   - com profundidade confiável: **vão em metros** plausível (0,35 a 6,5 m) e **trajeto 3D**: a curva vista precisa caber numa corrente
     pendurada entre os dois ganchos no espaço (projeção da catenária). Uma corrente de outro plano que só passa perto de um gancho na
     imagem não cabe;
   - se a curva passa pelo gancho de **outro** pino, a ligação é recusada (são duas correntes presas nele), **a não ser** que a
     profundidade mostre que esse pino está em outro plano (só sobreposição visual);
   - cada pino segura no máximo 3 correntes; duas ligações que seguem a mesma curva viram uma (fica a que a profundidade explica melhor).
   As ligações recusadas ficam guardadas com o motivo, para a depuração. Correntes amarelas que saem de um gancho e terminam sem outro pino
   (por exemplo, saem do quadro) ficam como **pontas soltas**.
4. **Trajetória.** Cada corrente aceita vira uma barreira por região (esquerda, frente, direita) com a distância mínima. Duas paredes laterais
   formam um **corredor**; se uma corrente fecha a frente lá no fundo, o corredor vira para o lado aberto.
5. **Relevância.** Pino perto, ou ligado a uma estrutura que chega perto, é relevante. Pino solto e distante, **com profundidade confiável**,
   é ignorado na decisão. Profundidade de baixa confiança **nunca** descarta nada ("incerta, mantido").

## Na decisão (modo Guia por probabilidade)

- Cada corrente aceita entra como obstáculo "corrente" **só pelo trecho que está perto** (até ~3,5 m) e só na região onde esse trecho está.
  A fala usa o nome: "Corrente à frente…".
- Pinos e correntes com distância confiável pesam **pela distância**, não pela área na imagem (uma corrente comprida lá longe tem caixa
  grande, mas não bloqueia agora): até 1 m vale 97%, cai em linha até 20% a 3,5 m (`PROB.distPerto`, `distLonge`, `distMin` em
  `js/nucleo.js`). Sem distância confiável vale a regra antiga (60% + tamanho). Os outros objetos não mudam.
- Os pinos continuam sendo obstáculos como qualquer objeto ("Pino à direita…"). Saem da decisão (ficam no grafo e na depuração) o pino
  solto e distante e o pino da estrutura que está além de ~3,5 m, sempre com profundidade confiável; com profundidade incerta, fica.
- O corredor é uma **sugestão**: só desempata quando a direção dele está até 15 pontos da melhor, com confiança ≥ 0,5 e visto há até 3 s.
  A seta da parede continua tendo prioridade sobre o corredor.

## Depuração

Marque "Depuração" no painel "Correntes e pinos". Sobre a imagem aparecem: a linha do horizonte e as faixas de ~1, 2 e 4 m no piso; cada
pino com Z, camada e confiança; as correntes aceitas (verde), as recusadas com alguma evidência (tracejado cinza), as pontas soltas e o
corredor. Desmarcada (padrão), a tela fica como antes: pinos e correntes não ganham caixa própria.

## Como conferir

```
npm test                                                         # inclui testes/percurso.test.js (cenas sintéticas)
python treino/avaliar_percurso.py novos-objetos_provavel_percurso.zip              # grafo nas fotos reais, com e sem profundidade
python treino/avaliar_percurso.py novos-objetos_provavel_percurso.zip --pinos modelo   # o mesmo, com os pinos do detector
CAMERA=camera.y4m SAIDA=pasta node testes/navegador/verificar-percurso.js             # Chromium real (instruções no topo do arquivo)
```

Os testes sintéticos desenham cenas com o mesmo modelo de câmera e cobrem: pinos perto e longe, correntes sobrepostas em planos diferentes,
objetos de fundo parecidos (faixa amarela e preta, cadeira escura), corrente parcialmente oculta atrás de objeto contra corrente partida,
mudança de perspectiva e corredor, ligações que parecem existir mas não existem (com e sem profundidade), pino distante que faz parte do
percurso, proximidade sozinha, profundidade de baixa confiança e o tempo do módulo.

## Retreinar com fotos novas

`treino/percurso_fotos.py` (instruções no topo): `propor` pré-anota pinos em fotos novas, você revisa as caixas em
`treino/conjuntos/percurso/anotacoes_pinos.json`, depois `preparar` monta o conjunto (pinos revisados + as outras classes rotuladas pelo
modelo atual + o banco unificado inteiro) e `treino/treinar.py` treina e publica.

## Limites conhecidos

- Profundidade de uma câmera só é **estimativa**: depende de os pinos terem a altura típica e o piso ser plano.
- Corrente fina e escura atrás de cadeiras pretas, ou muito longe (1 a 2 pixels na cópia de 320 px), muitas vezes não é confirmada: o app
  então não cria a ligação (prefere faltar a inventar).
- O pedestal cromado de fita retrátil cortado pela borda não tem gancho visível; uma ligação dele pode ser aceita por engano (1 caso nas
  fotos de validação).
- Os números de chance continuam sendo regras, não probabilidades medidas.
- Tempo: cerca de 55 a 65 ms por quadro no Chromium deste computador com 5 pinos (o módulo roda na página, fora do Worker do modelo);
  no celular deve ser 2 a 4 vezes mais. Sem pino na imagem o módulo não roda.
