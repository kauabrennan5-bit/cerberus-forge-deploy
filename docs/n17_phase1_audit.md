# N17 — FASE 1 — AUDITORIA E CONTRATO DE AQUISIÇÃO

## 1. STATUS

**READY FOR PHASE 2** — auditoria documental e local concluída. Nenhuma aquisição real, geração de short link, escrita de banco, alteração funcional, commit, push ou deploy foi executado.

A classificação READY FOR PHASE 2 significa que o contrato futuro pode ser implementado em fase posterior mediante autorização específica. Não significa que o N17 runtime já esteja implementado ou operacional.

## 2. PROOF_RUN_ID

`INFRA03_N17_PHASE1_AUDIT_20260820T064539Z`

## 3. SHA ANALISADO

`40ae71568f2b5f9e484541818912dd18d213cb1c`

Branch analisada: `main`.

O working tree já possuía alterações e relatórios não consolidados anteriores à Fase 1. Nenhuma dessas alterações foi modificada nesta auditoria. A alteração funcional conhecida é o teste fail-closed da Fase 18 em `tests/shopeeAffiliateIntegration.test.ts`; ela não pertence ao N17.

## 4. ARQUITETURA ATUAL DO N17/N8

O N17 ainda não possui um executor runtime próprio. A autoridade de aquisição existente é o serviço N8 `server/commercial/affiliate/acquisitionService.ts`, que recebe um provider ativo, uma referência de produto, uma URL pública opcional e uma fonte oficial injetada.

O N8 é deliberadamente separado da persistência. O serviço de aquisição não grava no banco. O registro atual de links pertence ao repositório N6 `affiliateRepository.ts`, por meio de `persistLink`.

O adapter oficial Shopee em `shopeeAffiliateProvider.ts` realiza resolução direcionada via `productOfferV2(itemId, shopId)` e, quando a oferta não é encontrada, pode usar somente o fallback oficial `generateShortLink` com a URL pública específica. Não há derivação heurística de URL.

A fronteira arquitetural recomendada é:

```text
N15 autorização ACQUIRE_AFFILIATE
    -> N17 orquestra aquisição e persistência governadas
       -> N8 executa a aquisição oficial por provider
          -> N6/repositório persiste o registro após validação contratual
             -> N18 consome somente ACQUIRED/ALREADY_ACQUIRED comprovado
```

N17 não deve substituir N8, duplicar o provider ou implementar transporte Shopee próprio. N17 deve orquestrar N8 e a persistência governada que vier a ser autorizada.

## 5. FUNÇÕES E ADAPTERS ENCONTRADOS

Foram encontrados os seguintes pontos relevantes:

- `acquisitionService.ts`: serviço N8 `acquireAffiliateLink`, com estados fail-closed e sem persistência.
- `acquisitionContract.ts`: contrato conceitual local, explicitamente não conectado ao runtime, com `AcquireResult`, `ProductReference`, `ProductIdentity` e estados de aquisição.
- `shopeeAffiliateProvider.ts`: adapter oficial Shopee, com `productOfferV2`, fallback oficial `generateShortLink`, retry fechado para erros transitórios e validação de identidade.
- `shopeeApiClient.ts`: cliente oficial GraphQL Shopee, responsável pelo transporte e parsing da resposta.
- `affiliateRepository.ts`: persistência N6 de providers e affiliate links, com validação estrutural e idempotência por digest.
- `affiliateLinkResolver.ts`: resolução N7 de links já registrados; fornece dados ao N16 e não autoriza publicação.
- `affiliateRoutes.ts`: rotas administrativas existentes para providers, aquisição e registro de links.
- `publicationExecutor.ts`: executor N16; resolve links registrados e publica, mas não chama N8 nem providers.
- `n16Service.ts`: serviço de decisão/execução N16; não é autoridade de aquisição.
- `governance/engine.ts`: regra formal de governança, incluindo o action `ACQUIRE_AFFILIATE`.
- `commercialCycleService.ts`: orquestrador do ciclo comercial; não constitui um executor N17 independente.

## 6. PROVIDERS ENCONTRADOS

### Shopee

Existe adapter oficial em `shopeeAffiliateProvider.ts`. A entrada precisa conter identificadores válidos, especialmente `itemId` e `shopId` para resolução direcionada. A saída oficial pode conter `affiliateUrl`, `listingId`, `sellerId`, `titleSnapshot` e resposta para auditoria.

