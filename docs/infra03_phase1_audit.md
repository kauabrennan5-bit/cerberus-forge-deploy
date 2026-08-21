# BLOCO INFRA-03 — INTEGRAÇÃO OFICIAL SHOPEE
## FASE 1 — AUDITORIA, INVENTÁRIO E DESIGN DO ADAPTADOR

**Status:** READY WITH EXTERNAL DEPENDENCY

**PROOF_RUN_ID:** `INFRA03_20260819T230649Z`

**SHA auditado:** `44a31d687ae06d2398e6651ad1009e3acfbeefbd`

**Branch:** `main`

**origin/main:** `44a31d687ae06d2398e6651ad1009e3acfbeefbd`

**Data do preflight:** `2026-08-19T23:06:49Z`

## 1. Escopo e decisão de governança

Esta fase auditou a integração Shopee já existente e desenhou a menor fronteira possível para uma futura fonte oficial antes do N13. Nenhuma integração produtiva nova foi implementada, nenhum cliente duplicado foi criado e nenhum dado comercial foi persistido.

A fronteira governada permanece:

```text
SHOPEE API
  -> adaptador/normalização oficial
  -> candidate_evidence com provenance API
  -> N13 Curadoria
  -> N14 Commercial Brain
  -> N15 Governance / APPROVED
  -> N16 Publication Executor / PUBLISH
```

A fonte Shopee não pode produzir PASS, score comercial, APPROVED ou PUBLISH. N15 continua sendo a única autoridade de autorização e N16 continua sendo o único executor de PUBLISH.

## 2. Inventário da integração existente

### 2.1 Cliente HTTP/GraphQL

Arquivo: `server/commercial/affiliate/shopeeApiClient.ts`

Classificação: **EXISTENTE E UTILIZÁVEL**, sujeito à dependência de confirmação documental/permissional externa.

O cliente já contém:

- transporte HTTP injetável para testes;
- timeout configurável;
- endpoint padrão BR `https://open-api.affiliate.shopee.com.br/graphql`;
- assinatura `SHA256 Credential={appId}, Timestamp={timestamp}, Signature={signature}`;
- timestamp Unix em segundos;
- assinatura calculada sobre `Credential + Timestamp + Payload + Secret`;
- payload GraphQL serializado como corpo efetivamente enviado;
- operação dirigida `productOfferV2(itemId, shopId, limit: 1)`;
- operação oficial modelada `generateShortLink`;
- validação de envelope GraphQL e de nós;
- match estrito entre `itemId`/`shopId` solicitado e resposta;
- preservação da URL oficial retornada, sem derivação;
- catálogo fechado de erros e tratamento fail-closed.

O código existente deve ser reutilizado. Não há justificativa para criar um segundo cliente Shopee.

### 2.2 Provider Shopee

Arquivo: `server/commercial/affiliate/shopeeAffiliateProvider.ts`

Classificação: **EXISTENTE E UTILIZÁVEL** como adaptador entre o cliente oficial e o contrato N8.

O provider:

- exige `appId` e `secret` não vazios;
- usa o cliente isolado;
- aplica retry limitado somente aos estados transitórios catalogados;
- extrai `itemId` e `shopId` de forma estrita;
- chama a resolução dirigida `productOfferV2(itemId, shopId)`;
- mapeia `itemId` para `listingId`, `shopId` para `sellerId` e `name` para `titleSnapshot` quando a resposta os fornece;
- preserva `offerLink` como `affiliateUrl`;
- recusa substituir `offerLink` por `productLink`;
- usa `generateShortLink` somente como mecanismo oficial modelado para o caso de produto não encontrado na oferta;
- não grava banco, não cria evidência e não chama N13–N16 diretamente.

Quando o caminho `generateShortLink` não devolve título oficial, a identidade não deve ser promovida como confirmada pelo N8. O contrato N8 exige identidade confirmada com `listingId`, `sellerId` e `titleSnapshot` oficiais; sem título, o estado correto é `IDENTITY_UNCERTAIN`.

