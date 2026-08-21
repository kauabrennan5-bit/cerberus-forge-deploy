# N17/N14 — Fase 11 — Resolução de Cobertura Comercial Shopee

```text
PROOF_RUN_ID=N17_PHASE11_COMMERCIAL_COVERAGE_20260820
STATUS=BLOCKED — CONTRACT UNSPECIFIED
DECISION=SKIPPED — DEPENDÊNCIA EXTERNA / CONTRATO AFFILIATE NÃO SUFICIENTEMENTE ESPECIFICADO
N14=INSUFFICIENT
N15=NOT_REACHED_FOR_NEW_APPROVAL
N17=NOT_EXECUTED
N18+=NOT_EXECUTED
READY_FOR_N18=NO
```

## 1. Escopo e regra de decisão

A Fase 11 auditou exclusivamente a cobertura comercial necessária para que o N14 avalie oportunidades Shopee com evidência contratualmente verificável. Não foram alterados thresholds, score, policy do N15, TTL, N16, N17, N8, N6, catálogo, scheduler, Telegram, agentes ou banco de dados. Nenhum preço, comissão, disponibilidade, mercado, competição, score, `KNOWN` ou aprovação foi fabricado.

A conclusão é fail-closed: a API Affiliate BR `productOfferV2` possui observações reais de identidade e de alguns campos de oferta, mas a documentação pública oficial acessível nesta auditoria não especifica de forma suficiente a semântica comercial necessária para promover as dimensões ao N14. Uma observação de resposta não substitui contrato de unidade, moeda, escala ou semântica.

## 2. Provider oficial Shopee

O registro foi consultado em modo somente leitura no Supabase. O provider existe sem duplicata e apresentou a seguinte configuração não sensível:

```text
provider_id=affprv-shopee
provider_code=shopee
marketplace=Shopee
status=ACTIVE
provenance=admin:manual
resolution_method=MANUAL
```

O provider ativo comprova a disponibilidade do registro de integração, mas não constitui evidência comercial nem autoridade para promover campos desconhecidos.

## 3. Auditoria do cliente e do Evidence Bridge

O cliente local usa a operação oficial GraphQL Affiliate `productOfferV2`. O parser e o adapter preservam a identidade retornada, o título quando observado, a proveniência, o timestamp UTC e o `response_digest`; valores ausentes permanecem `UNKNOWN`. O parser não recebeu nenhuma alteração nesta fase.

A cobertura comercial efetiva continua limitada pelo contrato. Em particular, o campo `price` foi observado anteriormente como `string`, mas não existe no contrato local ou na documentação Affiliate pública acessível uma regra segura para moeda, unidade, escala decimal, separadores ou arredondamento. Portanto ele continua `UNKNOWN` e não pode ser convertido para `priceMinorUnits`.

## 4. Matriz de cobertura contratual

```text
price:
  observação real: PRESENT como STRING em productOfferV2.
  contrato Affiliate oficial suficiente: NÃO COMPROVADO.
  unidade/moeda/escala: NÃO ESPECIFICADAS.
  suporte atual no parser/bridge: preservado como UNKNOWN quando não normalizável.
  consumo seguro pelo N14: NÃO.
  estado: BLOCKED — CONTRACT UNSPECIFIED.

availability:
  observação real utilizável para productOfferV2: NÃO COMPROVADA.
  contrato Affiliate oficial suficiente: NÃO COMPROVADO.
  semântica verificável: NÃO.
  consumo seguro pelo N14: NÃO.
  estado: NOT AVAILABLE / BLOCKED — CONTRACT UNSPECIFIED.

commission:
  contrato específico de productOfferV2: NÃO COMPROVADO.
  tipo, unidade, percentual, domínio e transformação: NÃO COMPROVADOS.
  consumo seguro pelo N14: NÃO.
  estado: NOT AVAILABLE / BLOCKED — CONTRACT UNSPECIFIED.

competition:
  campo ou proxy oficialmente definido para productOfferV2: NÃO COMPROVADO.
  domínio, unidade e semântica: NÃO COMPROVADOS.
  consumo seguro pelo N14: NÃO.
  estado: NOT AVAILABLE / BLOCKED — CONTRACT UNSPECIFIED.

market:
  campo ou proxy oficialmente definido para productOfferV2: NÃO COMPROVADO.
  domínio, unidade e semântica: NÃO COMPROVADOS.
  consumo seguro pelo N14: NÃO.
  estado: NOT AVAILABLE / BLOCKED — CONTRACT UNSPECIFIED.

identity/title:
  item_id, shop_id e title podem ser preservados somente quando realmente retornados e com match de identidade.
  esses campos não substituem dimensões comerciais e não sustentam N14=SUFFICIENT isoladamente.
```

## 5. Fontes oficiais consultadas

A página oficial Open Platform consultada descreve a Open API v2 e seus domínios de Seller/Product, não o contrato GraphQL Affiliate `productOfferV2` [1]. A página pública oficial do programa de Afiliados Shopee BR apresenta o programa e encaminha ao Centro de Educação, mas não expôs nesta sessão um schema público verificável de `productOfferV2` [2]. O Centro de Educação exigiu autenticação e, por isso, não foi tratado como contrato acessível sem takeover do usuário.