O fluxo usa `productOfferV2(itemId, shopId)`. Se houver `link_acquired`, a URL oficial é preservada exatamente. Se a fonte reconhecer o produto mas não fornecer offer link, o adapter classifica como não elegível e não promove URL pública. Se o produto não estiver na lista de ofertas, o fallback permitido é a mutation oficial `generateShortLink` para a URL pública específica.

A autenticação depende das credenciais oficiais configuradas no runtime. Falta de credencial, erro de autenticação, timeout, rate limit, resposta inválida e erro permanente são tratados de forma fail-closed.

### Mercado Livre

O código atual não possui aquisição programática oficial documentada para Mercado Livre. O caminho suportado permanece manual assistido, com URL fornecida pelo operador e validação estrutural. A aquisição API é `NOT_SUPPORTED` para esse marketplace no N8 atual.

Nenhum provider ou API adicional foi inventado.

## 7. ESTADO ATUAL DE `affiliate_links`

O último baseline confirmado antes desta auditoria registrava `affiliate_links=0`. A Fase 1 não realizou consulta de produção, inserção, atualização, migration ou limpeza.

O schema atual e o repositório permitem:

- estado inicial `DRAFT`;
- `validation_state=UNVALIDATED`;
- digest determinístico e único;
- replay idêntico retornando `identical_duplicate`;
- preservação histórica quando URL ou destino muda;
- vínculo XOR entre `candidate_id` e `product_id`;
- provider ativo e marketplace compatível;
- provenance efetiva fechada em `admin:manual`;
- método de resolução efetivo limitado a `MANUAL`.

Esse contrato não representa adequadamente, sem mudança autorizada, uma aquisição API executada pelo N8.

## 8. CONTRATO ATUAL DE ENTRADA

### Entrada efetiva do N8

O `AcquireOptions` atual contém:

- `provider`: provider N6 de origem;
- `reference`: `ProductReference`;
- `operatorProvidedUrl`: URL manual opcional;
- `apiSource`: fonte oficial injetada opcional.

`ProductReference` contém `marketplace`, `productId` opcional, `candidateId` opcional e `publicUrl` obrigatória.

### Entrada oficial recomendada para o futuro N17

O N17 deve aceitar somente uma oportunidade governada, com:

- `candidate_id`: obrigatório para rastreabilidade do funil;
- `product_id`: obrigatório se o N17 for executado depois de N16 e o produto canônico já existir; não deve ser inventado;
- `marketplace/source`: obrigatório e derivado do candidato aprovado;
- identificador oficial da fonte, como `item_id` e `shop_id` na Shopee, obrigatório quando a plataforma exigir;
- `product_url`: obrigatório como referência pública, nunca como affiliate URL;
- `offer_url`: opcional e somente quando observado pela fonte oficial; não deve ser promovido automaticamente;
- referência da autorização N15 para `ACQUIRE_AFFILIATE`: obrigatória;
- `assessment_id` e vínculo de decisão: obrigatórios para provar a autorização anterior;
- provenance de entrada: obrigatória e herdada do registro governado;
- `idempotency_key`: obrigatória e determinística;
- contexto de tracking: opcional, somente se suportado oficialmente pelo provider e sem secrets.

O N17 deve rejeitar oportunidade sem autorização N15, identidade insuficiente, provider desconhecido, marketplace incompatível, URL pública ausente ou chave de idempotência ausente.

O schema atual de `affiliate_links` aceita candidato ou produto, mas não os dois simultaneamente. Isso é uma lacuna para a rastreabilidade completa candidate → product → acquisition e precisa ser resolvido por contrato/migration autorizada antes de exigir essa associação no runtime.

## 9. CONTRATO ATUAL DE SAÍDA

O N8 atual retorna `AcquireResult` com `SUCCESS`, `IDENTITY_UNCERTAIN`, `AUTH_REQUIRED`, `NOT_SUPPORTED`, `MANUAL_REQUIRED`, `PRODUCT_NOT_ELIGIBLE`, `PROVIDER_NOT_ACTIVE` ou `RESOLUTION_FAILED`.

O futuro N17 deve apresentar uma saída própria, estável e serializável, contendo no mínimo:

- `status`;
- `affiliate_link_id`, quando persistido;
- `affiliate_url`, somente se oficialmente obtida;
- `short_url`, somente se a operação oficial retornar uma short link distinguível;
- `provider_id` e marketplace;
- identidade do produto (`listing_id`, `seller_id`, título observado e URL canônica);
- método (`API` ou `MANUAL`, conforme autorizado);
- `acquisition_ref`;
- `observed_at`/`acquired_at` em UTC;
- `response_digest` sanitizado;
- provenance completa;
- `idempotency_key`;
- classificação de erro e motivo sanitizado.

O N17 não deve retornar `ACQUIRED` apenas porque uma URL possui formato válido. O estado confirmado exige link oficial, identidade comprovada, provider correto, elegibilidade e provenance rastreável.

## 10. ESTRATÉGIA ATUAL DE IDEMPOTÊNCIA

O N8 não possui uma transação de negócio N17 com chave de idempotência persistida. O serviço calcula `acquisitionRef` determinístico a partir de provider e affiliate URL quando a aquisição é bem-sucedida, mas isso ocorre depois da chamada oficial.

O N6 possui idempotência por digest de provider, destino e URL. Insert duplicado retorna `identical_duplicate`. Isso protege a persistência, mas não impede necessariamente uma nova chamada comercial antes do reprocessamento.

A estratégia futura do N17 deve:

1. exigir chave determinística antes da chamada;
2. procurar uma aquisição já comprovada pela chave e identidade;
3. retornar `ALREADY_ACQUIRED` em replay idêntico;
4. evitar nova chamada ao provider em replay já comprovado;
5. proteger concorrência por unique constraint/transação autorizada;
6. diferenciar replay idêntico de conflito de identidade ou URL.

## 11. ESTRATÉGIA ATUAL DE PROVENANCE

O N8 preserva `method`, `acquisitionRef`, `acquiredAt`, identidade, rationale de incerteza e resposta bruta em memória do resultado. O adapter Shopee preserva a URL oficial exatamente como retornada.

A persistência N6, entretanto, fixa `provenance=admin:manual`, força `resolution_method=MANUAL` e não possui um contrato efetivo para `admin:acquired` ou aquisição API. O `acquisitionContract.ts` declara `admin:acquired` como intenção conceitual, mas o próprio arquivo informa que não está conectado e que o banco atual rejeitaria essa provenance.

Faltam no contrato persistente atual:

- operação oficial que produziu o link;
- response digest seguro;
- identidade retornada pela fonte;
- timestamp de observação distinto de `created_at`;
- referência de aquisição ligada à autorização N15;
- método API distinguível de manual;
- vínculo simultâneo candidato/produto quando necessário.

Secrets, tokens, Authorization, assinatura e resposta bruta sensível não devem ser persistidos.

## 12. RELAÇÃO N15 → N16 → N17

N15 é a autoridade que deve autorizar a ação `ACQUIRE_AFFILIATE`. N17 não pode criar ou substituir essa autorização.

N16 é publicação. O executor N16 consulta o resolver N7 antes da escrita. Em modo exigente, ausência de link elegível retorna `AFFILIATE_MISSING`; em modo permissivo, `affiliateProvidedUrl ?? c.sourceUrl` permite continuar com `sourceUrl` e registra estado `UNKNOWN`.

N16 não chama N8, `acquireAffiliateLink` ou qualquer provider. Não existe aquisição oculta dentro da publicação.

A fronteira correta é:

```text
N15 = autorização da ação
N16 = publicação
N17 = aquisição/monetização
```

Existe uma decisão de sequenciamento a ser fechada antes da Fase 2: o fluxo nominal informa N16 → N17, mas o modo exigente do N16 pode requerer affiliate link antes da publicação. Esta auditoria não refatora N16. A Fase 2 deve definir se N17 opera pós-N16 sobre `product_id`, ou se a governança deve invocar aquisição antes da publicação sem quebrar o fluxo oficial.

## 13. RELAÇÃO N17 → N18

Não foi encontrada implementação runtime de N18. O contrato futuro deve permitir que N18 consuma apenas `ACQUIRED` ou `ALREADY_ACQUIRED` com identidade confirmada e affiliate URL oficial persistida.

`BLOCKED`, `FAILED`, `NOT_ELIGIBLE`, `IDENTITY_UNCERTAIN`, `AUTH_REQUIRED` e ausência de link não podem avançar para N18.

N17 não deve chamar, iniciar ou simular N18 nesta fase.

## 14. DUPLICAÇÕES ENCONTRADAS