### 2.3 Contratos Shopee

Arquivo: `server/commercial/affiliate/shopeeClientContracts.ts`

Classificação: **EXISTENTE E UTILIZÁVEL**.

O arquivo define um catálogo fechado de estados de erro, o subconjunto transitório de retry, contratos de request/result e extração estrita de identificadores por URL. A extração aceita somente padrões oficiais conhecidos, incluindo `/product/{shop}/{item}`, `-i.{shop}.{item}` e parâmetros `shop_id`/`item_id`; URL sem a tupla não pode ser tratada como identidade.

### 2.4 Contrato conceitual N8

Arquivo: `server/commercial/affiliate/acquisitionContract.ts`

Classificação: **EXISTENTE MAS NÃO É PONTE DE EVIDÊNCIA**.

O contrato conceitual diferencia `SUCCESS`, `IDENTITY_UNCERTAIN`, `AUTH_REQUIRED`, `NOT_SUPPORTED`, `MANUAL_REQUIRED`, `PRODUCT_NOT_ELIGIBLE`, `PROVIDER_NOT_ACTIVE` e `RESOLUTION_FAILED`. Também deixa explícito que aquisição não é registro, resolução não é decisão, link não é produto e aquisição não é publicação.

A proveniência `admin:acquired` permanece proposta e não deve ser introduzida nesta fase. Ela não substitui a provenance de evidência API e não autoriza publicação.

### 2.5 Bootstrap

Arquivo: `server.ts`, bootstrap do N8.

Classificação: **EXISTENTE E UTILIZÁVEL**, com configuração fail-closed.

O bootstrap aceita, em ordem de compatibilidade:

```text
SHOPEE_APP_ID
SHOPEE_APP_SECRET
SHOPEE_AFFILIATE_APP_ID
SHOPEE_AFFILIATE_APP_SECRET
SHOPEE_AFFILIATE_API_BASE_URL (opcional)
```

O provider é inicializado com `providerId=affprv-shopee` somente quando App ID e Secret estão presentes. Sem ambas as credenciais, a fonte permanece nula e a aquisição retorna `AUTH_REQUIRED`. O bootstrap não imprime valores secretos.

### 2.6 Rotas e destino atual

Arquivo: `server/commercial/affiliate/affiliateRoutes.ts`.

Classificação: **EXISTENTE E UTILIZÁVEL PARA N8; NÃO É PONTE N3**.

A rota administrativa `/api/commercial/affiliate/acquire` pode adquirir em preview por API ou aceitar URL oficial fornecida manualmente. O caminho manual valida whitelist, registra pelo contrato vigente do N6 e mantém `IDENTITY_UNCERTAIN`. Registro de link não autoriza publicação.

O destino atual da integração Shopee termina em N8/N6. Não existe, no inventário auditado, uma ponte produtiva Shopee API -> `candidate_evidence` -> N13.

### 2.7 N3 e evidência

Arquivo: `server/commercial/discovery/research.ts`.

Classificação: **EXISTENTE, MAS INCOMPLETO PARA SHOPEE API**.

O N3 atual cria sessão e campos com `source_type="scrape"` e `collection_method="SCRAPE"`, utilizando o fetch de página do anúncio. Em caso de falha, grava `COLLECTION_FAILED` e mantém os campos desconhecidos. Em caso de coleta válida, grava `KNOWN`, `UNKNOWN`, `DERIVED` ou `CONTRADICTED` conforme o contrato existente.

Para uma fonte Shopee API, o N3 não deve ser alterado nesta Fase 1. A futura ponte deverá adaptar uma observação oficial para `source_type="api"` e `collection_method="API"`, preservando a mesma semântica de estados e idempotência. Qualquer alteração estrutural no N3 será dependência explícita da Fase 2 ou de novo escopo, não uma alteração silenciosa nesta auditoria.

Arquivo: `server/repositories/candidateEvidenceRepository.ts`.

Classificação: **EXISTENTE E COMPATÍVEL**.

