# BLOCO N10 — DISCOVERY REAL / SOURCE CONNECTORS

## FASE 1 — DESIGN REVIEW + AUDITORIA + IMPLEMENTAÇÃO LOCAL

**Data:** 17/08/2026 (GMT-3)
**Autor:** Manus AI
**Estado:** `N10 — FASE 1 — READY FOR REVIEW`
**SHA do repositório auditado:** `9fbc086dfca390844a660491568385cf0b85ff0a` (N9 consolidado em produção)
**Implementação local (nova):** `server/commercial/sourceConnector/` + `tests/n10SourceConnector.test.ts` — **NÃO commitada, NÃO publicada**

---

## 1. EXECUTIVE SUMMARY

A auditoria revelou uma conclusão estrutural importante: **a maior parte da camada de Discovery real já existe** no repositório, implementada dentro do Bloco N2 (`server/commercial/discovery/`), com apoio do Bloco N1 (`candidatesRepository.ts`) para registro idempotente de candidatos. O que falta não é uma nova máquina de estados, mas uma **camada fina de orquestração de connectors (Source Connector layer)** que formalize o contrato de entrada/saída, padronize os mecanismos de identidade externa por marketplace e consolide o que já está disseminado entre N2, N9 e serviços globais.

A arquitetura proposta para o N10 é, portanto, **aditiva e conservadora**: ela reutiliza `executeDiscover`, `validateDiscoveryUrl`, `CandidateNormalizer`, `SlidingWindowRateLimiter`, `CircuitBreaker` e `registerCandidate` já existentes, e adiciona apenas o mínimo necessário para transformar o discovery "por URL única" em um processo repetível, auditável e protegido contra duplicação (ex.: o mesmo produto aparecendo 10 vezes gera no máximo 1 candidate). As fronteiras com N8 (affiliate acquisition), N9 (commercial cycle), N3 (research) e N4 (assessment) permanecem intactas por contrato, e nenhuma migration, credencial, agente, scheduler ou chamada comercial real é exigida nesta fase.

## 2. ESTADO ATUAL (SNAPSHOT DO REPOSITÓRIO)

O estado auditado corresponde ao SHA `9fbc086`, publicado no Render com paridade exata (`/health`), com o catálogo canônico de 12 produtos intacto e zero candidatos/evidências residuais em produção. O N9 está consolidado e o ciclo S1→S8 foi provado em produção na Fase 4 do N9, com fail-closed demonstrado (publicação bloqueada em ambos os ciclos de prova) e duas correções de contrato incorporadas na consolidação (normalização de marketplace e fail-closed quando o provider N6 está ausente).

| Dimensão | Estado |
|---|---|
| Catálogo canônico (`products`) | 12 produtos, intacto |
| Candidates / assessments / evidences | 0 (baseline limpa pós-N9 Fase 4) |
| Affiliate links / providers | 0 (credenciais Shopee não configuradas) |
| Job queue / scheduler / agentes | 0 / desligado / `enabled=false` |
| N9 commercial cycles | 0 (provas limpas) |
| Deploy Render | SHA `9fbc086`, 200 OK |

## 3. DISCOVERY EXISTENTE (AUDITORIA COMPLETA)

### 3.1 Autoridades e responsabilidades atuais

A auditoria mapeou a cadeia completa de discovery e determinou as autoridades atuais com evidência no código:

| Pergunta do prompt | Resposta com evidência |
|---|---|
| Qual módulo é a autoridade para discovery? | `server/commercial/discovery/discover.ts` → `executeDiscover(input)` (N2), com entrada `POST /api/commercial/discover` (`discoveryRoutes.ts`) e Telegram `discoveryCommands.ts` |
| Qual módulo cria candidate? | `server/repositories/candidatesRepository.ts` → `registerCandidate(input)` (N1); o discovery apenas entrega o payload, o N1 decide e persiste |
| Qual módulo valida URL? | Dupla camada: `marketplace.ts` (global, com SSRF guard) + `server/commercial/discovery/evidence.ts` → `validateDiscoveryUrl(url, marketplace)` com whitelist por marketplace |
| Quais formatos de marketplace existem? | 4 representações paralelas: N1 human (`"Shopee"`, `"Mercado Livre"`, `"Outro"`), N2 UPPER (`"SHOPEE"`, `"MERCADOLIVRE"`), N8 (`"Shopee"`, `"MercadoLivre"`), N9 snake (`"shopee"`, `"mercadolivre"`) — mapeamentos existentes (`n1Marketplace` em `discover.ts`, correção do N9) |
| Quais marketplaces já são reconhecidos? | Somente Mercado Livre e Shopee (`MARKETPLACE_SOURCE`, `MARKETPLACE_HOSTS`) |
| Quais contratos devem ser reutilizados? | `MarketplaceConnector` (interface), `RawListing`/`RawListingField`, `CandidateDiscoveryPayload`, `DiscoverResult`, `CandidateIntakeInput`, `listingKeyFrom` — ver seção 4 |
| Onde existe duplicação ou acoplamento? | (a) Whitelists de host em dois lugares (`ALLOWED_MARKETPLACE_DOMAINS` em `marketplace.ts` e `MARKETPLACE_HOSTS` em `discovery/types.ts`); (b) nomes de marketplace em 4 dialetos; (c) o N9 chama `executeDiscover` diretamente (acoplamento a uma função concreta, com patch local de normalização) |

### 3.2 Componentes mapeados

O núcleo do discovery existente é composto pelos seguintes módulos, todos dentro de `server/commercial/discovery/`:

