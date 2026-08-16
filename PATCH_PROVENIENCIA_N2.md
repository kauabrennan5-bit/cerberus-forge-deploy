# Bloco N2 — Patch de Contrato: Proveniência de Falha de Coleta

**Autor:** Manus AI | **Data:** 16 de agosto de 2026 | **Status:** READY FOR REVIEW (aguardando autorização de commit/push)

## 1. Comportamento Anterior

A implementação original do N2 dependia exclusivamente do scraper existente (`fetchProductDataFromUrl`), que é *fail-soft*: quando o fetch da página falha (bloqueio 403, timeout, erro de rede), ele engole a exceção, deriva o título a partir do slug da URL (`extractTitleFromUrl`) e retorna preço/imagens vazios **sem lançar erro e sem indicar que a página nunca foi lida**. O contrato do N2 construía o `RawListing` direto dessa extração e, como o corpo retornado pelo scraper nunca fica vazio (o relatório textual sempre inclui o título derivado), **nenhuma falha de coleta era identificável** — o resultado era tratado como se fosse uma observação real do marketplace, com título nunca confirmado gravado no Registry N1.

## 2. Comportamento Corrigido

O patch introduz três camadas de proteção de proveniência:

| Camada | Mudança | Consequência |
|---|---|---|
| `types.ts` | `RawListing` ganha `fetch_failed: boolean` e `fetch_error?: string`; `RawListingField` ganha flag opcional `derived` | A falha de coleta é agora parte formal do contrato, não um efeito colateral |
| `fetchShared.ts` | `fetchListingPage` faz o fetch **diretamente** (com validação de status e redirect whitelist), tratanto `status >= 400` como `http_error`, corpo vazio como `no_content_read` e erro de rede como `fetch_failed`; o HTML coletado é passado ao scraper via `rawTextOverride` | Falhas de coleta são detectadas na origem (status/timeout), nunca mascaradas pelo fail-soft do scraper; sem página lida não há extração e não há título derivado como observação |
| `fetchShared.ts` + `normalizer.ts` | Título derivado do slug é marcado como `derived: true`; o normalizador mapeia `derived` para `source: "url_slug"`, `unknown` para `source: "unknown"` e dados da página para `source: "marketplace_page"` | Dado derivado da URL nunca é tratado como `marketplace_title` confirmado |
| `discover.ts` | `executeDiscover` registra **tentativas de coleta falhadas** no N1 com `title = null`, todos os campos UNKNOWN, `collection_failed: true` e `evidence_note: "COLLECTION_FAILED (...)"`; apenas falhas operacionais controladas (`rate_limited`, `circuit_open`) retornam erro sem registro | Toda tentativa de descoberta deixa audit trail; falha identificável permanece identificável |
| `discover.ts` | Título com `source: "url_slug"` **não é enviado** ao Registry N1 (entra como `null`) | N1 nunca recebe título não confirmado como título do candidato |

Nenhum valor foi inventado para preencher campos ausentes: preço e imagens em falha permanecem `UNKNOWN`, e o título derivado, quando presente em diagnóstico, é explicitamente marcado como derivado da URL.

## 3. Arquivos Alterados

| Arquivo | Alteração |
|---|---|
| `server/commercial/discovery/types.ts` | `fetch_failed`, `fetch_error`, `derived` nos tipos; helper `derivedField()` |
| `server/commercial/discovery/fetchShared.ts` | `buildRawListing` com proveniência de falha; `isUrlDerivedTitle()`; reescrita de `fetchListingPage` com fetch próprio validado |
| `server/commercial/discovery/normalizer.ts` | `n<T>()` e `titleSource()` mapeiam `derived → "url_slug"`, `unknown → "unknown"` |
| `server/commercial/discovery/discover.ts` | `registerCollectionFailure()` para tentativas falhadas; bloqueio de título `url_slug` no registro N1; `collection_failed` no metadata |
| `tests/discovery.test.ts` | 6 novos testes U-A→U-F |

Nenhuma alteração em `products`, catálogo canônico, N1 (schema/rotas), job queue, scheduler, agentes, executores, publicação ou Telegram lifecycle — confirmado por diff e pelas provas de escopo existentes (H).

## 4. Testes Adicionados

A suíte de proveniência **U** prova os seis requisitos: fetch bem-sucedido permite título real da página (U-A); título derivado da URL nunca aparece como confirmado (U-B); preço permanece UNKNOWN em falha (U-C); falha de fetch permanece identificável via `fetch_error`/`evidence_note` (U-D); `CANDIDATE != FACT CANÔNICO` com tentativa falhada — N1 recebe `title = ""` (null sanitizado), `collection_failed: true`, `source: "unknown"` (U-E); e nenhum produto canônico é criado mesmo com coleta falha (U-F).

## 5. Resultado dos Gates

| Gate | Resultado |
|---|---|
| `npm test` (tsx --test) | **636/636 passando** (35 N2 + 6 de proveniência) |
| `tsc --noEmit` | OK |
| `npm run build` (esbuild) | OK |

## 6. Decisão Arquitetural que Permanece Aberta

Durante o patch foi necessário abandonar a dependência exclusiva do scraper no caminho de `fetchListing`, pois seu fail-soft escondia falhas de coleta de forma indetectável. A decisão tomada — fetch próprio com validação de status/redirect no módulo N2, com o HTML coletado alimentando o pipeline de extração via `rawTextOverride` — é o ajuste mínimo que resolve o problema sem reestruturar o N2 nem modificar o scraper existente. Caso o fetch próprio venha a divergir do comportamento do scraper (ex: redirects em páginas de anúncio), será preciso rever essa fronteira em um bloco futuro. Não foi introduzida qualquer mudança arquitetural maior; o patch permanece estritamente aditivo/locais ao N2.

## 7. Próximos Passos (após autorização)

Após a autorização de commit, serão executadas as Fases 4–8 do protocolo N2: commit único + push para main, deploy automático do Render, prova controlada em produção (busca limitada real + prova de idempotência + limpeza integral com verificação de zero resíduos), gates finais, validação de `/health`/SHA/paridade do catálogo e relatório final com o ZIP do código atualizado.