Foram identificadas superfícies que precisam ser mantidas separadas, mas não devem ser tratadas como implementações duplicadas:

- aquisição N8 em `acquisitionService.ts`;
- adapter oficial Shopee em `shopeeAffiliateProvider.ts`;
- persistência N6 em `affiliateRepository.ts`;
- resolução de links N7 em `affiliateLinkResolver.ts`;
- publicação N16 em `publicationExecutor.ts`.

O risco real é a ausência de uma orquestração N17 explícita e a divergência entre o resultado de aquisição API e o contrato persistente N6. Não foi encontrado outro executor N17 autorizado.

## 15. GAPS ENCONTRADOS

- N17 runtime/orquestrador não está implementado.
- O contrato conceitual `acquisitionContract.ts` não está conectado.
- Persistência aceita somente `admin:manual` e `MANUAL`.
- Não há provenance persistente efetiva para aquisição API.
- Não há response digest de aquisição no contrato de saída persistido.
- Não há chave de idempotência de negócio consultada antes da chamada externa.
- `affiliate_links` usa candidato XOR produto, limitando rastreabilidade completa.
- Não há contrato estável de `short_url` separado de `affiliate_url`.
- Não há tabela/registro explícito de execução de aquisição N17.
- Não há executor N18.
- O modo permissivo do N16 pode publicar com `sourceUrl` quando não há link afiliado, se a policy não exigir link.
- A ordem N16 → N17 precisa ser reconciliada com o modo exigente de N16.
- Mercado Livre permanece manual-only.

## 16. RISCOS ENCONTRADOS

- Persistir aquisição API como `admin:manual` poderia falsificar provenance.
- Usar `sourceUrl`, `productLink` ou `offerLink` como affiliate URL poderia criar monetização não comprovada.
- Repetir chamadas sem idempotência prévia poderia gerar aquisições ou tracking duplicados.
- Publicar em modo permissivo antes de aquisição comprovada poderia resultar em produto não monetizável.
- Aceitar `IDENTITY_UNCERTAIN` como `ACQUIRED` violaria fail-closed.
- Alterar N16 para esconder aquisição violaria a fronteira arquitetural.
- Inferir provider ou identidade pela forma da URL criaria aquisição sem prova.
- Persistir `rawResponse` sem sanitização poderia expor secrets ou dados sensíveis.

## 17. ESTADOS RECOMENDADOS

O N17 deve expor estes estados fechados:

- `ACQUIRED`: link oficial obtido, identidade confirmada, elegibilidade comprovada e persistência concluída;
- `ALREADY_ACQUIRED`: aquisição idêntica já comprovada e retornada sem nova chamada comercial;
- `BLOCKED`: não foi possível comprovar identidade, provider, origem, elegibilidade, provenance ou autorização;
- `FAILED`: tentativa autorizada ocorreu e falhou tecnicamente, sem link elegível;
- `NOT_ELIGIBLE`: fonte oficial reconheceu a oportunidade, mas não a disponibilizou para aquisição.

`IDENTITY_UNCERTAIN` do N8 deve ser mapeado para `BLOCKED`, nunca para `ACQUIRED`.

## 18. FLUXO FUTURO RECOMENDADO

```text
1. Receber request N17 com candidate_id, autorização N15 e idempotency_key.
2. Revalidar que a ação é ACQUIRE_AFFILIATE e que a autorização N15 é legítima.
3. Carregar identidade observada do candidato/produto sem criar produto.
4. Determinar provider pelo marketplace e exigir provider ACTIVE.
5. Verificar replay por idempotency_key e identidade.
6. Se houver replay comprovado, retornar ALREADY_ACQUIRED.
7. Caso contrário, chamar N8; N8 chama somente o adapter oficial.
8. Rejeitar link sem identidade confirmada, host oficial, elegibilidade ou provenance.
9. Calcular response_digest sanitizado sem secrets.
10. Persistir o registro com método API/MANUAL correto, provenance autorizada e vínculo rastreável.
11. Se persistência retornar digest idêntico, retornar ALREADY_ACQUIRED.
12. Retornar ACQUIRED somente depois da persistência comprovada.
13. Encerrar sem chamar N18; o próximo estágio consumirá o contrato.
```

## 19. O QUE PODE SER REUTILIZADO