| Módulo | Papel |
|---|---|
| `types.ts` | `MarketplaceSource`, `MARKETPLACE_HOSTS`, `DISCOVERY_LIMITS`, `RawListing`, `RawListingField`, `NormalizedField`, `CandidateDiscoveryPayload`, `DiscoverResult`, interface `MarketplaceConnector` |
| `discover.ts` | `executeDiscover(input {marketplace, mode:"url"\|"search", url/query})` — validação, roteamento ao connector, registro via N1, resultado com `created/duplicates/conflicts` |
| `evidence.ts` | `validateDiscoveryUrl` (host whitelist + redirect), `isRedirectHostAllowed`, `evidenceDigest`, `contentSnapshot`, `registerCollectionFailure` |
| `connectors/mercadoLivre.ts` | `MercadoLivreConnector` — páginas públicas, regex de item ID na busca, `fetchListing` |
| `connectors/shopee.ts` | `ShopeeConnector` — páginas públicas, regex `shopee.com.br/.../(\d+)/(\d+)` (shopid/itemid), `fetchListing` |
| `normalizer.ts` | `CandidateNormalizer.normalize(RawListing → CandidateDiscoveryPayload)` com proveniência por campo (`source: "marketplace_page"\|"derived"\|"unknown"`) |
| `fetchShared.ts` | `fetchSearchResultPage`, `fetchListingPage`, `buildRawListing` + instâncias globais `discoveryRateLimiter` e `discoveryCircuitBreaker` |
| `rateLimiter.ts` | `SlidingWindowRateLimiter` e `CircuitBreaker` reutilizáveis |
| `research.ts` | `startResearch` (N3 via discovery) — fronteira discovery ≠ research |

### 3.3 Duplicações e acoplamentos identificados

A whitelist de hosts existe em dois pontos que não estão centralizados: o módulo global `marketplace.ts` (usado para detecção de marketplace a partir de URL) mantém `ALLOWED_MARKETPLACE_DOMAINS`, e `discovery/types.ts` mantém `MARKETPLACE_HOSTS` por marketplace. Qualquer adição de host exige atualização em dois lugares hoje. O segundo ponto é o pluralismo de nomes de marketplace (4 dialetos), que já gerou um bug real no N9 (corrigido na consolidação) e continuará a gerar incidentes se não for tratado como contrato único com conversores explícitos. O terceiro é o acoplamento do N9 a `executeDiscover` concreto — aceitável hoje, mas o N10 deve inverter essa dependência: o N9 deve depender da interface `MarketplaceConnector`/do contrato de discovery, e o N10 (como novo consumidor) também.

## 4. CONTRATOS N1 / N2 / N3

### 4.1 N1 — Candidate Registry (`candidatesRepository.ts`)

O contrato de ingestão é `CandidateIntakeInput`: `marketplace`, `source_url`, `external_listing_id`, `merchant?`, `title?`, `description?`, `category?`, `observed_price?`, `observed_rating?`, `observed_rating_count?`, `observed_availability?`, `observed_at?`, `evidence_hash?`, `collection_method?`, `raw_snapshot_url?`, `idempotency_key?`, `metadata?`. A função `listingKeyFrom(marketplace, external_listing_id)` deriva uma chave imutável de proveniência (`sha256(...).slice(0,32)`) — este é **o mecanismo de idempotência primário do candidato**: mesmo listing em fontes distintas é outro candidato, mas o mesmo listing repetido colide e vira `identical_duplicate` (ou `conflict_rejected` quando os dados divergem). O registro é fail-closed (`missing_supabase` quando não há persistência) e aplica `sanitizeIntake` + `validateIntakeFields` antes de persistir. `MARKETPLACES` aceita `["Shopee", "Mercado Livre", "Outro"]` (formato human — qualquer novo conector precisa converter seu marketplace para este domínio).

### 4.2 N2 — Discovery (`discovery/types.ts` e `discover.ts`)

O contrato de saída de coleta é `RawListing` (campos de listing bruto com `RawListingField<T>` que diferencia valor nulo `unknown=true`, valor observado e valor `derivedField` — derivado exclusivamente da URL quando a página não pôde ser lida). O contrato de entrega é `CandidateDiscoveryPayload` (campos `NormalizedField` com `source` e `observed_at` por campo) — "cada campo mantém sua origem/proveniência", conforme documentado no próprio código. `DISCOVERY_LIMITS` define os limites de segurança: `MAX_RESULTS=5` (nunca crawler), `TIMEOUT_MS=15_000`, `MAX_RETRIES=1`, `CIRCUIT_WINDOW_MS=60_000`, `CIRCUIT_FAILURE_THRESHOLD=3`, `MAX_CONTENT_SNAPSHOT_BYTES=8_000`. O `DiscoverResult` retorna `mode`, `found`, `created`, `duplicates`, `conflicts`, `items[]` e `error?` — exatamente as métricas que o N10 precisará agregar.

### 4.3 N3 — Research/Evidence (`candidateEvidenceRepository.ts` + `discovery/research.ts`)

O N3 opera sobre candidatos já registrados e usa `FIELD_NAMES`/`EvidenceFieldName` com valores `KNOWN/UNKNOWN/DERIVED/COLLECTION_FAILED` e proveniência obrigatória (`contradiction_with`, redaction de metadata sensível). A fronteira é clara: discovery responde "existe um listing identificável nesta fonte?", research responde "que evidências conseguimos coletar sobre esse candidate?". O N10 não deve tocar o repositório de evidências do N3 — apenas alimentar os campos de entrada.

### 4.4 Contrato mínimo do conector de Discovery (definição)

A interface `MarketplaceConnector` já existente define o contrato mínimo:

```ts
interface MarketplaceConnector {
  readonly marketplace: MarketplaceSource;
  search(params: { query: string; limit?: number }): Promise<{
    ok: boolean; reason?: string; listings: RawListing[];
  }>;
  fetchListing(url: string): Promise<{
    ok: boolean; reason?: string; listing: RawListing | null;
  }>;
}
```

