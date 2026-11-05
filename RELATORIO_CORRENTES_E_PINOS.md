# Relatório: correntes, pinos e profundidade (05/11/2026)

Base: `vs_indus_guia_probabilidade.zip` (v0.8.0). Entrega: v0.9.0. Plano seguido: `PLANO_CORRENTES_PINOS_PROFUNDIDADE.md` (nesta pasta).
Explicação completa no código: `docs/CORRENTES_E_PINOS.md`.

## Resultado em uma frase

O app passou a reconhecer os pinos, confirma as correntes pelos pixels entre os ganchos e usa a distância estimada de cada pino para
decidir quais ligações existem e quanto cada uma bloqueia. Nas fotos reais, a profundidade **reduziu as ligações falsas de 5 para 2**
sem perder acertos. Sem pino na imagem, o app se comporta exatamente como antes.

## O que foi feito

| Item | Onde |
|---|---|
| Classe nova **pino** no modelo da fábrica (11 classes; "pino" no fim, os índices antigos não mudam) | `modelos/fabrica/`, `treino/classes.py` |
| 159 pinos revisados à mão em 100 imagens (fotos + 1 quadro por segundo do vídeo) | `treino/conjuntos/percurso/anotacoes_pinos.json` |
| Gabarito do grafo (pinos, ligações, ordem de distância) em 8 fotos | `treino/conjuntos/percurso/grafo_esperado.json` |
| Montagem do treino e pré-anotação de fotos novas | `treino/percurso_fotos.py` |
| Módulo do percurso: profundidade 2.5D, corrente entre ganchos, grafo, zonas, corredor, relevância | `js/percurso.js` (lógica pura) |
| Integração na decisão, painel "Correntes e pinos" e depuração (desligada por padrão) | `js/app.js`, `js/nucleo.js`, `visioindustria.html` |
| **Seta colada numa caixa** (pedido de hoje): a caixa deixa de ser obstáculo e a seta guia | `separarSuportesDeSeta` em `js/nucleo.js` |
| Testes e avaliações | `testes/percurso.test.js`, `testes/setas-e-equipamento.test.js`, `treino/avaliar_percurso.py`, `testes/navegador/verificar-percurso.js` |

## Números

### Detector (classe pino)

| Medida | Valor | Observação |
|---|---|---|
| Pino, fotos separadas do treino (dobra de validação, 16 imagens, 43 pinos) | precisão 0,82 · revocação 0,72 · mAP50 0,75 | A medida honesta: fotos que esse modelo não viu |
| Classes antigas na mesma validação | mAP50 0,93 (caixa) a 0,995 | Sem queda visível |
| Classes antigas no arquivo publicado, fotos_v2 | 14 de 14, igual ao modelo anterior | Dentro da amostra (conferência do arquivo) |
| Banco unificado (59 fotos), modelo novo × anterior | caixa 45 × 47 de 49, manequim 21 × 22, falsos 4 × 1 | Pequena piora em pilhas de caixas vistas de cima; nenhum pino falso |

Antes, o modelo não via pinos: em 7 das 9 fotos de pinos não achava nada, e nas outras 2 dizia "manequim".

### Grafo nas fotos reais (8 fotos com gabarito, 10 ligações)

| Pinos de entrada | Com profundidade | Sem profundidade |
|---|---|---|
| Detector publicado (o app de verdade) | **5 certas, 2 falsas, 5 perdidas** | 4 certas, 5 falsas, 6 perdidas |
| Caixas anotadas (mede só o grafo) | 6 certas, 2 falsas, 4 perdidas | 6 certas, 3 falsas, 4 perdidas |

Ordem de distância entre pares de pinos: 16 de 18 certos com o detector (17 de 20 com as caixas anotadas).
As perdas são quase todas correntes escuras atrás de cadeiras pretas ou muito longe (1 a 2 pixels na imagem de análise). O app prefere
não criar a ligação a inventá-la. Uma das falsas vem do pedestal cromado cortado pela borda, que não mostra gancho.

### Cenas sintéticas (16 testes, todos passam)

