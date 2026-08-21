# INFRA-03 — Fase 3B — Confirmação de Propagação no Runtime

```text
PROOF_RUN_ID:
INFRA03_RUNTIME_PROPAGATION_20260820T021500Z

STATUS:
CREDENTIALS_VISIBLE_TO_RUNTIME
```

## Escopo e restrições

A verificação foi executada somente para confirmar a cadeia **Render Environment → processo Node → bootstrap Shopee**. Não houve chamada à API Shopee, scraping, proxy, bypass, spoofing de User-Agent, alteração de código, alteração de N13–N16, conexão ao N13, início de N17, mutação de banco, commit ou push.

Os valores de App ID, App Secret, assinatura e cabeçalhos de autorização não foram acessados, impressos ou registrados.

## Serviço e SHA

O serviço verificado foi `srv-d9tq9sh42hec738skftg`.

O SHA esperado e o SHA usado pelo processo são:

```text
44a31d687ae06d2398e6651ad1009eacfbeefbd
```

Foi realizado um redeploy manual autorizado pelo painel Render para o mesmo SHA. O painel registrou o deployment `dep-da35b18jo6nc73dotql0`, com status **Deploy succeeded | Live**, trigger manual e duração de 28,6 segundos. A interface registrou `Build cache cleared`; nenhum arquivo de código foi alterado nesta operação.

O build concluiu com sucesso, o catálogo estático foi gerado a partir de 13 produtos canônicos e o processo Node ficou disponível em produção.

## Saúde em produção

A consulta ao endpoint `/health` após o redeploy retornou:

```text
HTTP_STATUS=200
SHA_SERVIDO=44a31d687ae06d2398e6651ad1009eacfbeefbd
```

O painel Render também registrou o serviço como **Live** e informou a disponibilidade da URL primária.

## Variáveis — somente presença

A configuração observada no Environment do serviço antes do redeploy foi:

```text
SHOPEE_AFFILIATE_APP_ID=PRESENT
SHOPEE_AFFILIATE_APP_SECRET=PRESENT
SHOPEE_APP_ID=ABSENT
SHOPEE_APP_SECRET=ABSENT
SHOPEE_AFFILIATE_API_BASE_URL=ABSENT
```

A ausência de `SHOPEE_AFFILIATE_API_BASE_URL` é compatível com o contrato, pois o cliente usa o endpoint oficial BR padrão quando essa variável opcional não existe.

## Propagação para o runtime Node

O bootstrap resolve as variáveis nesta ordem:

```text
App ID: SHOPEE_APP_ID → fallback SHOPEE_AFFILIATE_APP_ID
App Secret: SHOPEE_APP_SECRET → fallback SHOPEE_AFFILIATE_APP_SECRET
Base URL: SHOPEE_AFFILIATE_API_BASE_URL → endpoint oficial BR padrão
```

Depois do redeploy, o log de inicialização do processo registrou somente:

```text
[N8] fonte oficial Shopee afiliados inicializada (endpoint: default BR)
```

Essa mensagem é emitida pelo bootstrap somente dentro do ramo em que os dois valores resolvidos são não vazios e a construção do provider oficial conclui sem exceção. Portanto, sem revelar nenhum valor, a evidência permite classificar:

```text
SHOPEE_AFFILIATE_APP_ID no runtime=PRESENT
SHOPEE_AFFILIATE_APP_SECRET no runtime=PRESENT
```

A propagação foi confirmada indiretamente e de forma fail-closed pelo ramo efetivamente executado no processo Node. Não foi criado endpoint de diagnóstico e não foi usado shell remoto para imprimir ambiente.

## Restart/redeploy

O último deploy anterior à confirmação era o SHA esperado às 01:00:05 UTC. Após a confirmação das envs no Render, foi autorizada uma operação normal para recarregar o runtime. A ação executada no painel foi um redeploy manual do mesmo SHA com limpeza de cache de build; não houve mudança de fonte, configuração pelo agente ou migration.

O novo processo iniciou às 01:17:18 UTC, registrou a inicialização da fonte oficial Shopee às 01:17:20 UTC e ficou Live às 01:17:21 UTC.

## Chamada real à Shopee

```text
CHAMADA_REAL_SHOPEE=SKIPPED — conforme escopo da Fase 3B
HTTP_STATUS_SHOPEE=UNKNOWN
ITEM_ID=UNKNOWN
SHOP_ID=UNKNOWN
OFFER_LINK=UNKNOWN
```

A presença no runtime foi confirmada, mas nenhuma autenticação, resolução `productOfferV2` ou `offerLink` foi testada nesta fase.

## Baseline Supabase — somente leitura

A consulta agregada pós-redeploy confirmou:

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

Nenhum `INSERT`, `UPDATE` ou `DELETE` foi executado.

## Resultado e parada

```text
STATUS=CREDENTIALS_VISIBLE_TO_RUNTIME

SHOPEE_AFFILIATE_APP_ID runtime=PRESENT
SHOPEE_AFFILIATE_APP_SECRET runtime=PRESENT
API_BASE_URL opcional=ABSENT; endpoint padrão BR ativo
/health=HTTP 200
SHA=44a31d687ae06d2398e6651ad1009eacfbeefbd
BASELINE=INALTERADO
CHAMADA_SHOPEE=NAO_EXECUTADA
```

A Fase 3B está encerrada. A chamada real à Shopee continua pendente de autorização específica. Não iniciar Fase 4, não conectar ao N13 e não iniciar N17.