Todo campo deste contrato (marketplace, search, fetchListing, RawListing, proveniência por campo) já existe e é testado. O N10 deve **adotar** este contrato como autoridade, e qualquer `PROPOSED CONTRACT CHANGE` (ver seção 19) passa a ser adição sobre ele — nunca substituição.

## 5. AUDITORIA — MERCADO LIVRE

### 5.1 Estado real (evidência no código)

| Item auditado | Evidência |
|---|---|
| Integração real? | **Sim, mas somente por páginas públicas** — `connectors/mercadoLivre.ts` lê a página de resultados e a página do anúncio via HTTP público |
| Apenas infraestrutura? | Não — o fetch/parser funciona e foi provado em produção na Fase 4 do N9 (ciclo A; `collectionFailed=true` naquele run por página não parsing, mas o mecanismo operou) |
| API client? | **Não existe.** O connector declara explicitamente "sem API oficial, sem credenciais, sem APIs pagas" |
| Scraper/fetcher/parser? | Fetcher existe (`fetchListingPage` + regex de itens); parser existe (`buildRawListing` com normalização de título/preço/vendedor) |
| Item IDs / seller IDs / product IDs | Extraídos da URL na busca via regex `mercadolivre.com.br/.../ML[A-Z][-]?[\d]+` (item ID); `external_listing_id` é derivado da URL |
| Whitelist | `mercadolivre.com.br`, `mercadolibre.com`, `meli.la` (`MARKETPLACE_HOSTS`) + SSRF guard global em `marketplace.ts` |
| Normalização | `CandidateNormalizer` + `MARKETPLACES` human do N1 via `n1Marketplace` |
| Testes | Suíte completa cobre o connector (860+ testes passam; suíte de discovery N2 incluída) |
| Rate limit / resiliência | `SlidingWindowRateLimiter` + `CircuitBreaker` (janela 60s, 3 falhas) + timeout 15s + retry 1 — instâncias globais `discoveryRateLimiter`/`discoveryCircuitBreaker` |
| Autenticação / credenciais / endpoint | **Nenhum** — caminho público por design |

### 5.2 Risco estrutural identificado

