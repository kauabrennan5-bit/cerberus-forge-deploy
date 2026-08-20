# INFRA-03 — Shopee → candidate_evidence
## Fase 2 — Implementação local da ponte oficial

**Status:** READY FOR REVIEW — implementação local concluída; prova real e produção não executadas.

**PROOF_RUN_ID:** INFRA03_PHASE2_20260820T001231Z

**SHA antes/depois:** `44a31d687ae06d2398e6651ad1009e3acfbeefbd`

## 1. Escopo executado

A Fase 2 implementou somente uma ponte local e isolada entre o cliente oficial Shopee já existente e um payload de evidência consumível pelo N13. A ponte não decide curadoria, não cria candidate, não calcula score comercial, não cria autorização N15 e não chama o executor N16.

A implementação não realiza persistência automática. Ela retorna um contrato explícito de sucesso ou falha para que uma fase posterior, caso autorizada, conecte a saída ao fluxo de evidência com as mesmas autoridades e invariantes do N3. Nenhuma chamada real à Shopee foi executada nesta fase.

## 2. Arquivos alterados e criados

Foram alterados apenas os arquivos necessários para transportar o status HTTP observado pelo cliente já existente e para criar o namespace isolado da ponte:

- `server/commercial/affiliate/shopeeClientContracts.ts`
- `server/commercial/affiliate/shopeeApiClient.ts`
- `server/commercial/sources/shopee/contracts.ts`
- `server/commercial/sources/shopee/adapter.ts`
- `server/commercial/sources/shopee/fixtures.ts`
- `tests/shopeeEvidenceBridge.test.ts`
- `docs/infra03_phase2_report.md`

A alteração no cliente existente é mínima: `httpStatus` agora acompanha resultados de lookup e erros catalogados, sem registrar corpo de resposta, headers, assinatura, App Secret ou qualquer credencial.

Não foram alterados `research.ts`, `candidateEvidenceRepository.ts`, rotas de descoberta, N13, N14, N15, N16, N17, catálogo, scheduler, agentes, Telegram ou job queue.

## 3. Contrato da ponte

O contrato público está em `server/commercial/sources/shopee/contracts.ts`.

A fonte é declarada como:

- `source_type=api`;
- `collection_method=API`;
- `marketplace=SHOPEE`;
- `endpoint=affiliate_graphql`;
- `operation=productOfferV2`.

O request exige `candidate_id`, `research_id`, `item_id` e `source_url`. `shop_id` é opcional na entrada porque a resolução oficial pode ser dirigida pelo item, mas, quando fornecido, deve ser confirmado exatamente na resposta.

O adapter aceita somente uma URL HTTPS de domínio Shopee permitido e somente identificadores numéricos com até 20 dígitos. Qualquer contexto inválido retorna `BLOCKED` antes de chamar o cliente.

## 4. Match de identidade e evidência

A ponte reutiliza o `lookupProduct` do cliente oficial Shopee. O resultado só é promovido a `SUCCESS` quando o cliente retorna `status=found`, o `itemId` retornado é numérico, coincide exatamente com o `item_id` solicitado e, quando houve `shop_id` na solicitação, o `shopId` retornado também coincide exatamente.

Qualquer mismatch, identificador inválido, produto não encontrado ou tupla não elegível retorna `BLOCKED`. O adapter nunca substitui a identidade recebida por nome, URL, slug, título ou qualquer inferência.

Em `SUCCESS`, a ponte promove somente campos efetivamente observados pelo resultado do cliente:

- `title` recebe o nome retornado quando não vazio;
- `price` recebe `priceMinorUnits` quando numérico e finito;
- `product_url` recebe somente `productLink` retornado pela fonte;
- `images`, `seller`, `rating`, `review_count`, `availability` e `category` permanecem `UNKNOWN`/nulos nesta ponte porque não foram observados pelo contrato do lookup.

Cada campo recebe seu próprio `field_state`, `quality`, `evidence_hash`, `observed_at`, `source_url`, método de coleta e nota explicativa. O payload geral não transforma campos desconhecidos em fatos.

## 5. Proveniência e digest

A proveniência inclui `source_type`, `collection_method`, marketplace, `external_listing_id`, `shop_id`, `observed_at`, `http_status`, `field_state`, endpoint lógico e operação.

O `response_digest` é SHA-256 determinístico de uma representação canônica contendo somente dados observacionais seguros: marketplace, operação, IDs solicitados e retornados, nome, preço, product link e status HTTP. Secrets, headers, authorization, payload assinado e respostas brutas não entram no digest e não são retornados pela ponte.

Cada campo também recebe hash derivado do item, loja, nome do campo, valor observado, URL de origem e digest da resposta. O mesmo resultado observável produz o mesmo digest em chamadas repetidas.

## 6. Estados fail-closed

Os estados fechados implementados são:

- `SUCCESS`: match oficial exato e resposta válida;
- `BLOCKED`: request inválido, identidade divergente, tupla ausente, item não encontrado ou item não elegível;
- `COLLECTION_FAILED`: erro de autenticação, erro GraphQL, erro de rede, timeout, resposta inválida, exceção do cliente ou qualquer erro não catalogado.

Em `BLOCKED` e `COLLECTION_FAILED`, `evidence=null` e `response_digest=null`. O status HTTP observado é preservado quando existe, mas não transforma uma resposta de erro em evidência.

O cliente oficial reutilizado mantém os erros catalogados, a assinatura existente, a operação `productOfferV2`, o transporte injetável e a política de retry já estabelecida. O teste adicional confirma que HTTP 200 é transportado como observação e que HTTP 401 permanece erro de autenticação sem resultado de produto.

## 7. Fixtures e testes

As fixtures estão explicitamente marcadas como `FIXTURE ONLY — NOT PRODUCTION`. Nenhuma fixture é usada como observação real, não contém credencial e não realiza rede.

A suíte específica da ponte possui nove testes e cobre:

- sucesso com provenance API e promoção apenas de título/preço observados;
- digest determinístico;
- mismatch de item retornado;
- ausência de nó exato;
- falha de autenticação catalogada;
- identidade de request inválida antes da chamada ao cliente;
- exceção inesperada do cliente;
- transporte de HTTP 200 pelo cliente reutilizado;
- transporte de HTTP 401 como erro fail-closed.

## 8. Gates executados

- suíte específica: `9/9 PASS`;
- suíte completa: `1350/1350 PASS`;
- `npx tsc --noEmit`: `PASS`, zero erros;
- `npm run build`: `PASS`;
- `git diff --check`: `PASS`;
- auditoria de isolamento: `PASS`, sem referências downstream nos novos arquivos;
- secret scan dos arquivos do INFRA-03: `PASS`, nenhum padrão de segredo real encontrado.

O build atualizou somente artefatos derivados não versionados; `public/data/products.json` permaneceu sem alteração no working tree. O catálogo consultado pelo build permaneceu com 13 produtos.

A suíte completa emite avisos preexistentes relacionados a variáveis locais ausentes do Supabase e à chave Gemini durante testes que já dependem dessas integrações. Esses avisos não causaram falha, não foram introduzidos pela ponte e nenhum valor secreto foi impresso.

## 9. Baseline pós-gates

A consulta somente leitura do Supabase confirmou:

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

A ponte não persiste dados automaticamente; portanto, não houve resíduos para limpar.

## 10. Isolamento e governança

N13, N14, N15, N16 e N17 não foram chamados. Nenhum PASS N13, score N14, APPROVED N15 ou publicação N16 foi criado. O catálogo canônico, candidates, candidate_evidence, candidate_assessment, affiliate_links, job_queue, commercial_cycles e publication_executions não foram alterados.

Nenhuma rota produtiva foi registrada. Nenhuma credencial Shopee foi configurada, lida em valor ou exposta. Nenhum commit, push ou deploy foi executado.

O working tree contém outros relatórios e artefatos não relacionados de fases anteriores. Eles permanecem fora do escopo desta Fase 2 e não foram consolidados.

## 11. Limitações e pendências

A integração real Shopee continua não comprovada nesta fase. Permanecem dependências externas sobre a presença legítima de App ID/App Secret no ambiente autorizado, validade da assinatura, permissões de conta, disponibilidade da operação oficial, limites, resposta real e eventual confirmação de campos adicionais.

A ponte ainda não está conectada a `research.ts` nem ao repository de `candidate_evidence`. Essa integração deve ser uma fase separada, com contrato aprovado, prova controlada, cleanup e gates próprios. A decisão N13 deve continuar fora deste adapter.

A documentação pública acessível da Shopee não foi suficiente para confirmar independentemente todos os limites e permissões operacionais. O código existente e a prova histórica D-SHOPEE-1 foram tratados como contexto interno do projeto, não como substituto de uma nova chamada real nesta fase.

## 12. Decisão de parada

A Fase 2 está concluída em `READY FOR REVIEW`. O próximo passo, se desejado, é uma Fase 3 separada para prova real controlada somente com credenciais legítimas já configuradas e autorização explícita. Não iniciar N17, não conectar a ponte ao N13 e não fazer commit, push ou deploy sem autorização específica.

## Referências

[1]: https://affiliate.shopee.com.br/open_api — Portal oficial da Shopee Open API consultado para separar o portal oficial de materiais auxiliares.

[2]: https://open-api.affiliate.shopee.com.br/graphql — Endpoint oficial BR configurado pelo cliente Shopee existente; nenhuma chamada real foi executada nesta fase.

[3]: https://www.affiliateshopee.com.br/documentacao — Material consultado como referência auxiliar; não foi tratado como autoridade normativa porque não se apresentou como documentação oficial confirmada.

[4]: https://github.com/kauabrennan5-bit/cerberus-forge-deploy — Repositório selecionado do Cerberus Forge, usado somente para auditoria e validação local nesta fase.
