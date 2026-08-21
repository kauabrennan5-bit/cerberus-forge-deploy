# INFRA-03 — Fase 13 — Auditoria de cobertura comercial Shopee

**PROOF_RUN_ID:** `INFRA03_PHASE13_SOURCE_COVERAGE_20260820T0408Z`

**STATUS:** `BLOCKED — SOURCE COVERAGE`

A auditoria foi concluída e a menor alteração local autorizada foi implementada, mas a fase não pode ser declarada como cobertura comercial suficiente para o N14. A API real não foi chamada nesta fase, conforme o escopo. Não houve execução de N13, N14, N15, N16 ou N17+.

## Escopo e limites

A fase ficou limitada à auditoria do cliente oficial Shopee, da operação GraphQL existente `productOfferV2`, do provider oficial, do Evidence Bridge e dos contratos/tests locais. Também foi autorizada apenas a preservação de um campo já suportado pelo contrato local, se a evidência justificasse a mudança.

Não foram criadas operações novas, não houve introspection, scraping, proxy, browser, bypass, alteração de credenciais, migration, escrita em Supabase, chamada real à Shopee, geração de link, publicação, alteração de N13/N14, alteração de N15/N16/N17+, Telegram, scheduler, job_queue ou catálogo canônico.

## Snapshot

O SHA base/servido permaneceu `7fd48567753bec51186db1ceb423fbc726931c51`. O endpoint `/health` respondeu HTTP 200. O build confirmou a projeção canônica com 13 produtos.

O working tree já continha artefatos não rastreados de fases anteriores. A Fase 13 adicionou somente duas modificações rastreadas: o selection set do cliente Shopee e a asserção de contrato correspondente no teste D1. Não houve commit, push ou deploy.

## Auditoria da cadeia

A fonte oficial utilizada confirmou que as APIs da Open Platform usam autenticação SHA-256 e timestamp, mas não confirmou o selection set específico de `productOfferV2` da API de Afiliados BR usada pelo projeto [1]. A documentação brasileira localizada para Afiliados declara-se não oficial e, por isso, não foi tratada como autoridade contratual [2].

O cliente oficial local já solicitava `itemId`, `shopId`, `productName`, `productLink` e `offerLink`. O parser/normalizador local já aceitava `obj.price` e convertia esse valor para `priceMinorUnits`. O Evidence Bridge já promovia `priceMinorUnits` para o campo de evidência `price` quando o cliente fornecesse um valor observado. Os testes locais já cobriam a preservação de preço observado e a manutenção de campos ausentes como UNKNOWN.

A lacuna concreta era anterior ao Bridge: o selection set GraphQL não solicitava `price`. Portanto, `price` podia ser suportado pelo contrato interno, mas não poderia ser observado enquanto permanecesse fora da query.

## Matriz de cobertura

`availability`: `UNKNOWN_CONTRACT`. O cliente e o Bridge atuais não modelam disponibilidade/estoque nessa operação. Nenhum valor foi inferido.

`commission`: `UNKNOWN_CONTRACT`. Há referências secundárias a campos de comissão, mas elas não são autoridade oficial para o contrato de produção. Comissão não foi calculada nem adicionada.

`competition`: `NOT_AVAILABLE`. Não existe mecanismo oficial confirmado nesta fronteira para comparação competitiva.

`market`: `NOT_AVAILABLE`. O marketplace Shopee é contexto da fonte, não uma dimensão comercial de mercado/competição observada pela operação.

`price`: `AVAILABLE_IN_LOCAL_CONTRACT; NOT_YET_VERIFIED_IN_REAL_PHASE_13`. O parser, o contrato interno, o Bridge e os fixtures locais suportam o campo. A prova real anterior não o observou porque a query não o solicitava. A fase atual não pode afirmar que a API real retornará o campo porque a chamada externa estava proibida.

`seller`: `UNKNOWN_CONTRACT`. `shopId` é identidade da loja e não foi convertido em nome ou entidade seller. O Bridge não possui campo de seller.

## Campo descartado antes do Bridge

O único campo identificado como potencialmente preservável sem novo contrato foi `price`. Ele não era descartado pelo Bridge; era omitido do selection set antes de chegar ao parser. Os demais campos comerciais permanecem UNKNOWN ou NOT_AVAILABLE porque não estão modelados localmente, não foram confirmados pela fonte oficial consultada ou exigiriam uma nova operação/alteração de fronteira.