> O Mercado Livre possui **API oficial pública e gratuita** (https://api.mercadolibre.com/items/{ITEM_ID} — sem OAuth para leitura básica de itens). O estado atual depende de scraping de páginas públicas, que é frágil (qualquer mudança de layout quebra o parser, como demonstrado pelo `collectionFailed` do ciclo A) e juridicamente menos defensável que a API oficial.

Este é um risco registrado (seção 19), **não um BLOCKER**: o scraping atual funciona como descoberta de primeira linha e a migração para a API oficial é uma melhoria de resiliência para uma fase futura do N10, sem exigir credenciais.

## 6. AUDITORIA — SHOPEE

### 6.1 Estado real (evidência no código)

O discovery Shopee (`connectors/shopee.ts`) segue o mesmo caminho do ML: **páginas públicas, sem credenciais, sem API para descoberta**. A busca lê a página pública de resultados e extrai links via regex `shopee.com.br/[^\s]*?/(\d+)/(\d+)`, capturando **shopid/itemid** — a identidade natural do anúncio Shopee. `fetchListing` valida a URL e lê a página do anúncio. A whitelists é `shopee.com.br`, `shopee.com`, `shope.ee`. Todos os limites de segurança do ML se aplicam igualmente.

### 6.2 Separação obrigatória Discovery vs Acquisition (estado real)

O estado conhecido do repositório separa nitidamente os dois caminhos Shopee:

| Dimensão | Discovery Shopee (N10) | Affiliate Acquisition Shopee (N8) |
|---|---|---|
| Módulo | `discovery/connectors/shopee.ts` | `affiliate/acquisitionService.ts` |
| Mecanismo | Páginas públicas (GET) | GraphQL oficial BR (POST) |
| Endpoint | Nenhum fixo (páginas públicas) | `https://open-api.affiliate.shopee.com.br/graphql` |
| Auth | Nenhuma | `SHA256 Credential={appId}, Timestamp={ts}, Signature=SHA256(Cred+Ts+Payload+Secret)` |
| Credenciais | Não aplicável | `SHOPEE_AFFILIATE_APP_ID/SECRET` — **não configuradas em produção** |
| Operação | Extração de shopid/itemid + listing | `productOfferV2` (nodes com `productLink`, `offerLink`) |
| Resultado | `RawListing` → candidate | `AcquireResult` (catálogo fechado) |
| Estado operacional | Funcional (provado no ciclo B do N9) | `AUTH_REQUIRED` (fail-closed por ausência de credenciais) |

A regra contratual do N8 reforça a separação: `ProductReference.publicUrl` é documentada como "**NUNCA é presumida como affiliate URL**", e `IDENTITY_UNCERTAIN` nunca é tratado como sucesso confirmado nem elegível para publicação. O N10 **não deve** ler credenciais, chamar o endpoint GraphQL nem manipular affiliate links.

## 7. FRONTIERA AFFILIATE / N8

O catálogo de resultados do N8 é fechado e fail-closed: `SUCCESS` (único com `affiliateUrl` elegível, requer `PRODUCT_IDENTITY_CONFIRMED`), `IDENTITY_UNCERTAIN` (link preservado com rationale obrigatório, **nunca elegível para publicação**), e as recusas `AUTH_REQUIRED`, `NOT_SUPPORTED`, `MANUAL_REQUIRED`, `PRODUCT_NOT_ELIGIBLE`, `PROVIDER_NOT_ACTIVE`, `RESOLUTION_FAILED` (nenhuma carrega URL elegível). O `ProviderContext.credentials` expõe somente `{present, expired}` — **nunca os valores das credenciais**. Os repositórios (`affiliate_providers`, `affiliate_links`) pertencem ao N6/N8 e não são tocados pelo discovery.

Conclusão da fronteira: **Discovery encontra produto; Acquisition obtém link de afiliado; encontrado ≠ afiliável; URL de marketplace ≠ affiliate URL.** O N8 permanece a única autoridade de acquisition e o N10 não adiciona nenhum caminho para links de afiliado.

## 8. FRONTIERA N9 (CONSUMIDOR DO DISCOVERY)

O N9 consome o discovery exclusivamente pela S1 (`runDiscovery`): normaliza o marketplace snake→UPPER, chama `executeDiscover({marketplace, mode:"url", url: cycle.source_url})`, propaga `candidate_id` e `collectionFailed` para o gate, e jamais cria candidates diretamente. Não existe segunda máquina de estados, segundo registro de candidates, segundo sistema de evidences ou segundo assessment no N9 — a auditoria confirma que o N9 é consumidor puro. O contrato N9→Discovery que o N10 deve honrar é: `(marketplace: CycleMarketplace snake, source_url) → executeDiscover result`. O N10 entra **antes** do N9: o fluxo futuro é `Source Connector → executeDiscover → N1 candidate → N9 cycle (manual)` — e não uma nova variação de S1.

### Dependências futuras mapeadas

O N10 alimenta, por contrato, a cadeia existente: `N10 → N2 discovery → N1 candidate → N3 research → N4 assessment → N9 commercial cycle`. Publicação automática, anúncios, campanhas, distribuição e agentes autônomos **não** são projetados nesta fase.

## 9. ARQUITETURA PROPOSTA DO N10

A auditoria demonstrou que a abstração "Source Connector → adapter → contract" **já corresponde em grande parte ao código existente** (`MarketplaceConnector` + `executeDiscover`). Propõe-se o N10 como uma camada fina e aditiva, sem overengineering, em três unidades conceituais:

```
                    N10 — SOURCE CONNECTOR LAYER (novo, aditivo)
 ┌──────────────────────────────────────────────────────────────────┐
 │  N10-1  ConnectorRegistry (consolida getConnector + marketplace  │
 │         normalization): entrada em QUALQUER dialeto, saída       │
 │         MarketplaceSource canônico. Fonte única das whitelists.  │
 │                                                                  │
 │  N10-2  ExternalIdentity (identity extractors por marketplace:  │
 │         ML→item_id da URL; Shopee→shopid+itemid). Extrai antes   │
 │         do fetch; falha de extração → IDENTITY_UNCERTAIN/UNKNOWN │
 │         sem inventar IDs.                                        │
 │                                                                  │
 │  N10-3  DiscoveryFacilitator (opcional, fase 2): entrada de      │
 │         "source feed" (lotes de URLs/queries) que orquestra      │
 │         executeDiscover respeitando limits, rate limiter e       │
 │         circuit breaker existentes; entrega DiscoverResult       │
 │         agregado.                                                │
 └──────────────────────────────────────────────────────────────────┘
        │  reutiliza (sem alterar)
        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  N2: MarketplaceConnector (ML/Shopee) · executeDiscover ·        │
 │      validateDiscoveryUrl · normalizer · rateLimiter · breaker   │
 │      + N1: registerCandidate (listingKeyFrom idempotente)        │
 └──────────────────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
 ┌──────────────┐            ┌──────────────────┐
 │  N9 S1 (N9   │            │  Telegram admin  │
 │  consome o   │            │  /discover,      │
 │  mesmo       │            │  /listar (N10    │
 │  contrato)   │            │  estende)        │
 └──────────────┘            └──────────────────┘
```

Três princípios regem esta arquitetura: **(1)** reutilização total do N2 — o N10 não duplica fetch, parsing, validação ou registro; **(2)** contrato único de marketplace — a variedade de dialetos converge para `MarketplaceSource` UPPER com conversores explícitos no registry; **(3)** fail-closed herdado — o N10 nunca cria candidatos diretamente; todo registro passa por `registerCandidate` do N1 com `listingKeyFrom`.

## 10. CONTRATO PROPOSTO DO CONNECTOR

O contrato mínimo do N10 **é o contrato existente**, estendido com três adições declaradas como `PROPOSED CONTRACT CHANGE` (não implementadas nesta fase):

| Campo/conceito | Status | Origem |
|---|---|---|
| `marketplace` | ✅ existente | `MarketplaceSource` (N2) |
| `source_url` | ✅ existente | `RawListing.source_url` |
| `external_listing_id` | ✅ existente | `RawListing.external_listing_id` (extraído do connector) |
| `observed_at` / `collection_method` | ✅ existente | `RawListing`/`CollectionMethod` |
| `evidence_hash` / `raw_evidence` | ✅ existente | `evidence.ts` (`evidenceDigest`, digest/http_status/final_url) |
| proveniência por campo | ✅ existente | `NormalizedField.source`, `derivedField` |
| **`external_identity` estruturado** (shopid/itemid Shopee; item_id ML) | 🟡 PROPOSED CONTRACT CHANGE | N10 — extrator dedicado (N10-2) |
| **`normalized_marketplace` único no registry** | 🟡 PROPOSED CONTRACT CHANGE | N10 — registry aceita qualquer dialeto |
| **fonte única de whitelist** (unificar `ALLOWED_MARKETPLACE_DOMAINS` + `MARKETPLACE_HOSTS`) | 🟡 PROPOSED CONTRACT CHANGE | N10 — dedup de configuração |

Nenhum campo novo entra no `CandidateIntakeInput` do N1 nesta fase: o N10 entrega payloads compatíveis com o que o N1 já aceita.

## 11. ESTRATÉGIA DE IDENTIDADE DO PRODUTO

O N10 distingue rigorosamente dois conceitos, ambos já presentes no código:

| Conceito | Definição | Evidência |
|---|---|---|
| `external_identity` | Identificador **canônico do listing no marketplace**, extraído de forma determinística: ML = `ML[A-Z][\d]+` (item ID) da URL ou resposta; Shopee = tupla `(shopid, itemid)` da URL (`shopee.com.br/.../(\d+)/(\d+)`) | Regex existente nos dois connectors; `external_listing_id` do `RawListing` |
| `source_url` | URL concreta da fonte observada — **mutável e descartável** como chave de identidade (redirecionamentos, UTM, variações de slug mudam a URL sem mudar o produto) | `RawListing.source_url`, `validateDiscoveryUrl` resolve redirects |

As regras do N10 para identidade são: a combinação `(marketplace, external_listing_id)` é a chave de identidade (já é exatamente o `listingKeyFrom` do N1); a `source_url` é metadado de proveniência; **nenhuma identidade é inferida** — quando o extrator não consegue confirmar o ID (URL malformada, página com layout desconhecido), o campo permanece `UNKNOWN` e o listing segue registrado com `collectionFailed`/`UNKNOWN`, exatamente como o patch de proveniência do N2 já garante para títulos derivados de URL. `UNKNOWN ≠ IDENTITY_UNCERTAIN ≠ CONFIRMED`: a incerteza nunca se converte em certeza.

## 12. ESTRATÉGIA DE IDEMPOTÊNCIA

A idempotência opera em três níveis já existentes, que o N10 deve preservar e orquestrar:

1. **Nível listing (N1):** `listingKeyFrom(marketplace, external_listing_id)` — sha256 dos dois campos; o mesmo listing repetido vira `identical_duplicate` (`created` ≠ novo), e colisões com dados divergentes viram `conflict_rejected`. **Resposta à pergunta "se o mesmo produto aparecer 10 vezes, o que impede 10 candidates?": o listing_key imutável do N1** — todos os 10 reaparecimentos colidem com o primeiro registro.
2. **Nível URL:** `validateDiscoveryUrl` + digest da URL no N2; URLs variantes do mesmo listing (UTM, slug) convergem para o mesmo `external_listing_id` antes do registro — desde que o extrator N10-2 funcione.
3. **Nível ciclo (N9):** `identical_duplicate` do `startCycle` (já provado em produção).

**Resposta à pergunta "se a URL mudar mas o external_id permanecer igual, o que acontece?":** o listing_key não muda; o novo registro colide com o existente; o N1 pode atualizar metadados conforme política de colisão (`conflict_rejected` preserva a evidência anterior) — nenhum segundo candidate nasce. **Resposta à pergunta "se external_id não existir, qual fallback é permitido?":** nenhum fallback inventado — o listing entra com `external_listing_id = UNKNOWN_TOKEN` e campos derivados marcados `derived:true`; tal listing **não é elegível para progressão de funil** (o N4/N9 exige identidade), permanecendo bloqueado até que uma fonte confirme a identidade.

## 13. MODELO DE ERRO (FAIL-CLOSED)

O modelo de erro do N10 é integralmente herdado e mapeado no código:

| Falha | Tratamento | Origem |
|---|---|---|
| URL inválida / host não permitido / redirect proibido | Rejeição antes de qualquer fetch (`invalid_url`) | `validateDiscoveryUrl` + SSRF guard |
| Marketplace desconhecido | Rejeição (`marketplace_desconhecido`) | `isMarketplaceSource` |
| Identidade insuficiente | `UNKNOWN` no campo; bloqueio de progressão | `UNKNOWN_TOKEN` + derivedField |
| Resposta malformada | `COLLECTION_FAILED` | `registerCollectionFailure` |
| Timeout | `COLLECTION_FAILED` (retry único já esgotado) | `TIMEOUT_MS=15s`, `MAX_RETRIES=1` |
| Rate limit | `rate_limited` — erro operacional explícito, recuperável | `SlidingWindowRateLimiter` |
| Circuit aberto | `circuit_open` — erro operacional explícito | `CircuitBreaker` |

As invariantes absolutas permanecem: erro nunca vira candidato válido, preço inventado, título inventado, produto canônico ou affiliate link.

## 14. MODELO DE RESILIÊNCIA

Infraestrutura **existente e utilizada** em produção: `SlidingWindowRateLimiter` (janela configurável), `CircuitBreaker` (janela 60s, 3 falhas), timeout 15s por requisição, retry único, snapshot de conteúdo limitado a 8KB, máx. 5 resultados por busca. Job queue (`job_queue`) existe no repositório para o N14+ mas **permanece desligada** — o N10 não a habilita. O que seria necessário futuramente (registrado, não implementado): backoff exponencial configurável, cache de respostas de busca (TTL curto), e a migração ML para API oficial (seção 5.2).

## 15. MODELO DE SEGURANÇA

O N10 adota as regras já vigentes: **nenhum secret em log** (o discovery não possui credenciais hoje — quando a API ML for adotada, o `ProviderContext`-like só exporá `{present, expired}`); credenciais nunca em código (variáveis de ambiente injetadas em runtime, padrão N8); `raw_response` persistido somente quando necessário para auditoria, com tamanho limitado (`MAX_CONTENT_SNAPSHOT_BYTES=8_000`); SSRF guard global (`marketplace.ts`) bloqueia localhost, ranges privados e `169.254`; sanitize de texto de entrada (`sanitizeCandidateText`, truncamento a 2000 chars); e nenhuma variável de ambiente nova é criada nesta fase.

## 16. MODELO DE PROVENIÊNCIA

A proveniência é o coração do N10 e já existe em três camadas: **(1)** por campo — `NormalizedField.source ∈ {"marketplace_page", "derived", "unknown"}` + `derivedField` exclusivo para valores derivados da URL; **(2)** por coleta — `evidence_hash` (digest do conteúdo), `raw_evidence {digest, http_status, final_url}`, `collection_method`; **(3)** por candidato — `listing_key` (proveniência imutável marketplace+external_id) + `evidence_hash` no N1 + `candidateDigest` para detecção de colisão. O N10 **não cria um segundo sistema de evidences**: reutiliza `candidate_evidence` (N3) para research e `evidence_note`/`raw_evidence` para discovery, mantendo a cadeia `SIGNAL → OBSERVATION → EVIDENCE` rastreável.

## 17. INTEGRAÇÃO COM AGENTES

A auditoria do `agentRegistry` e `agentRuntime` (N16/N17) confirmou: registry de agentes, policy engine (`evaluatePolicy`, `ALLOW/DENY/REQUIRES_APPROVAL`), approval persisted, idempotência de execução e tool adapter existem — **todos com `enabled=false`** e todas as permissões negadas por padrão (princípio fail-closed). O agente natural consumidor do N10 seria um **discovery-agent** (futura capacidade de disparar descobertas a partir de triggers), mas sua habilitação exige workflow de aprovação separado e permanece fora do escopo do N10. O N10 apenas garante que qualquer consumidor futuro receba o mesmo contrato fail-closed.

## 18. FLUXO DE DADOS

```
URL/query de entrada
        │  (qualquer dialeto de marketplace)
        ▼
┌─ N10-1 ConnectorRegistry ──────────────────────────┐
│  normaliza marketplace · valida URL · SSRF guard   │
└─────────────────────┬──────────────────────────────┘
                      ▼
         N10-2 ExternalIdentity extractor
     (item_id ML | shopid+itemid Shopee; UNKNOWN se falhar)
                      ▼
     executeDiscover (N2) — connector do marketplace
   (whitelist · rate limiter · circuit breaker · timeout)
                      ▼
       CandidateNormalizer → CandidateDiscoveryPayload
                      ▼
       registerCandidate (N1) — listingKeyFrom
     created | identical_duplicate | conflict_rejected
                      ▼
       DiscoverResult (found/created/duplicates/conflicts)
                      ▼
   consumidor: N9 S1 (manual) · Telegram admin · N10-3 (fase 2)
```

## 19. DEPENDÊNCIAS

O N10 depende de: N1 (registro de candidates — estável), N2 (discovery — estável), N3 (evidence — estável), N4 (policy — estável), N9 (ciclo — consolidado). Não depende de N8 (acquisition), N6 (providers) nem de credenciais externas — discovery permanece **sem credenciais**. A dependência externa única é a acessibilidade das páginas públicas dos marketplaces (risco registrado).

## 20. RISCOS

| # | Risco | Severidade | Mitigação proposta |
|---|---|---|---|
| R1 | Fragilidade do scraping ML (parser quebra com layout; visto no ciclo A do N9) | Alta | Registrar como dívida; avaliar API oficial pública do ML (sem credenciais) em fase futura |
| R2 | Quatro dialetos de marketplace causando novos bugs de mapeamento | Média | N10-1 registry com conversores únicos (PROPOSED CONTRACT CHANGE) |
| R3 | Whitelist de hosts duplicada (`marketplace.ts` vs `discovery/types.ts`) | Média | Unificação em fonte única (PROPOSED CONTRACT CHANGE) |
| R4 | Páginas públicas Shopee/ML podem aplicar anti-bot ou mudar estrutura | Média | Fail-closed herdado (`COLLECTION_FAILED` identificável); limites conservadores já aplicados |
| R5 | External identity ausente bloqueando progressão | Baixa | Projetado: `UNKNOWN` bloqueia funil; nunca inventa |

## 21. OPEN QUESTIONS

1. **Q1 — API oficial ML:** migrar o connector ML para `https://api.mercadolibre.com/items/{id}` (leitura pública sem OAuth)? Reduz fragilidade e é juridicamente mais seguro, mas muda o modo de coleta de "página" para "API" — exige decisão sua (BLOCKER apenas se a migração for exigida antes da fase 2).
2. **Q2 — Escopo da fase 2:** o N10-3 (DiscoveryFacilitator para lotes/feeds) é desejado agora, ou a fase 2 deve primeiro consolidar N10-1/N10-2 e provar em produção com URLs avulsas?
3. **Q3 — Identidade estruturada Shopee:** persistir a tupla `(shopid, itemid)` separadamente de `external_listing_id` (hoyer um único campo string) — muda o contrato do N1 (`CandidateIntakeInput.external_listing_id`)? Ou manter encoding na string (ex.: `shopid:itemid`)?
4. **Q4 — Unificação de dialetos:** qual dialeto vira canônico global? Proposta: `MarketplaceSource` UPPER (N2) como canônico, com conversores documentados para N1 human / N8 / N9 snake.
5. **Q5 — Search como vetor de entrada:** permitir `/discover` com `mode=search` via Telegram/Rotas admin para descoberta por termo (hoje o N2 já suporta; falta expor como canal formal) — dentro ou fora do N10?

## 22. FASES DE IMPLEMENTAÇÃO PROPOSTAS

| Fase | Escopo | Critério de sucesso |
|---|---|---|
| **Fase 1 (esta)** | Design review + auditoria (concluída) | Relatório entregue |
| **Fase 2** | N10-1 (registry + normalização + fonte única de whitelist) + N10-2 (external identity extractors) + testes | Gates locais (test/tsc/build) + review seu |
| **Fase 3** | Prova viva controlada em produção: discovery real com URLs de prova, idempotência (10x mesma URL), identidade UNKNOWN bloqueada, limpeza integral | Gates + zero resíduos + sua autorização para commit/deploy |
| **Fase 4** | Publicação (commit+push+deploy) + consolidação final + N10-3 opcional (DiscoveryFacilitator) conforme decisão Q2 | Relatório final `N10 CONSOLIDADO` |

## 23. CRITÉRIOS DE ACEITAÇÃO PARA A FASE 2

A Fase 2 somente inicia após sua autorização explícita e exige: (1) registry com entrada em qualquer dialeto e saída canônica, testado; (2) extratores de identidade ML/Shopee com cobertura de URL malformada (→ UNKNOWN, sem inventar), testado; (3) unificação da whitelist sem regressão do SSRF guard; (4) 100% dos testes existentes preservados (≥862/862) + novos testes específicos; (5) `tsc --noEmit` 0 erros + `build` OK; (6) **nenhuma alteração de produção, banco, credencial, agente, job ou catálogo**; (7) diff contendo apenas arquivos N10 + nenhum secret; (8) prova de que `Discovery → Product` sem Candidate→Research→Assessment→Decision→Publication permanece estruturalmente impossível (o N10 não cria products nem publica).

---

## 14-BIS. MATRIZ OBRIGATÓRIA DE ESTADO

| Componente | Existe | Implementado | Testado local | Produção | Publicado | Planejado |
|---|---|---|---|---|---|---|
| executeDiscover (N2) | ✅ | ✅ | ✅ (suíte 862/862) | ✅ (prova N9 Fase 4) | ✅ SHA 9fbc086 | — |
| MarketplaceConnector interface | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| MercadoLivreConnector (páginas públicas) | ✅ | ✅ | ✅ | ✅ (ciclo A) | ✅ | API oficial ML (open) |
| ShopeeConnector (páginas públicas) | ✅ | ✅ | ✅ | ✅ (ciclo B) | ✅ | — |
| validateDiscoveryUrl + SSRF guard | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| CandidateNormalizer + proveniência por campo | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| SlidingWindowRateLimiter / CircuitBreaker | ✅ | ✅ | ✅ | ✅ (instanciado globalmente) | ✅ | backoff/cache (Q2) |
| registerCandidate + listingKeyFrom (N1) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| N3 evidence (KNOWN/UNKNOWN/DERIVED/COLLECTION_FAILED) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| N4 Policy Engine | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| N9 S1 → Discovery | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Acquisition API Shopee (N8) | ✅ | ✅ | ✅ | ✅ (AUTH_REQUIRED) | ✅ | Credenciais (pendente) |
| Acquisition API ML | ❌ | — | — | — | — | Open question Q1 |
| DiscoveryFacilitator (lotes/feeds) | ❌ | — | — | — | — | N10 Fase 2/4 (Q2) |
| Agentes (discovery-agent) | ✅ registry/runtime | ✅ | ✅ | ✅ (enabled=false) | ✅ | Habilitação futura separada |

## 15-BIS. MATRIZ DE MARKETPLACES

| Marketplace | Discovery | API | Scraper | Auth | Affiliate | Tests | Production | Status |
|---|---|---|---|---|---|---|---|---|
| Mercado Livre | ✅ Páginas públicas (regex item ID) | ❌ Não utilizada (API pública ML existe — Q1) | ✅ (fetch+parse) | Nenhuma | ❌ (N8 sem provider ML) | ✅ | ✅ | Funcional; fragilidade de parser (R1) |
| Shopee | ✅ Páginas públicas (regex shopid/itemid) | ✅ Endpoint BR oficial investigado (N8) — não usado em discovery | ✅ (fetch+parse) | Nenhuma (discovery) | ✅ Assinatura oficial implementada; credenciais não configuradas | ✅ | ✅ (AUTH_REQUIRED) | Discovery funcional; acquisition bloqueada por credenciais |

## 16-BIS. PROVA DE NÃO-SUBVERSÃO (DOCUMENTAL)

A arquitetura proposta **não pode** produzir `Discovery → Product` sem a cadeia completa, porque: (1) o N10 não possui nenhum caminho para `products` — nem FK, nem repository, nem rota; (2) o único mecanismo de registro é `registerCandidate` (N1), que gera `listing_key` e mantém `promoted_product_id` nulo até a cadeia N3→N4→N9→Publication executar (`promoted_at` é o único ponto de promoção, e hoje a promoção está sob `/promote` com governance N5); (3) o N9 exige `candidate_id` existente no N1 para avançar da S1 à S2 — um "produto" que pule etapas nunca terá candidate_id e o ciclo falha com `CANDIDATE_NOT_FOUND`; (4) o Decision Gate (N9) bloqueia publicação com `BLOCK_IDENTITY_UNCERTAIN`, `BLOCK_NO_ACTION`, `BLOCK_COLLECTION_FAILED` e `BLOCK_NOT_APPROVED` — nenhum caminho de bypass existe no contrato. Formalmente:

> `Discovery ≠ Affiliate Acquisition` — N10 não lê credenciais nem chama `acquisitionService`; `Discovery ≠ Publication` — N10 não toca `publicationExecutor`; `Observation ≠ Canonical Product` — N10 grava apenas `candidates`/`candidate_evidence`, nunca `products`; `Recommendation ≠ Action` — N10 não executa ações, apenas coleta e registra.

## 23-BIS. RELATÓRIO FINAL (ESTRUTURA EXIGIDA)

**N10 — FASE 1 — STATUS: READY FOR REVIEW**

1. **RESUMO:** a camada de Discovery real já existe (N2+N1); o N10 é uma camada aditiva fina (registry, identidade externa, fonte única de whitelist) que formaliza e consolida, sem substituir N1/N2/N3/N9.
2. **O QUE JÁ EXISTIA:** executeDiscover, connectors ML/Shopee públicos, validação de URL com SSRF guard, normalizer com proveniência por campo, rate limiter + circuit breaker, registro idempotente N1 com listing_key.
3. **O QUE FOI DESCOBERTO:** 4 dialetos de marketplace; whitelist duplicada; risco de scraping ML (API oficial pública não utilizada); ausência de provider ML no N8; separação Discovery/Acquisition Shopee já contratualizada no N8.
4. **MERCADO LIVRE:** discovery funcional por páginas públicas; sem API client; regex de item ID; whitelists OK; risco de fragilidade (R1); API oficial pública é open question (Q1).
5. **SHOPEE:** discovery funcional por páginas públicas (shopid/itemid); acquisition oficial BR implementada no N8 com assinatura correta, aguardando credenciais.
6. **N1/N2/N3:** contratos mapeados (CandidateIntakeInput, MarketplaceConnector, evidence fields) — todos reutilizáveis sem alteração.
7. **N8:** fronteira comprovada — discovery não acessa acquisition; publicUrl nunca é presumida affiliate URL.
8. **N9:** consumidor puro do discovery (S1); nenhuma duplicação de registro/evidence/assessment; contrato `snake→UPPER` já corrigido.
9. **ARQUITETURA PROPOSTA:** 3 unidades (registry, external identity, facilitator opcional) sobre o N2 existente.
10. **CONTRATO PROPOSTO:** adoção do MarketplaceConnector existente + 3 PROPOSED CONTRACT CHANGES (identity estruturado, normalização única, whitelist única).
11. **IDENTIDADE:** external_identity determinística (item_id / shopid+itemid) ≠ source_url; UNKNOWN sem inferência.
12. **IDEMPOTÊNCIA:** listingKeyFrom (N1) impede N candidates; URL variante converge pelo external_id; fallback de ID ausente = UNKNOWN (bloqueado, nunca inventado).
13. **FAIL-CLOSED:** modelo de erro herdado e completo (ver seção 13).
14. **PROVENIÊNCIA:** 3 camadas existentes reutilizadas (campo, coleta, candidato).
15. **SEGURANÇA:** nenhum secret em log; SSRF guard; sanitize; zero envs novas nesta fase.
16. **RESILIÊNCIA:** rate limiter + circuit breaker + timeout + retry únicos, utilizados em produção.
17. **AGENTES:** registry/runtime existem com enabled=false; discovery-agent futuro é consumidor natural, fora do escopo.
18. **DEPENDÊNCIAS:** N1/N2/N3/N4/N9 estáveis; nenhuma credencial externa.
19. **RISCOS:** 5 riscos registrados (R1-R5), nenhum BLOCKER para a fase 2.
20. **OPEN QUESTIONS:** Q1-Q5 (API ML, escopo do facilitator, encoding Shopee, dialeto canônico, search como canal).
21. **FASE 2 PROPOSTA:** registry + identity extractors + whitelist única, com critérios de aceitação (seção 23).
22. **GATES (após a implementação local):** `npm test` 881/881 (862 existentes + 19 novos N10-01→N10-19, zero falhas), `tsc --noEmit` 0 erros, `npm run build` OK, `git status` limpo exceto pelos novos arquivos do N10, zero secrets nos novos arquivos.
23. **ALTERAÇÕES REALIZADAS (apenas local, NÃO commitadas):**
```
CÓDIGO LOCAL:  5 novos arquivos (server/commercial/sourceConnector/{contracts,marketplaceNormalization,externalIdentity,connectorRegistry,sourceConnector}.ts + testes)
DATABASE:      0 alterações (nenhuma migration)
PRODUÇÃO:      0 alterações (Render permanece SHA 9fbc086)
CREDENCIAIS:   0 alterações
AGENTES:       0 alterações
JOBS:          0 alterações
COMMIT:        0
PUSH:          0
DEPLOY:        0
```

## 24. IMPLEMENTAÇÃO LOCAL REALIZADA (FASE 1)

Conforme a autorização recebida, a Fase 1 executou a implementação local descrita no design review, dentro de `server/commercial/sourceConnector/`:

| Unidade | Arquivo | O que faz |
|---|---|---|
| Contratos versionados | `contracts.ts` | `ExternalIdentity` (ITEM_ID / SHOP_ITEM / UNKNOWN), `ConnectorResult`, `ConnectorErrorResult`, `ConnectorRegistryContract`, `SOURCE_CONNECTOR_CONTRACT_VERSION = "v1"`; reexporta os contratos do N2 sem alteração |
| Normalização | `marketplaceNormalization.ts` | dialetos (snake/human/UPPER) → canônico UPPER do N2; marketplace desconhecido → `UNKNOWN` com razão (`marketplace_ausente`/`marketplace_desconhecido`) |
| Identidade externa | `externalIdentity.ts` | ML → ITEM_ID (`/p/MLB*`), Shopee → SHOP_ITEM (`shopid/itemid`); sem padrão estruturado → UNKNOWN com rationale obrigatório; URL nunca é promovida por heurística |
| Registry | `connectorRegistry.ts` | registro de connectors por marketplace; whitelist única reaproveita `MARKETPLACE_HOSTS` do N2; connector de marketplace sem whitelist é rejeitado |
| Source Connector | `sourceConnector.ts` | `discoverFromSource` — valida URL → normaliza marketplace → resolve connector → extrai identidade → **delega integralmente ao `executeDiscover` do N2**; sem `candidate_id` real → `ok:false` com `collection_failed` ou `candidate_not_created`; erro do delegate → `discovery_delegate_falhou`; override `discoverFn` test-only injetável |

**Regras de fronteira provadas pelos 19 testes (N10-01→N10-19):** o N10 não cria candidates diretamente, não inventa candidate_id, não gera affiliate URL, não lê nenhuma credencial de afiliado, não acessa products, falha fechado em toda entrada inválida, preserva `collectionFailed` e `external_identity`, e mantém idempotência determinística da identidade.

**Correção de contrato aplicada durante os testes:** o primeiro rascunho do `discoverFromSource` reportava `ok:true` mesmo sem `candidate_id` criado — corrigido para fail-closed obrigatório (coerente com o princípio `CANDIDATE != FACT CANÔNICO`).

---
**N10 — FASE 1 — STATUS: READY FOR REVIEW**
Aguardando sua autorização para a Fase 2 (prova viva controlada local/produção conforme escopo autorizado, com limpeza integral e sem qualquer alteração de catálogo, produção permanente, credenciais, agentes, scheduler ou jobs).
