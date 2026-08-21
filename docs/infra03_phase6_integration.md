# INFRA-03 — Fase 6 — Integração Shopee no N3 Research

## Status

**READY FOR REVIEW — alteração local validada.**

A integração do bridge oficial Shopee foi conectada localmente ao fluxo `N3 startResearch → candidate_evidence`. Não houve commit, push, deploy, chamada real à Shopee, alteração de N13–N16, alteração de catálogo, publicação ou inicialização de N17+.

O SHA de referência do working tree antes da consolidação permanece `0ba60f2ad925109159f0daa924d8b9ca50d1f928`. As alterações continuam deliberadamente não commitadas.

## Escopo executado

O escopo autorizado foi limitado a `server/commercial/discovery/research.ts` e `tests/researchService.test.ts`. O arquivo `research.ts` recebeu uma ramificação exclusiva para `mp === "SHOPEE"`, posicionada depois do registro da evidência `RESEARCH_SESSION` e antes do caminho existente de coleta por SCRAPE.

O caminho Mercado Livre permaneceu semanticamente inalterado. O branch existente que chama `fetchListingPage`, registra falha de página como `COLLECTION_FAILED` com `source_type=scrape` e persiste evidência de página continua sendo executado para `MERCADOLIVRE`.

## Implementação

A entrada `ResearchInput` agora aceita `shopeeClient` opcional para injeção controlada em testes. Em produção, quando a injeção não é fornecida, o cliente é criado pela factory oficial já existente, usando `SHOPEE_APP_ID` com fallback para `SHOPEE_AFFILIATE_APP_ID` e `SHOPEE_APP_SECRET` com fallback para `SHOPEE_AFFILIATE_APP_SECRET`. A URL base continua opcional e é encaminhada apenas pela configuração oficial existente.

A identidade é resolvida de forma fail-closed. O código aceita um `external_listing_id` numérico, o formato composto já produzido pelo N2 (`shopee-shop_id-item_id`), `metadata.shop_id` quando numérico, ou a extração estrita do `source_url` por `extractShopeeIdentifiers`. Sem `item_id`, nenhuma chamada ao cliente é feita e a pesquisa registra a falha controlada.

No caminho de sucesso, o serviço chama `createOfficialShopeeEvidenceAdapter(client).collect(...)` com `candidate_id`, `research_id`, `item_id`, `shop_id` e `source_url`. Cada campo retornado é persistido individualmente em `candidate_evidence` com `kind=FIELD`, `source_type=api`, `collection_method=API`, estado e qualidade fornecidos pelo bridge, digest retornado pelo bridge e metadata de proveniência da operação `productOfferV2`.

Nos estados `COLLECTION_FAILED` e `BLOCKED`, cada campo solicitado recebe uma evidência `COLLECTION_FAILED`, com `source_type=api`, `collection_method=API`, `field_value={value:null,unknown:true}`, `fetch_failed=true` e motivo operacional sanitizado. O resultado permanece distinguível por `fetch_failed` e `fetch_reason`; nenhum valor desconhecido é promovido a fato.

A detecção de contradições existente do N3 também é aplicada às evidências Shopee bem-sucedidas. Evidências anteriores não são apagadas; quando aplicável, a nova evidência recebe estado `CONTRADICTED` e referência às evidências anteriores.

## Testes adicionados

A suíte `tests/researchService.test.ts` recebeu quatro cenários específicos:

1. O caminho `SUCCESS` verifica uma chamada única ao cliente oficial injetado, a resolução exata de `shopId` e `itemId`, e a persistência com `source_type=api` e `collection_method=API`.
2. O caminho `COLLECTION_FAILED` verifica que o erro do cliente resulta em oito evidências `COLLECTION_FAILED`, sem valores confirmados.
3. O caminho `BLOCKED` para `not_found` verifica o fail-closed e a permanência de todos os campos como desconhecidos.
4. A ausência de `item_id` verifica que o cliente não é chamado e que a tentativa é registrada como bloqueada por identidade ausente.

Os testes existentes do Mercado Livre permaneceram presentes e passaram sem alteração de expectativa.

## Gates executados

`npm test` passou com **1354/1354 testes**, incluindo **10/10 testes** da suíte focal `researchService.test.ts`.

`npx tsc --noEmit` passou sem erros.

`npm run build` passou. O build confirmou a projeção local de 13 produtos e concluiu a compilação do frontend e do bundle do servidor. O aviso de tamanho de chunk do Vite não foi erro de build.

`git diff --check` passou sem erros de whitespace.

O secret scan dos valores adicionados passou sem detectar App ID, App Secret, token, senha, header Authorization ou credencial literal. O diff contém somente nomes de variáveis de ambiente e referências não sensíveis ao contrato oficial.

## Baseline Supabase pós-gates

A consulta foi somente leitura e preservou o baseline esperado:

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

Não foram executados `INSERT`, `UPDATE`, `DELETE` ou `TRUNCATE` no Supabase durante esta fase.

## Estado de produção e governança

Nenhuma chamada real à Shopee foi feita nesta Fase 6; os cenários utilizaram cliente injetado nos testes locais. Não houve scraping alternativo, bypass, proxy, fingerprinting, cookie spoofing ou manipulação de endpoint.

Nenhum resultado N13 foi fabricado ou promovido. N14, N15 e N16 não foram executados. Não há aprovação, score, digest de publicação, proveniência operacional ou artefato de publicação produzido por esta fase. N17+ continua bloqueado por ausência de autorização específica.

O working tree contém apenas duas alterações rastreadas da Fase 6:

```text
server/commercial/discovery/research.ts
tests/researchService.test.ts
```

Existem outros arquivos não rastreados no repositório, provenientes de fases anteriores, mas eles não foram modificados por esta integração e não fazem parte do diff rastreado da Fase 6.

## Próximo passo autorizado

A implementação está **READY FOR REVIEW**. O próximo passo somente poderá ser commit, push e deploy após autorização explícita. Até essa autorização, o patch deve permanecer local e não consolidado.

## Conclusão

A pré-condição técnica local para substituir o caminho Shopee bloqueado por SCRAPE pelo bridge oficial API → `candidate_evidence` foi atendida e validada. A alteração permanece estritamente dentro do N3, mantém o caminho Mercado Livre existente e conserva o comportamento fail-closed para identidade ausente, bloqueio e falha de coleta.

**Resultado final: READY FOR REVIEW — NÃO CONSOLIDADO — NÃO DEPLOYADO.**

## Referências internas

- `server/commercial/discovery/research.ts`
- `server/commercial/sources/shopee/adapter.ts`
- `server/commercial/sources/shopee/contracts.ts`
- `server/commercial/affiliate/shopeeApiClient.ts`
- `server/commercial/affiliate/shopeeClientContracts.ts`
- `tests/researchService.test.ts`
- `docs/infra03_phase5_bridge_deploy.md`