O schema/catálogo atual já aceita `source_type="api"`, `collection_method="API"`, `UNKNOWN`, `COLLECTION_FAILED`, `CONTRADICTED` e `KNOWN`. A ponte futura pode reutilizar o repository existente sem migration somente se respeitar seus contratos, sanitização e idempotência.

## 3. Mapa arquitetural atual

```text
SHOPEE URL / product reference
  -> extractShopeeIdentifiers()
  -> shopeeApiClient.ts
       -> productOfferV2(itemId, shopId)
       -> generateShortLink(originUrl, subIds) quando aplicável
  -> shopeeAffiliateProvider.ts
       -> AffiliateApiSource
  -> acquisitionService.ts / N8
       -> SUCCESS ou IDENTITY_UNCERTAIN ou erro fail-closed
  -> affiliateRoutes.ts
       -> preview ou registro N6 DRAFT/UNVALIDATED
  -> fim do fluxo atual

N3 research.ts
  -> caminho separado de SCRAPE
  -> candidate_evidence
  -> N13
```

A lacuna é a ausência de uma ponte governada e explicitamente tipada entre a observação Shopee API e o contrato `candidate_evidence`. Essa lacuna não autoriza misturar aquisição de afiliado com pesquisa de produto.

## 4. API oficial e grau de confirmação

### 4.1 Endpoints encontrados no código

```text
https://open-api.affiliate.shopee.com.br/graphql
```

Operações modeladas:

```text
productOfferV2(itemId, shopId, limit: 1)
generateShortLink(input: { originUrl, subIds })
```

### 4.2 Fontes externas

O portal oficial identificado foi:

```text
https://affiliate.shopee.com.br/open_api
```

O conteúdo público acessível sem login/área autenticada não expôs o contrato técnico GraphQL, scopes ou permissões específicas. A página `https://www.affiliateshopee.com.br/documentacao` foi classificada como material auxiliar não oficial e não pode ser usada isoladamente como autoridade normativa.

A documentação oficial da Shopee Open Platform em `https://open.shopee.com/developer-guide/16` foi consultada apenas para distinguir a plataforma de vendedores da Affiliate API BR. Ela usa outro contrato, incluindo HMAC-SHA256, partner_id e domínios próprios; não deve ser misturada com a Affiliate API de afiliados.

Há registro histórico no projeto de uma prova D-SHOPEE-1 com introspection/chamadas reais em `2026-08-18`, identificada como `SHOPEE_D1_PROVA_20260818`. O teste versionado que permanece no repositório é, entretanto, mock-only. A prova histórica não foi repetida nesta Fase 1 e não deve ser confundida com cada fixture local.

Classificação final: **API oficial identificada no código e no portal, mas contrato técnico/permissões atuais permanecem CONDITIONAL/UNKNOWN para fins de uma nova ponte de evidência**.

## 5. Autenticação, configuração e credenciais

### 5.1 O que o código efetivamente usa

O cliente atual usa App ID e App Secret para produzir uma assinatura SHA-256 por requisição. O header e a fórmula implementados são:

```text
Authorization: SHA256 Credential={appId}, Timestamp={timestamp}, Signature={signature}

signature = SHA256(appId + timestamp_seconds + exact_payload + app_secret)
```

O timestamp é Unix em segundos. O payload é o corpo GraphQL exato enviado no transporte.

O cliente atual não implementa access token, refresh token ou OAuth Bearer para o caminho Shopee auditado. Isso é uma observação do código, não uma afirmação de que a conta Shopee não possua outros mecanismos de autenticação fora deste cliente.

### 5.2 Configuração segura

Nomes aceitos pelo bootstrap:

```text
SHOPEE_APP_ID
SHOPEE_APP_SECRET
SHOPEE_AFFILIATE_APP_ID
SHOPEE_AFFILIATE_APP_SECRET
SHOPEE_AFFILIATE_API_BASE_URL
```

No preflight local redigido, somente `APP_DOMAIN` e `APP_ENV` apareceram entre as chaves listadas. Nenhum valor de segredo foi impresso.

