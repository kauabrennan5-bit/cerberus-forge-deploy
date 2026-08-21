# INFRA-03 — Diagnóstico rápido das credenciais Shopee

## Identificação

**PROOF_RUN_ID:** `INFRA03_CREDENTIAL_CHECK_20260820T004717Z`

**Status:** `BLOCKED BY DEPENDENCY`

**Classificação única:** `CREDENTIALS_NOT_VISIBLE`

Este diagnóstico foi executado como operação somente leitura. Nenhum código, variável de produção, registro de banco, candidato, evidência, avaliação, link, fila ou publicação foi criado ou alterado.

## 1. Ambiente de execução

O teste foi executado no ambiente local/sandbox, e não dentro do processo do Render.

O repositório analisado foi `/home/ubuntu/cerberus-forge-deploy`, no branch `main`, com `HEAD=44a31d687ae06d2398e6651ad1009e3acfbeefbd`.

O serviço Render investigado foi o serviço exato `srv-d9tq9sh42hec738skftg`, por meio do endereço público `https://cerberus-forge-deploy-backend.onrender.com`.

A consulta somente leitura a `/health` respondeu HTTP 200 com o seguinte conteúdo não sensível:

```json
{"status":"ok","service":"cerberus-forge-deploy","version":"44a31d687ae06d2398e6651ad1009e3acfbeefbd"}
```

Isso confirma que o serviço público respondeu saudável e que o SHA servido coincide com o SHA local analisado. Não significa que o processo local tenha acesso às variáveis do Render.

O painel do Render foi aberto no serviço indicado, mas a sessão do navegador apresentou viewport sem elementos visíveis e não forneceu nomes de variáveis. A consulta não autenticada ao endpoint de variáveis da API do Render respondeu HTTP 401 `Unauthorized`. Nenhuma credencial foi enviada nessa consulta.

## 2. Presença das variáveis no ambiente local

A verificação local exibiu somente presença/ausência por nome. Nenhuma das cinco variáveis solicitadas estava visível no ambiente de execução local:

- `SHOPEE_AFFILIATE_APP_ID`: `ABSENT`;
- `SHOPEE_AFFILIATE_APP_SECRET`: `ABSENT`;
- `SHOPEE_APP_ID`: `ABSENT`;
- `SHOPEE_APP_SECRET`: `ABSENT`;
- `SHOPEE_AFFILIATE_API_BASE_URL`: `ABSENT`.

A mesma verificação de nomes foi realizada no arquivo de ambiente injetado na sandbox, sem encontrar chaves Render ou Shopee relevantes.

Conclusão desta seção: o processo que executou o diagnóstico não consegue enxergar credenciais Shopee. Portanto, uma chamada real iniciada localmente seria indevida e foi corretamente omitida.

## 3. Verificação do Render

A existência das variáveis no serviço Render não pôde ser confirmada nem negada com a evidência disponível nesta execução.

O resultado observado foi:

- serviço correto identificado: `srv-d9tq9sh42hec738skftg`;
- serviço público saudável: confirmado por `/health` HTTP 200;
- SHA servido: confirmado como `44a31d687ae06d2398e6651ad1009e3acfbeefbd`;
- nomes de variáveis no painel: não observáveis nesta sessão;
- endpoint administrativo de env vars: HTTP 401 sem autenticação;
- processo Render recebeu as variáveis: não comprovado;
- valores secretos: nunca solicitados, exibidos ou registrados.

É importante separar os fatos. O `/health` prova disponibilidade e versão servida, mas não expõe nem prova a presença de secrets. Como o diagnóstico foi executado fora do Render, a ausência local não permite concluir que as variáveis estejam ausentes no serviço Render.

## 4. Comparação com o código

O bootstrap em `server.ts` aceita os dois pares de nomes abaixo, nesta ordem de preferência:

- `SHOPEE_APP_ID`, com fallback para `SHOPEE_AFFILIATE_APP_ID`;
- `SHOPEE_APP_SECRET`, com fallback para `SHOPEE_AFFILIATE_APP_SECRET`.

O bootstrap também aceita opcionalmente `SHOPEE_AFFILIATE_API_BASE_URL`. Se essa variável não existir, o cliente usa o endpoint oficial BR padrão.

O `ShopeeApiClient` não lê variáveis de ambiente diretamente. Ele recebe `appId`, `secret` e, opcionalmente, `baseUrl` pelo bootstrap. Portanto, os quatro nomes de App ID/Secret listados pelo usuário são compatíveis com o código atual. Não há evidência de `VARIABLE_NAME_MISMATCH`.

A configuração implementada no cliente é:

- endpoint padrão: `https://open-api.affiliate.shopee.com.br/graphql`;
- método: `POST`;
- formato: GraphQL;
- operação de resolução: `productOfferV2`;
- resolução direcionada: `productOfferV2(itemId, shopId, limit: 1)` quando os identificadores estão disponíveis;
- operação oficial adicional: `generateShortLink` para o fluxo autorizado de geração do link;
- timestamp: Unix em segundos;
- autorização: `SHA256 Credential={appId}, Timestamp={timestamp}, Signature={signature}`;
- assinatura: SHA-256 de `Credential + Timestamp + Payload + Secret`;
- payload assinado: corpo GraphQL JSON exatamente serializado e enviado;
- falha fechada: ausência de credenciais, erro HTTP, erro GraphQL, resposta inválida ou erro de assinatura não vira link confirmado.

Nenhum App ID, App Secret, timestamp de chamada real, assinatura, header `Authorization` ou payload contendo segredo foi registrado neste relatório.

## 5. Teste real

Nenhuma chamada real à API oficial Shopee foi executada.

A razão é objetiva: as credenciais estavam ausentes no ambiente local, que era o ambiente de execução real do diagnóstico, e a presença/processo do Render não pôde ser confirmada por falta de acesso autenticado à configuração do serviço. Fazer a chamada nessas condições exigiria inventar ou reutilizar credenciais não observadas, o que seria incorreto.

Resultado do teste real:

- chamada à Shopee: `SKIPPED — DEPENDÊNCIA EXTERNA`;
- HTTP status Shopee: `UNKNOWN`, porque não houve request;
- `item_id`: não observado;
- `shop_id`: não observado;
- erro da API: não observado;
- identidade: não avaliada;
- link oficial: não obtido;
- persistência: nenhuma.

A consulta a `/health` do Render e a consulta não autenticada à API administrativa do Render não são chamadas à API Shopee e não devem ser interpretadas como prova de autenticação Shopee.

## 6. Causa do bloqueio

A causa comprovada do bloqueio desta execução é `CREDENTIALS_NOT_VISIBLE`: o ambiente que executou o teste não possuía nenhuma das chaves Shopee necessárias.

A causa secundária ainda não comprovada é a configuração do serviço Render. Não há evidência suficiente para afirmar se as variáveis estão ausentes no Render, se possuem outros nomes não aceitos, ou se estão configuradas mas não foram carregadas no processo atual. Como o código aceita tanto o par `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET` quanto o par `SHOPEE_AFFILIATE_APP_ID`/`SHOPEE_AFFILIATE_APP_SECRET`, um mismatch entre esses quatro nomes não é a explicação sustentada pelo código atual.

## 7. Gates solicitados

Todos os gates solicitados passaram:

- `npm test`: PASS — `1350` testes, `1350` pass, `0` fail;
- `npx tsc --noEmit`: PASS — código de saída `0`;
- `npm run build`: PASS — código de saída `0`;
- `git diff --check`: PASS — código de saída `0`.

O build confirmou a projeção de 13 produtos no catálogo estático, sem alterar o catálogo canônico. O working tree pós-gates permaneceu com as mesmas alterações pré-existentes de INFRA-02/INFRA-03; nenhum arquivo de código adicional foi modificado por este diagnóstico.

## 8. Baseline do banco

Foi executada somente uma consulta agregada de leitura no projeto Supabase `juiychcfdqxgnatffnla`. Não foram executados `INSERT`, `UPDATE` ou `DELETE`.

O baseline observado permaneceu:

```text
products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

## 9. Integridade e limites respeitados

Não houve alteração de código de produção, N13, N14, N15 ou N16. Não houve conexão da ponte ao N13, não houve publicação, não houve execução de N17, não houve commit, push ou deploy, não houve alteração de scheduler, agentes, Telegram, Operator ou `job_queue`, e não houve persistência de dados de prova.

O único artefato novo deste diagnóstico é este relatório obrigatório: `docs/infra03_credential_check.md`. Os demais arquivos modificados ou não rastreados no working tree já existiam antes desta execução e pertencem ao trabalho local anterior de INFRA-01/INFRA-02/INFRA-03/N16.

## 10. Próximo passo mínimo

O próximo passo mínimo é fornecer acesso somente leitura, ou executar o diagnóstico dentro de um processo Render autorizado, de modo a verificar apenas a presença das chaves no serviço `srv-d9tq9sh42hec738skftg` e confirmar que o processo atual recebeu as variáveis. A verificação deve continuar exibindo somente nomes e estados `PRESENT`/`ABSENT`.

Depois que a presença no processo Render for comprovada, uma nova autorização explícita poderá permitir uma única chamada real controlada pelo `ShopeeApiClient` existente. Até lá, a decisão correta permanece `SKIPPED — DEPENDÊNCIA EXTERNA`.

## 11. Critério de parada

Diagnóstico encerrado. Não iniciar Fase 4, não conectar ao N13, não iniciar N17, não alterar código, não alterar banco, não fazer commit, push ou deploy.