- `acquireAffiliateLink` como autoridade de aquisição técnica;
- `shopeeAffiliateProvider` e `shopeeApiClient` para API oficial;
- retry fechado para rate limit, timeout e rede;
- validação de identidade Shopee por `itemId`/`shopId`;
- fallback oficial `generateShortLink`;
- `affiliateRepository` como base de validação e digest, após contrato/migration autorizados;
- `affiliateLinkResolver` como consumidor downstream;
- regras fail-closed do N8;
- regras de autorização N15 para `ACQUIRE_AFFILIATE`;
- auditoria e metadados existentes do N16.

## 20. O QUE PRECISA SER IMPLEMENTADO

Somente em uma Fase 2 autorizada:

- orquestrador N17 explícito;
- request/response contract do N17;
- validação da autorização N15;
- idempotência pré-chamada e concorrência;
- persistência de aquisição API com provenance correta;
- response digest seguro;
- vínculo candidate/product conforme sequência final N16→N17;
- mapeamento fechado dos erros N8 para estados N17;
- contrato estável para N18;
- testes unitários, de replay, concorrência e fail-closed;
- migration somente se o contrato persistente for aprovado.

## 21. O QUE NÃO DEVE SER IMPLEMENTADO

- Novo transporte Shopee paralelo ao N8;
- scraping, browser automation, proxy, bypass ou endpoint não oficial;
- derivação de affiliate URL a partir de product URL;
- promoção de `offerLink` ou `productLink` sem prova de aquisição;
- conversão de `IDENTITY_UNCERTAIN` em sucesso;
- publicação dentro do N17;
- chamada de N18, N19, N20, Telegram, scheduler, agents ou job queue;
- alteração de N16 nesta fase;
- criação ou alteração de produtos canônicos;
- persistência de secrets, tokens, Authorization, assinaturas ou respostas brutas sem sanitização;
- uso de `admin:manual` para mascarar aquisição API;
- criação artificial de registros para simular prova.

## 22. DEPENDÊNCIAS EXTERNAS

- Credenciais oficiais do provider;
- disponibilidade e contrato do endpoint oficial do provider;
- elegibilidade do produto no programa de afiliados;
- identidade oficial retornada pela fonte;
- migration autorizada para provenance/método API, se necessária;
- decisão arquitetural sobre a sequência N16→N17;
- contrato de consumo do N18, ainda não implementado;
- autorização posterior para qualquer alteração de schema, código, prova viva ou deploy.

## 23. CRITÉRIOS PARA A FASE 2

A Fase 2 somente deve iniciar após autorização explícita e deve ter:

- contrato N17 aprovado;
- decisão formal sobre `candidate_id` versus `product_id` e sua associação;
- decisão formal sobre persistência API e provenance;
- definição da chave de idempotência e comportamento de replay;
- matriz de estados N8→N17 aprovada;
- definição da ordem efetiva em relação ao N16;
- definição do formato de `response_digest` e sanitização;
- testes locais sem chamadas reais inicialmente;
- proibição explícita de N18+ durante implementação local;
- gates locais antes de qualquer prova viva;
- autorização separada para migration, commit, push, deploy ou prova em produção.

## 24. DECISÃO FINAL

**READY FOR PHASE 2**.

O N17 pode avançar para desenho/implementação local porque a autoridade técnica N8, os providers e as fronteiras N6/N7/N16 foram identificados. Entretanto, a implementação deve começar por um contrato persistente aprovado; o runtime atual não está pronto para registrar aquisição API com provenance fiel.

## CONTROLES DA FASE 1

- N3: NOT EXECUTED.
- N13: NOT EXECUTED.
- N14: NOT EXECUTED.
- N15: NOT EXECUTED.
- N16: NOT EXECUTED.
- N17 acquisition: NOT EXECUTED.
- N18: NOT EXECUTED.
- N19: NOT EXECUTED.
- N20: NOT EXECUTED.
- INFRA-03: NÃO ALTERADO.
- Chamada real Shopee ou outro provider: NÃO REALIZADA.
- Geração de short link: NÃO REALIZADA.
- Escrita de banco: NÃO REALIZADA.
- Migration: NÃO REALIZADA.
- Commit: NÃO REALIZADO.
- Push: NÃO REALIZADO.
- Deploy: NÃO REALIZADO.
- Gates: NOT REQUIRED; não houve alteração de código nesta fase.

A Fase 1 termina neste relatório. Não avançar automaticamente para a Fase 2.