A existência histórica de configuração operacional Shopee e a prova D1 de 2026-08-18 foram registradas no projeto, mas a presença atual de cada segredo não foi revalidada nesta fase para evitar qualquer exposição. Portanto:

```text
configuração local observada: SHOPEE_* não presente no snapshot redigido
configuração Render atual: não revalidada nesta Fase 1
credential_present para uma nova prova: UNKNOWN
```

Não solicitar segredo no chat. A futura validação deverá verificar apenas presença/ausência por canal seguro.

### 5.3 Permissões e limites

A documentação técnica pública acessível não confirmou scopes, owner/account, limites numéricos, expiração, refresh ou quais contas podem consultar itens de terceiros. Esses campos permanecem:

```text
scopes: UNKNOWN
owner/account: UNKNOWN
permissões para productOfferV2: CONDITIONAL
permissões para generateShortLink: CONDITIONAL
limites numéricos: UNKNOWN
expiração/refresh: NOT USED BY CURRENT CLIENT; EXTERNAL ACCOUNT MODEL UNKNOWN
```

A integração não deve assumir que uma credencial válida habilita todas as operações.

## 6. Matriz de campos e estado

A matriz abaixo usa texto linear para permanecer copiável. `CONDITIONAL` significa que o campo pode ser observado quando a resposta oficial válida o contiver; não significa que foi confirmado nesta auditoria.

```text
external_listing_id
  Shopee: productOfferV2.nodes[].itemId
  Endpoint: productOfferV2
  Permissão: acesso Affiliate API ao produto solicitado
  Estado: CONDITIONAL
  Regra: só usar após match exato com o itemId solicitado; ausência ou divergência -> COLLECTION_FAILED/BLOCKED.

title
  Shopee: productOfferV2.nodes[].name
  Endpoint: productOfferV2
  Permissão: acesso ao nó de oferta
  Estado: CONDITIONAL
  Regra: somente valor retornado oficialmente; ausência permanece UNKNOWN.

price
  Shopee: productOfferV2.nodes[].price, conforme parser atual
  Endpoint: productOfferV2
  Permissão: acesso ao nó de oferta
  Estado: CONDITIONAL
  Regra: moeda e unidade devem ser preservadas conforme resposta; não converter sem contrato observado.

currency
  Shopee: não confirmado no nó/fixture auditado
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN
  Regra: nunca inferir BRL somente por domínio .com.br.

seller/shop id
  Shopee: productOfferV2.nodes[].shopId
  Endpoint: productOfferV2
  Permissão: acesso ao nó de oferta
  Estado: CONDITIONAL
  Regra: match exato com shopId solicitado.

seller/shop name
  Shopee: não encontrado no contrato/fixture auditado
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN

category id
  Shopee: não confirmado no contrato/fixture auditado
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN

category name
  Shopee: não confirmado no contrato/fixture auditado
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN

images
  Shopee: não confirmado no contrato/fixture auditado
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN

availability
  Shopee: não confirmado
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN

stock
  Shopee: não confirmado
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN

rating
  Shopee: não confirmado
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN

review_count
  Shopee: não confirmado
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN

historical/observed price
  Shopee: preço observado na resposta, sem histórico
  Endpoint: productOfferV2
  Permissão: acesso ao nó de oferta
  Estado: CONDITIONAL
  Regra: pode registrar somente a observação atual e observed_at; não fabricar histórico.

commission
  Shopee: não confirmado pelo cliente/fixtures auditados
  Endpoint: UNKNOWN
  Permissão: UNKNOWN
  Estado: UNKNOWN

affiliate URL/deeplink
  Shopee: offerLink ou shortLink retornado oficialmente
  Endpoint: productOfferV2 / generateShortLink
  Permissão: operação oficial autorizada
  Estado: CONDITIONAL
  Regra: preservar URL exata; ausência de link nunca usa productLink como fallback.

product URL
  Shopee: productLink retornado ou originUrl fornecido pelo operador
  Endpoint: productOfferV2 / generateShortLink
  Permissão: validação de URL oficial
  Estado: CONDITIONAL
  Regra: product URL nunca é affiliate URL.

marketplace
  Shopee: contexto do provider
  Endpoint: interno
  Permissão: provider ativo
  Estado: KNOWN no contexto de fonte, não como dado de produto

observed_at
  Shopee: timestamp UTC da observação no adaptador
  Endpoint: metadata do adaptador
  Permissão: nenhuma adicional
  Estado: CONDITIONAL
  Regra: distinguir tempo de observação Cerberus de timestamp fornecido pela Shopee.

source
  Shopee: api
  Endpoint: metadata do adaptador
  Permissão: fonte oficial confirmada
  Estado: CONDITIONAL
  Regra: somente quando a chamada e o envelope passarem no contrato.

provenance
  Shopee: source_type=api, collection_method=API
  Endpoint: candidate_evidence
  Permissão: repository de evidência
  Estado: CONDITIONAL
  Regra: não confundir com provenance N8 admin:acquired.

response status
  Shopee: status HTTP observado
  Endpoint: transporte
  Permissão: chamada oficial
  Estado: CONDITIONAL
  Regra: status ausente ou não observado não deve virar 200 implícito.
```