## Alteração mínima aplicada

Foi acrescentado apenas `price` ao selection set da query existente em:

`server/commercial/affiliate/shopeeApiClient.ts`

A alteração não muda argumentos, identidade, assinatura, endpoint, parser, normalizador, digest, provenance, adapter, persistência, N13 ou N14. Quando a resposta não trouxer preço válido, o comportamento fail-closed permanece: `priceMinorUnits=null` e a evidência continua UNKNOWN/COLLECTION_FAILED conforme o estado da coleta.

O teste existente foi tornado regressível em:

`tests/shopeeDirectedResolutionD1.test.ts`

A asserção agora confirma que a query dirigida inclui `price`, preservando os testes de match exato, link oficial, assinatura e falha fechada.

## Decisão arquitetural

A camada responsável pela lacuna é o cliente oficial Shopee, especificamente o selection set da operação já existente. A mudança preserva a separação entre fonte externa, evidência N3, curadoria N13 e Commercial Brain N14.

Não houve alteração de contrato persistido ou schema. Não houve mudança de autoridade. Não foi criada segunda fonte de verdade. O N14 continua sem consumir automaticamente `candidate_evidence` nesta fase; portanto, nenhum score, dimensão ou recomendação foi fabricado a partir da simples adição do campo à query.

A alteração é reversível por remoção de uma palavra no selection set e de sua asserção de teste. O risco residual é a aceitação efetiva do campo pelo endpoint real, que deve ser verificada em futura prova controlada autorizada. Essa verificação não foi executada agora.

## Gates

`SHOPEE_D1`: PASS, 13/13 testes.

`SHOPEE_BRIDGE_N3` e `researchService`: PASS, 19/19 testes.

`npm test`: PASS, 1358/1358 testes.

`npx tsc --noEmit`: PASS.

`npm run build`: PASS. O build gerou a projeção com 13 produtos obtidos do backend.

`git diff --check`: PASS.

`/health`: PASS, HTTP 200.

A varredura heurística ampla sinalizou um único arquivo de fixture de teste já existente, `tests/jobQueueRepository.test.ts`, nas linhas 365 e 494. O alerta foi classificado como padrão de fixture, sem exposição de valor no relatório. A varredura material excluindo somente esse fixture conhecido não encontrou outros caminhos sinalizados: `SECRET_SCAN_MATERIAL=PASS`. Nenhum arquivo foi alterado para mascarar ou remover o fixture.

Durante os testes locais, apareceram avisos pré-existentes de ambiente sem `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` e sem chave Gemini. Os testes passaram e nenhum desses avisos foi convertido em sucesso de integração real.

## Baseline Supabase

A consulta final foi somente leitura. O baseline permaneceu:

`products=13`

`candidates=0`

`candidate_evidence=0`

`candidate_assessment=0`

`affiliate_links=0`

`job_queue=0`

`publication_executions=0`

`commercial_cycles=0`

Não houve INSERT, UPDATE ou DELETE.

## N13–N17+

N13 não foi executado nesta fase.

N14 não foi executado nesta fase.

N15, N16 e N17+ não foram executados.

Nenhuma publicação, aquisição real, geração de short link, Telegram, scheduler, job_queue ou agente foi acionado.

## Conclusão

A auditoria identificou uma melhoria local mínima e segura para solicitar `price` na operação já existente. Essa melhoria foi implementada e validada localmente, mas não prova que o endpoint real retornará o campo nem resolve as dimensões comerciais necessárias para um score confiável do N14.

Consequentemente, o resultado correto é:

`STATUS=BLOCKED — SOURCE COVERAGE`

`LOCAL_CHANGE=READY FOR REVIEW`

`REAL_API_CALL=SKIPPED — ESCOPO DA FASE`

`N15_PLUS=NOT_EXECUTED`

Não fazer commit, push, deploy ou iniciar N15 sem autorização explícita.

## Rollback

O rollback local consiste em remover `price` do selection set em `server/commercial/affiliate/shopeeApiClient.ts` e restaurar a asserção anterior em `tests/shopeeDirectedResolutionD1.test.ts`. Nenhum dado de produção precisa ser revertido.

## Referências

[1]: https://open.shopee.com/developer-guide/16 "Shopee Open Platform Developer Guide — API calls"
[2]: https://www.affiliateshopee.com.br/documentacao "Shopee Affiliate API documentation playground — fonte declaradamente não oficial"
