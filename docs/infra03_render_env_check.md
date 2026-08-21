# INFRA-03 — Diagnóstico final Render → Shopee

**PROOF_RUN_ID:** `INFRA03_RENDER_ENV_RECHECK_20260820T010000Z`

**Objetivo:** reverificar a configuração do serviço Render depois da atualização das credenciais, sem expor valores, sem chamar a Shopee e sem alterar código, banco ou produção.

## Status final

**STATUS = RENDER_RUNTIME_NOT_VERIFIABLE**

A configuração Environment do serviço Render agora mostra as duas credenciais Shopee pelos nomes oficiais esperados pelo bootstrap de fallback. A propagação efetiva para o processo Node live não pôde ser confirmada diretamente nesta execução, portanto não foi declarado `CREDENTIALS_VISIBLE_TO_RUNTIME` nem foi feita chamada real à Shopee.

## Serviço, saúde e SHA

A verificação foi direcionada ao serviço Render exato `srv-d9tq9sh42hec738skftg`.

O endpoint público `/health` respondeu `HTTP 200` com:

```text
status=ok
service=cerberus-forge-deploy
version=44a31d687ae06d2398e6651ad1009eacfbeefbd
timestamp=2026-08-20T01:09:56.715Z
```

**Observação:** o SHA retornado pelo `/health` foi `44a31d687ae06d2398e6651ad1009eacfbeefbd`, que é o SHA esperado informado para a verificação.

## Presença das variáveis no Render

A lista autenticada do Environment foi consultada somente por nomes. Os valores permaneceram mascarados e não foram abertos, copiados, impressos ou registrados.

```text
SHOPEE_APP_ID=ABSENT
SHOPEE_APP_SECRET=ABSENT
SHOPEE_AFFILIATE_APP_ID=PRESENT
SHOPEE_AFFILIATE_APP_SECRET=PRESENT
SHOPEE_AFFILIATE_API_BASE_URL=ABSENT
```

Os nomes `SHOPEE_AFFILIATE_APP_ID` e `SHOPEE_AFFILIATE_APP_SECRET` estão presentes na configuração atual do serviço Render. `SHOPEE_AFFILIATE_API_BASE_URL` está ausente, mas é opcional e o cliente possui endpoint BR padrão.

A classificação acima é de presença do nome na configuração, não uma leitura ou validação do conteúdo do segredo.

## Comparação com o bootstrap

O bootstrap existente aceita os aliases nesta ordem:

```text
App ID:
1. SHOPEE_APP_ID
2. SHOPEE_AFFILIATE_APP_ID

App Secret:
1. SHOPEE_APP_SECRET
2. SHOPEE_AFFILIATE_APP_SECRET

Endpoint opcional:
SHOPEE_AFFILIATE_API_BASE_URL
```

Portanto, os dois nomes atualmente presentes no Render coincidem com os fallbacks aceitos pelo código. Não há evidência de `VARIABLE_NAME_MISMATCH`.

A ausência de `SHOPEE_AFFILIATE_API_BASE_URL` não é erro de configuração: o cliente usa o endpoint oficial BR padrão quando essa variável opcional não existe.

## Propagação para o runtime Node

A cadeia de configuração foi parcialmente confirmada:

```text
Render Environment
  SHOPEE_AFFILIATE_APP_ID        PRESENT
  SHOPEE_AFFILIATE_APP_SECRET    PRESENT
        ↓
Bootstrap Node
  aliases compatíveis com o código
        ↓
Processo Node live
  propagação direta: UNKNOWN
        ↓
ShopeeApiClient
  inicialização efetiva nesta execução: UNKNOWN
```

Foi tentada a abertura do Shell do serviço para uma verificação por nomes no runtime. A interface do Shell não permaneceu disponível e retornou `about:blank`/`Browser not available` durante a verificação. Nenhum comando foi enviado ao Shell.

O endpoint `/health` confirma que o processo live está saudável e serve o SHA esperado, mas não expõe o estado das variáveis Shopee. Sem introspecção autorizada do runtime ou um indicador já existente no serviço, não é possível provar que o processo atual recebeu os valores após a atualização.

A classificação correta, conforme o critério solicitado, é `RENDER_RUNTIME_NOT_VERIFIABLE`.

## Restart ou redeploy

A presença das chaves no Environment foi confirmada, mas a propagação para o processo não foi observável. Como a página de deploys não pôde ser reaberta nesta rechecagem por indisponibilidade do navegador, não foi possível confirmar se a alteração das envs já acionou restart/redeploy.