## 7. Contrato proposto de provenance

A futura evidência Shopee API deverá usar, no mínimo:

```text
source_type=api
collection_method=API
marketplace=SHOPEE
external_listing_id=<itemId observado e conferido>
observed_at=<UTC da observação>
http_status=<status HTTP observado>
response_digest=sha256:<digest do payload canônico>
field_state=KNOWN|UNKNOWN|COLLECTION_FAILED|CONTRADICTED
```

O `response_digest` deve ser calculado sobre um payload canônico, determinístico e sem dados sensíveis. Devem ser excluídos:

```text
Authorization
AppSecret
AppKey privada
access_token
refresh_token
cookies
headers sensíveis
```

A ordenação de propriedades deve ser canônica, e a ausência de campo deve ser representada explicitamente por `null`/estado `UNKNOWN`, conforme o contrato do repository. Uma resposta parcial válida pode produzir campos `KNOWN` e campos `UNKNOWN`, mas somente depois de o envelope, status e identidade passarem nas validações.

Falha de transporte, autenticação, schema, identidade ou contrato deve produzir tentativa auditável `COLLECTION_FAILED`, sem qualquer campo `KNOWN` derivado da resposta inválida.

## 8. Contrato de identidade

A chave de identidade mínima é a tupla composta:

```text
marketplace=SHOPEE
shop_id
item_id
```

Regras:

```text
1. itemId e shopId devem ser extraídos de fonte autorizada ou da URL por parser estrito.
2. A resposta deve conter a tupla correspondente ao item solicitado.
3. A presença de outro nó ou o primeiro nó não autoriza associação.
4. itemId divergente -> FAIL-CLOSED.
5. shopId divergente -> FAIL-CLOSED.
6. ausência de qualquer parte da tupla -> UNKNOWN/NOT_FOUND/COLLECTION_FAILED conforme a causa.
7. productLink não substitui a tupla de identidade.
8. generateShortLink sem titleSnapshot não deve produzir identidade confirmada no N8.
```

No mapeamento atual do provider, `itemId` vira `listingId` e `shopId` vira `sellerId` para o contrato N8. Esse mapeamento é uma convenção interna validada pelo match dirigido; não deve ser apresentado como se a Shopee tivesse chamado `shopId` de seller_id sem observar o campo.

## 9. Matriz de erros e comportamento fail-closed