Elas cobrem: pinos perto e longe, correntes sobrepostas em planos diferentes, fundo parecido (faixa amarela e preta, cadeira escura),
corrente parcialmente oculta e corrente partida, mudança de perspectiva e corredor que vira, e ligações falsas. No caso da corrente do
fundo que passa pelo gancho de um pino da frente, com profundidade fica certo e sem profundidade fica errado. Também cobrem pino distante
que faz parte do percurso, proximidade sozinha, profundidade incerta (nunca descarta nada), peso pela distância e tempo.

### Suíte e navegador

- `npm test`: **204 de 204** (eram 186; 18 novos).
- Chromium real com câmera falsa (foto do percurso):
  - **cerca de 55 a 65 ms por quadro** para o módulo, de início 160 ms; ficou 3 vezes mais rápido sem mudar nenhum resultado;
  - tela limpa com a depuração desligada;
  - sem erro nem violação de CSP.
- Capturas desta pasta:
  - `p14-limpa.png`: tela normal;
  - `p14-depuracao.png` e `p11-depuracao.png`: horizonte, Z de cada pino, ligações aceitas e recusadas;
  - `p14-painel.png`: o painel.

## Seta colada numa caixa

Se a seta lida está, em pelo menos 60%, dentro da caixa de uma **caixa** detectada, essa caixa:

- sai dos obstáculos: não é falada, não entra na chance de bloqueio e não invalida o piso;
- aparece tracejada em verde na tela como "caixa com seta (não é obstáculo)".

A seta é anunciada e seguida, com o motivo "seguindo a seta colada na caixa".

Se a leitura da seta falhar num quadro, a mesma caixa continua como suporte por até 2 s. Os seguintes casos continuam como antes: outras
caixas, seta só encostada na caixa, outras classes, e as setas desligadas.

A leitura da seta sobre papelão foi conferida com desenhos sintéticos em três tons de papelão e três tamanhos: acertou em todos.
**Falta uma foto real** de seta colada numa caixa para confirmar na sala.

## Ajuste feito depois do teste no navegador

Visto de dentro do labirinto, a primeira versão mandava "Pare e peça ajuda": pinos e correntes distantes contavam como obstáculos perto,
porque a regra antiga usa o tamanho da caixa na imagem.

Agora, pinos e correntes com distância confiável pesam pela distância: 97% até 1 m, caindo até 20% a 3,5 m. Pinos da estrutura além de
~3,5 m não são obstáculo. Na mesma foto, a fala passou a ser "Siga em frente devagar, com muito cuidado, chance de bloqueio alta, 90%".
Os outros objetos seguem a regra de antes.

## Limites

- A profundidade de uma câmera só é **estimativa**: supõe um pedestal de ~0,95 m e um piso plano.
- Os números de chance são regras, não probabilidades medidas.
- O módulo roda na página, fora do Worker do modelo. No celular, o tempo deve ser 2 a 4 vezes o medido aqui; vale medir na sala.
- A revocação do pino (0,72 em fotos não vistas) pede mais fotos, principalmente de pinos longe e de pedestais cromados.

## Como desfazer

O modelo anterior está em `treino/modelo-anterior/` (no zip). Para voltar só o modelo, copie os três arquivos para `modelos/fabrica/`.
Para desligar o módulo sem mexer no modelo, use "Correntes e pinos → Desligado" no painel.

## Arquivos desta pasta

- `vs_indus_correntes_e_pinos.zip`: o projeto completo (inclui `treino/modelo-anterior/`).
- `0008-correntes-pinos-e-profundidade.patch`: o commit sobre `vs_indus_guia_probabilidade.zip`, para `git am`.
- `correntes-e-pinos.bundle`: o histórico git com as branches `banco-fotos-camera`, `setas-e-equipamento`, `guia-probabilidade` e
  `correntes-e-pinos`.
- `RELATORIO_CORRENTES_E_PINOS.md` (este), `PLANO_CORRENTES_PINOS_PROFUNDIDADE.md` e as capturas.