O SHA live continua sendo o SHA esperado. Se o Render não tiver reiniciado o processo depois da atualização das variáveis, será necessário o mecanismo normal de restart/redeploy do próprio Render para que as envs sejam carregadas pelo processo Node. Nenhum restart, redeploy, deploy manual, rollback ou alteração foi executado nesta tarefa.

## Cliente Shopee

O cliente existente permanece configurado para o endpoint oficial BR padrão:

```text
https://open-api.affiliate.shopee.com.br/graphql
```

A operação GraphQL utilizada é `productOfferV2`, com resolução direcionada por `itemId` e `shopId` quando disponíveis.

A autenticação configurada é:

```text
Authorization: SHA256 Credential={appId}, Timestamp={timestamp}, Signature={signature}
```

O timestamp é Unix em segundos. A assinatura é SHA-256 de:

```text
Credential + Timestamp + Payload + Secret
```

O payload corresponde ao corpo GraphQL serializado exatamente como enviado. Nenhuma assinatura, header, payload sensível ou valor de credencial foi lido ou registrado nesta rechecagem.

## Teste real da Shopee

**Não executado.**

A solicitação desta etapa era confirmar somente a cadeia Render → runtime. Não houve chamada à Shopee, nenhum HTTP status da Shopee, nenhuma resposta GraphQL, nenhum `item_id`, nenhum `shop_id`, nenhum `offerLink` e nenhum erro de autenticação.

Não foram usados scraping, proxy, browser para a Shopee, cookies, spoofing de User-Agent, bypass ou endpoint alternativo. Nenhum dado foi persistido.

## Baseline Supabase

Foi executada somente uma consulta de contagem. Nenhum `INSERT`, `UPDATE` ou `DELETE` foi executado.

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

O baseline permanece intacto.

## Integridade e escopo

A rechecagem não alterou código, N13, N14, N15, N16, banco, catálogo, configuração Render ou produção. Não houve conexão ao N13, publicação, commit, push, deploy iniciado pelo diagnóstico ou início do N17.

As alterações de código e documentos pré-existentes no working tree pertencem às fases anteriores e não foram modificadas por esta rechecagem. O único documento atualizado nesta tarefa foi este relatório solicitado.

## Conclusão e próximo passo mínimo

As credenciais estão agora configuradas no Render pelos nomes `SHOPEE_AFFILIATE_APP_ID` e `SHOPEE_AFFILIATE_APP_SECRET`, que coincidem com os fallbacks aceitos pelo bootstrap. A chave de endpoint opcional está ausente, sem impacto porque existe endpoint oficial BR padrão.

A causa anterior de ausência das chaves no Render foi corrigida no nível da configuração. Ainda falta provar a propagação ao processo Node live. O próximo passo mínimo é aguardar ou realizar, com autorização própria do ambiente Render, o restart/redeploy normal e repetir uma verificação somente leitura do runtime. Somente após `CREDENTIALS_VISIBLE_TO_RUNTIME` poderá ser considerada uma chamada real, em etapa separada e com autorização explícita.

## Critério de parada

Diagnóstico encerrado como `RENDER_RUNTIME_NOT_VERIFIABLE`.

Não fazer chamada Shopee nesta etapa. Não iniciar Fase 4, não conectar ao N13 e não iniciar N17.

## Referências

[1]: https://cerberus-forge-deploy-backend.onrender.com/health "Endpoint público de saúde do Cerberus Forge"

[2]: https://dashboard.render.com/web/srv-d9tq9sh42hec738skftg/env "Environment do serviço Render srv-d9tq9sh42hec738skftg"

[3]: https://dashboard.render.com/web/srv-d9tq9sh42hec738skftg/deploys "Deploys do serviço Render srv-d9tq9sh42hec738skftg"

[4]: https://open-api.affiliate.shopee.com.br/graphql "Endpoint oficial GraphQL Shopee Affiliates Brasil"

[5]: /tmp/infra03_render_env_recheck_observation.txt "Evidência da presença dos nomes Shopee no Environment Render"

[6]: /tmp/infra03_render_env_recheck_names.txt "Extração somente de nomes das variáveis Render"

[7]: /tmp/infra03_render_recheck_deploys_observation.txt "Limitação da verificação de deploy/restart nesta rechecagem"

[8]: /tmp/infra03_render_recheck_health.json "Resposta de saúde e SHA servidos após a atualização"

[9]: /home/ubuntu/.mcp/tool-results/2026-08-20_01-10-18.342247976_supabase_execute_sql_c2cc365c.json "Baseline Supabase somente leitura após a atualização"