```text
401 Unauthorized
  -> COLLECTION_FAILED / BLOCKED
  -> não gerar evidência KNOWN; não tentar URL alternativa.

403 Forbidden
  -> COLLECTION_FAILED / BLOCKED
  -> registrar status observado sem expor resposta sensível.

404 Not Found
  -> NOT_FOUND ou COLLECTION_FAILED, conforme o contrato de transporte.
  -> nunca tratar como produto diferente.

409 Conflict
  -> COLLECTION_FAILED / BLOCKED; sem retry automático não comprovado.

429 Rate Limited
  -> estado transitório; retry somente se já permitido pelo provider e dentro do limite fechado.
  -> se esgotado, COLLECTION_FAILED / BLOCKED.

5xx
  -> COLLECTION_FAILED / BLOCKED; retry somente se a política fechada permitir.

Timeout
  -> COLLECTION_FAILED / BLOCKED; retry limitado somente no escopo transitório existente.

Network error
  -> COLLECTION_FAILED / BLOCKED; nunca preencher KNOWN.

JSON inválido
  -> COLLECTION_FAILED / BLOCKED.

Schema inválido
  -> COLLECTION_FAILED / BLOCKED.

Campo obrigatório ausente
  -> campo UNKNOWN se a resposta restante for estruturalmente válida e o campo for opcional;
  -> COLLECTION_FAILED se o campo for obrigatório para identidade/contrato.

Identidade divergente
  -> COLLECTION_FAILED / BLOCKED.

Token ausente
  -> CREDENTIAL_REQUIRED / AUTH_REQUIRED.

Token expirado
  -> AUTH_REQUIRED ou COLLECTION_FAILED; o cliente atual não possui refresh OAuth implementado.

Scope insuficiente
  -> COLLECTION_FAILED / BLOCKED; não presumir permissão.

Assinatura inválida
  -> AUTH_REQUIRED / COLLECTION_FAILED; nunca retry cego.

Resposta vazia
  -> NOT_FOUND ou COLLECTION_FAILED conforme o envelope; nunca SUCCESS.

Resposta parcialmente válida
  -> campos observados podem ser KNOWN somente se status, schema e identidade forem válidos;
  -> campos ausentes permanecem UNKNOWN;
  -> link ausente nunca é derivado de productLink.
```

## 10. Compatibilidade com N13

O N13 não recebe hoje uma fonte Shopee API diretamente. O N3 atual trabalha com `ResearchInput`, candidato existente, sessão de pesquisa e evidência por campo, usando `SCRAPE` como método atual.

A futura fronteira deve ser explícita:

```text
Shopee API observation
  -> normalized official observation
  -> EvidenceInput
       source_type=api
       collection_method=API
       source_url=productLink ou URL oficial observada
       external_listing_id em metadata/field payload conforme contrato
       observed_at=UTC
       http_status=status observado
       evidence_hash=response/field digest
       field_state=KNOWN|UNKNOWN|COLLECTION_FAILED|CONTRADICTED
  -> candidate_evidence
  -> N13 evaluate
```

Campos obrigatórios do N13 devem ser confirmados no adapter de evidência, mas a ausência de dados nunca deve ser preenchida por scraping automático ou inferência. A fonte deve preservar múltiplas evidências e idempotência pelo digest/field hash do repository existente.

N13 continua responsável por decidir suficiência, PASS, BLOCKED e conflitos. A fonte Shopee não pode produzir nenhum desses veredictos.

Se a implementação exigir alterar `research.ts` para aceitar um provider de coleta API, isso será dependência de implementação da Fase 2; não foi feito nesta fase.

## 11. Compatibilidade com N14–N16

Nenhum arquivo N14, N15 ou N16 foi alterado.

A cadeia conceitual permanece:

```text
Shopee evidence
  -> N13 PASS
  -> N14 score válido
  -> N15 APPROVED
  -> N16 PUBLISH
```

A futura fonte não pode:

```text
aprovar;
produzir score;
criar GovernanceDecision;
criar publication_execution;
chamar provider de publicação;
chamar N17/N18/N19/N20;
alterar products;
criar affiliate_links como efeito colateral de evidência.
```

Qualquer necessidade de alteração em N13–N16 é `DEPENDÊNCIA FUTURA / NOVO ESCOPO`.

## 12. Fixtures e testes existentes

Os testes existentes são majoritariamente locais e mock-only:

```text
tests/shopeeAffiliateIntegration.test.ts
tests/shopeeDirectedResolutionD1.test.ts
tests/acquisitionContractN8.test.ts
```

Eles usam `test-app-id`/`test-app-secret` e transport injetado. Esses valores são fixtures sintéticas e não são credenciais de produção.

A cobertura local existente valida:

```text
- assinatura sobre o payload exato;
- timestamp Unix em segundos;
- productOfferV2 com match estrito de itemId/shopId;
- mismatch/not_found;
- generateShortLink;
- subIds inválidos;
- URL não HTTPS;
- shortLink ausente;
- erro GraphQL 10020 Invalid Signature;
- rate limit, timeout e network error;
- ausência de credenciais;
- preservação da URL oficial;
- não derivação de affiliate URL.
```

Os testes não constituem prova real atual porque o transporte executável é mockado. A prova histórica D-SHOPEE-1 está registrada em comentário com `PROOF_RUN_ID=SHOPEE_D1_PROVA_20260818`, mas não foi reexecutada nesta fase.

## 13. Security finding e secret scan

Nenhum valor de App ID, App Secret, token, cookie ou Authorization completo foi registrado neste relatório.

O preflight registrou somente nomes redigidos de configuração. O scan permaneceu restrito ao escopo Shopee. Foram encontrados somente referências de nomes de configuração e fixtures sintéticas preexistentes, incluindo `test-app-secret` e o header administrativo usado em testes. Nenhum valor de produção foi identificado, impresso ou adicionado por esta fase.

Classificação:

```text
SECURITY_FINDING_OUT_OF_SCOPE
```

Não corrigir automaticamente esses artefatos de teste nesta Fase 1, para não misturar escopo nem alterar produção.

## 14. Riscos e lacunas

```text
R1 — contrato técnico público incompleto no portal oficial acessível sem login.
R2 — scopes/permissões efetivas e owner/account não confirmados.
R3 — credenciais Render não revalidadas nesta auditoria para evitar exposição.
R4 — não existe ponte produtiva Shopee API -> candidate_evidence.
R5 — campos de categoria, imagens, estoque, disponibilidade, rating, reviews e comissão permanecem UNKNOWN.
R6 — generateShortLink pode produzir URL oficial sem título suficiente para identidade confirmada.
R7 — não existe histórico de preço; somente observação pontual quando o campo for retornado.
R8 — contrato da Shopee Open Platform não pode ser misturado ao Affiliate API BR.
R9 — adicionar API ao N3 pode exigir uma alteração futura no ponto de entrada de pesquisa, que deve ser isolada e testada.
R10 — fixtures existentes não podem ser apresentadas como respostas reais.
```

## 15. O que pode ser reutilizado

```text
- shopeeApiClient.ts;
- shopeeClientContracts.ts;
- shopeeAffiliateProvider.ts;
- extração estrita de itemId/shopId;
- assinatura e transporte injetável;
- catálogo fechado de erros;
- retry limitado do provider;
- host whitelist e preservação de URL;
- identidade N8 e estado IDENTITY_UNCERTAIN;
- candidateEvidenceRepository.ts;
- source_type=api e collection_method=API já aceitos pelo repository;
- sanitização de metadata e digest do repository;
- testes e mocks existentes.
```

## 16. O que precisa ser implementado na Fase 2

A menor implementação segura é um adaptador de observação, não um novo cliente Shopee:

```text
1. Reutilizar shopeeApiClient e shopeeAffiliateProvider.
2. Criar um resultado interno de OfficialShopeeObservation.
3. Validar status, envelope, schema e tupla shopId/itemId.
4. Normalizar apenas os campos realmente retornados.
5. Produzir response_digest canônico sem secrets.
6. Mapear campos ausentes para UNKNOWN.
7. Mapear falhas para COLLECTION_FAILED/BLOCKED.
8. Injetar um writer/bridge de evidência sem publicar nem pontuar.
9. Persistir apenas quando houver autorização explícita da Fase 2 e candidate_id válido.
10. Testar com fixtures FIXTURE/SYNTHETIC, sem chamada real automática.
11. Manter N13 como autoridade de curadoria.
```