A operação oficial `v2.product.get_item_base_info` foi examinada como menor fonte alternativa documentada. Sua resposta documenta `price_info[].currency`, `price_info[].original_price`, `price_info[].current_price` e campos de estoque como `stock_info_v2.summary_info.total_available_stock` [3]. Contudo, essa é uma operação Seller/Open API v2 distinta da Affiliate API, exige autorização da loja/conta correspondente e não constitui uma fonte pública geral para produtos Shopee de terceiros. Sem credencial oficial de vendedor, escopo compatível e prova de que a conta autorizada é a proprietária dos itens avaliados, não é seguro usar esses campos como sinais de oportunidades afiliadas.

Fontes não oficiais, documentação de terceiros, exemplos de comunidade, scraping, browser, introspection e inferência por preço visual foram rejeitados como autoridade contratual.

## 6. Menor fonte alternativa verificável

A menor fonte alternativa identificada para `price` e disponibilidade é a Seller/Open API v2 `v2.product.get_item_base_info`, mas ela somente poderia ser considerada em uma fase própria após autorização explícita, credencial OAuth legítima da loja correspondente, definição do escopo de acesso e uma regra de identidade que prove que o item consultado é o mesmo produto. Mesmo essa fonte não resolve `commission`, `competition` ou `market`.

O adapter Mercado Livre que permanece no working tree não foi utilizado. O relatório INFRA-02 registra que ele não possui prova real de credencial, não está conectado ao N3/N13 e requer uma fase própria [4]. Além disso, sinais de um marketplace diferente não podem ser transferidos para uma oportunidade Shopee sem uma identidade cross-market formalmente comprovada; tal identidade não existe nesta fase.

## 7. Alterações, testes e publicação

Nenhum adapter, normalizador, contrato, selection set, Evidence Bridge, N13, N14, N15, N16, N17 ou configuração foi alterado nesta fase. Consequentemente, não foram adicionados testes funcionais de um campo que permanece sem contrato verificável. Os arquivos não relacionados já presentes no working tree foram preservados e não foram commitados, enviados ou publicados.

```text
HEAD_LOCAL=cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe
RENDER_HEALTH=HTTP 200
RENDER_STATUS=ok
RENDER_VERSION=cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe
PUBLICAÇÃO_NOVA=NÃO
COMMIT_NOVO=NÃO
PUSH_NOVO=NÃO
DEPLOY_NOVO=NÃO
```

Gates executados:

```text
npm test=PASS — 1407/1407
npx tsc --noEmit=PASS
npm run build=PASS
 git diff --check=PASS
secret scan=REVIEW — 1 alerta em fixture local não produtiva do adapter Mercado Livre; nenhum valor foi exposto e nenhum deploy foi realizado
```

O alerta do secret scan está localizado em `tests/mercadoLivreOfficialAdapter.test.ts`, em uma constante de fixture explicitamente marcada como não produtiva. Ele não é uma credencial de runtime, mas permanece como `REVIEW` para não ser promovido artificialmente a `PASS`.

## 8. Banco e efeitos colaterais

A consulta Supabase foi somente leitura. O baseline observado após a auditoria foi:

```text
products=14
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

Não houve chamada de aquisição Shopee, `generateShortLink`, persistência de candidate/evidence/assessment, publicação, replay, conflito, resolução N16, scheduler, Telegram ou execução N18+ nesta fase.

## 9. Decisão final e próximo passo mínimo

```text
N14=INSUFFICIENT
N15=BLOCKED / nenhuma autorização APPROVED criada
N17=NOT_OPERATIONAL
READY_FOR_N18=NO
```

O bloqueio remanescente é externo ao código: a Affiliate API BR `productOfferV2` continua sem contrato público verificável suficiente para `price`, `availability`, `commission`, `competition` e `market`. Não é permitido contornar o bloqueio com score artificial, conversão presumida, fallback não autorizado, dados Seller de outra conta, Mercado Livre, scraping ou relaxamento de policy.

O próximo passo mínimo é obter da Shopee uma especificação oficial da Affiliate API BR que defina as dimensões necessárias, ou autorizar uma integração separada com uma fonte alternativa que tenha acesso legítimo ao mesmo item e uma identidade comprovável. Essa integração exigirá nova fase, revisão arquitetural e autorização explícita. Não iniciar N18.

## Referências

[1] [Shopee Open Platform — Developer Guide / Open API v2](https://open.shopee.com/developer-guide/16)

[2] [Shopee Afiliados Brasil — página oficial do programa](https://affiliate.shopee.com.br/)

[3] [Shopee Open Platform — v2.product.get_item_base_info](https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1)

[4] [Cerberus — INFRA-02 Fase 3, relatório local](infra02_phase3_report.md)

---

Autor: Manus AI
Fase: N17/N14 — Fase 11
Data da prova: 2026-08-20
