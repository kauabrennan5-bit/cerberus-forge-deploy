# INFRA-03 — Fase 17 — Observabilidade Sanitizada do Price

## Status

**STATUS=BLOCKED — SOURCE COVERAGE**

**PROOF_RUN_ID:** `INFRA03_PHASE17_PRICE_SHAPE_PROBE_20260820T0504Z`

A fase executou exatamente uma chamada real, read-only, por meio do `ShopeeApiClient.lookupProduct()` existente. A probe temporária foi removida após a chamada. Nenhuma operação N3/research, N13, N14, N15, N16, N17+, aquisição, geração de short link ou publicação foi executada.

## Escopo e preflight

O item autorizado foi `item_id=23794344926` e `shop_id=1530442944`. A operação usada foi exclusivamente `productOfferV2` por meio do método existente `lookupProduct()`. Não foi criada nova operação GraphQL, não foi usada introspection, scraping, proxy, browser, cookie, User-Agent spoofing ou bypass.

As credenciais necessárias estavam presentes no runtime Render. Seus valores não foram lidos para o relatório, exibidos ou persistidos. O SHA que serviu a probe temporária foi `2b8d7cb504df23dbd30bf984304e5c350b2c368b`. O SHA final, após remoção da probe, é `40ae71568f2b5f9e484541818912dd18d213cb1c`.

## Chamada real única

A chamada foi executada em `2026-08-20T05:04:07.635Z`. O endpoint respondeu HTTP 200 e o cliente retornou `client_status=found`.

A identidade foi confirmada por match exato: o `item_id` retornado coincidiu com `23794344926` e o `shop_id` retornado coincidiu com `1530442944`.

Nenhum valor de preço foi registrado. Somente os metadados abaixo foram preservados:

```text
http_status=200
client_status=found
requested_item_id=23794344926
returned_item_id=23794344926
requested_shop_id=1530442944
returned_shop_id=1530442944
identity_confirmed=true
price_present=true
price_type=string
price_keys=[]
price_is_finite=NOT_APPLICABLE
classification=PRICE_SHAPE_CONFIRMED_NON_NUMERIC
observed_at=2026-08-20T05:04:07.635Z
response_digest=4a74287c017d48af2f36ae323c70adc4af18b2ad4dcd4202864fda02e1e4aab2
error_kind=null
```

A classificação é `PRICE_SHAPE_CONFIRMED_NON_NUMERIC`. O endpoint aceitou o selection set contendo `price`, e o cliente conseguiu observar que o campo existe no shape carregado, mas o tipo observado foi `string`. O valor não foi exposto, não foi convertido, não foi promovido para `KNOWN` e não foi usado para alterar o parser ou o Evidence Bridge.

## Proveniência

A observação veio da chamada oficial `productOfferV2`, realizada pelo cliente oficial já existente, em modo administrativo temporário e read-only. A identidade foi validada contra a tupla autorizada `(shop_id, item_id)`. O digest é calculado somente sobre metadados sanitizados; não inclui credenciais, Authorization, Signature, headers, corpo bruto ou o valor de `price`.

## Decisão

A Fase 17 resolve a incerteza do shape: **o campo `price` é retornado como string no payload observado**. A fase não autoriza automaticamente uma mudança de parser. O parser atual aceita somente `obj.price` numérico top-level; qualquer futura alteração para aceitar string deverá ser tratada em uma fase separada, com decisão explícita sobre unidade, precisão, locale, escala monetária, coerção segura e regressões.

Não houve alteração no parser, nos contratos, no Evidence Bridge, no N13, no N14 ou em qualquer fluxo de publicação. O resultado não deve ser interpretado como preço comercial validado nem como autorização para scoring ou publicação.

## Cleanup

A rota e os testes da probe foram removidos após a única chamada. O endpoint temporário respondeu HTTP 404 no SHA final. O cleanup não fez INSERT, UPDATE ou DELETE em banco.

O commit final de cleanup é `40ae71568f2b5f9e484541818912dd18d213cb1c`. O working tree não possui alterações rastreadas pendentes. Os artefatos documentais não rastreados de fases anteriores não foram incluídos no commit.

## Baseline somente leitura

O baseline pós-cleanup foi confirmado por consulta somente leitura:

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

O baseline pré-probe da Fase 17 foi registrado no preflight com os mesmos valores; nenhuma alteração de banco ocorreu entre antes e depois.

## Gates

```text
focused_probe=PASS
npm_test=PASS
npm_test_count=1358/1358
tsc_no_emit=PASS
build=PASS
git_diff_check=PASS
secret_scan_material=PASS
health_final_primary=HTTP 200
health_final_alternate=HTTP 200
probe_removed_final=HTTP 404
```

A varredura sanitizada excluiu somente o fixture de teste conhecido previamente classificado. Nenhum segredo foi impresso ou anexado.

## Escopo não executado

```text
N3/research=NOT_EXECUTED
N13=NOT_EXECUTED
N14=NOT_EXECUTED
N15=NOT_EXECUTED
N16=NOT_EXECUTED
N17_PLUS=NOT_EXECUTED
generateShortLink=NOT_EXECUTED
acquisition=NOT_EXECUTED
publication=NOT_EXECUTED
```

## Decisão final

**Fase 17 encerrada como `BLOCKED — SOURCE COVERAGE`, com `PRICE_SHAPE_CONFIRMED_NON_NUMERIC`.** A observação real é suficiente para demonstrar o shape string, mas não autoriza correção automática do parser. Não iniciar N13+ nem uma nova chamada real sem autorização explícita.