A Fase 2 não deve criar automaticamente produto, affiliate_link, job ou publicação. Uma eventual prova real deverá ser uma fase separada, com autorização explícita, credenciais presentes e cleanup controlado.

## 17. Baseline e produção

Baseline registrado pelo preflight Supabase:

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

Baseline depois da auditoria: igual ao baseline inicial. Nenhum registro foi criado ou alterado.

Produção não foi alterada. Não houve migration, alteração de env, chamada autenticada, publicação ou provider de publicação.

## 18. Testes e gates da Fase 1

A Fase 1 é auditoria/design e não introduziu código produtivo. Os testes Shopee existentes permanecem determinísticos e mock-only conforme inventário. Nenhuma chamada externa Shopee foi executada.

Gates executados após a auditoria:

```text
npm test: PASS — 1341 testes, 1341 pass, 0 fail, 0 skipped
npx tsc --noEmit: PASS — exit 0
npm run build: PASS — exit 0
git diff --check: PASS — exit 0
secret scan no escopo Shopee: PASS sem segredo de produção; SECURITY_FINDING_OUT_OF_SCOPE para fixtures/nomenclatura preexistentes
```

Os testes exibiram avisos preexistentes de configuração Supabase/Gemini ausente no ambiente local, sem falha de teste e sem alteração de produção. O secret scan não imprimiu valores sensíveis.

## 19. Isolamento obrigatório confirmado

```text
products: não criado
candidates: não criado
candidate_evidence: não criado
candidate_assessment: não criado
affiliate_links: não criado
job_queue: não criado
publication_executions: não criado
commercial_cycles: não criado
N13: não alterado e não executado
N14: não alterado e não executado
N15: não alterado e não executado
N16: não alterado e não executado
N17: não iniciado
Telegram: não acionado
scheduler: não acionado
agents: não acionados
catálogo canônico: não alterado
```

## 20. Git e produção

```text
commit: não realizado
push: não realizado
deploy: não realizado
migration: não realizada
Render env: não alterado
working tree: contém artefatos de documentação e código local pré-existentes das fases INFRA-01/INFRA-02/N16; nenhuma alteração produtiva Shopee foi aplicada nesta Fase 1.
```

## 21. Decisão final

**READY WITH EXTERNAL DEPENDENCY**.

O código Shopee existente é reutilizável e possui cobertura contratual local relevante. A arquitetura atual termina em N8 e ainda não possui uma ponte de evidência Shopee API para N3/N13. O portal oficial público não confirmou, sem login, o contrato técnico completo, scopes e permissões efetivas. A existência histórica de uma prova D1 não substitui a necessidade de manter os campos e permissões não observados como UNKNOWN/CONDITIONAL.

A Fase 1 está concluída. Não avançar automaticamente para a Fase 2. A próxima fase exige autorização explícita, escopo de implementação isolado, testes locais, scan de secrets e nenhuma integração com N14–N16.

## 22. Artefatos de auditoria

```text
/tmp/infra03_inventory_paths.txt
/tmp/infra03_official_sources.md
/tmp/infra03_phase1_preflight.txt
/home/ubuntu/.mcp/tool-results/2026-08-19_23-07-38.152285041_supabase_execute_sql_e2c5d542.json
```

**Fim do relatório INFRA-03 Fase 1.**

## 23. References

[1]: https://affiliate.shopee.com.br/open_api — Portal oficial indicado para a Shopee Affiliate API.

[2]: https://open.shopee.com/developer-guide/16 — Documentação oficial da Shopee Open Platform, consultada apenas para distinguir seu contrato do Affiliate API BR.

[3]: https://www.affiliateshopee.com.br/documentacao — Material auxiliar identificado como não oficial; não utilizado como autoridade normativa.

**Fim do relatório INFRA-03 Fase 1.**
