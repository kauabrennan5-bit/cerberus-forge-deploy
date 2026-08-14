# Cerberus Finds Archive — Architecture Contract

**Repositório:** `kauabrennan5-bit/cerberus-forge-deploy`  
**Branch de código e produção:** `main`  
**Escopo:** Bloco 2 — Arquitetura e Fonte Única de Verdade

Este documento formaliza os contratos observados e consolidados no código atual. Ele não cria o Cerberus Operator e não substitui o schema do Supabase. Quando um campo de banco não está presente no modelo compartilhado de TypeScript, ele é identificado como campo de armazenamento, não como campo inventado no contrato de aplicação.

## 1. Fontes de verdade

| Domínio | Fonte canônica | Projeções ou consumidores | Regra |
|---|---|---|---|
| Produtos | `public.products` no Supabase | `productsRepository`, API, Telegram e `public/data/products.json` | Nenhum arquivo local pode substituir a tabela para leitura ou escrita de produtos. |
| Cliques | `public.product_clicks` no Supabase | `/api/track-click` e analytics do Telegram | Falha de insert retorna erro; não há JSON local de cliques. |
| Código | GitHub, repositório oficial, branch `main` | Render e cópias de trabalho | Commits de produção devem ser verificáveis por SHA. |
| Deploy | Render conectado à branch `main` | Web Service, Static Site e health checks | O commit implantado deve ser identificado no painel de deploy. |
| Catálogo público | `public/data/products.json` | Static Site e frontend público | É uma projeção/cache derivada de `public.products`, nunca uma fonte de verdade. |
| Estado transitório do Telegram | `telegram_pending_reviews`/`telegram_user_states`, com arquivos locais de sessão existentes | Fluxos de revisão e estado de conversa | Esse estado não é catálogo e não deve ser usado para listar produtos ou analytics. |

## 2. Contrato de produto

O modelo compartilhado em `src/types.ts` usa os seguintes campos reais:

| Campo | Obrigatório no modelo de aplicação | Papel |
|---|---:|---|
| `id` | Sim | Identidade canônica do produto após persistência. |
| `ref` | Não | Identificador operacional exibido no Telegram. |
| `slug` | Não | Identidade de URL; derivado do título quando necessário. |
| `produto` | Sim | Nome/título do produto. |
| `descricao` | Não | Descrição pública. |
| `preco` | Sim | Preço numérico em BRL no domínio atual. |
| `imagens` | Sim | Lista de URLs ou dados de imagem aceitos pelo catálogo atual. |
| `link` | Sim | URL de compra/afiliado; deve ser HTTP(S) válida. |
| `categoria` | Sim | Categoria operacional e pública. |
| `ativo` | Sim | Estado de ativação; `false` representa produto pausado. |
| `status` | Não | Estado de publicação, incluindo `pending` e `published`. |
| `destaque` | Sim | Indicador operacional de destaque. |
| `createdBy` | Não | Origem administrativa da criação. |
| `paginaPonteUrl` | Não | URL opcional da página intermediária. |
| `rawRowIndex` | Não | Metadado auxiliar de importação quando presente. |

`marketplace`, `created_at` e `updated_at` aparecem como dados de armazenamento ou de projeções específicas, mas não fazem parte do tipo compartilhado principal. O código atual pode derivar marketplace de dados de ingestão ou de campos auxiliares; essa derivação não deve ser tratada como uma nova coluna canônica sem alteração explícita do schema.

Os campos obrigatórios para uma projeção pública são, adicionalmente, título não vazio, preço maior que zero, link de compra válido e estado publicado/ativo. O exportador exclui registros sem esses requisitos para evitar cards inválidos, mas essa filtragem deve ser contabilizada como regra de projeção, não como exclusão da fonte canônica.

## 3. Contrato de identidade

A regra de relacionamento é:

> `product_id`/`id` é a identidade canônica persistida; `slug` é a identidade de URL; `ref` é a identidade administrativa.

O clique deve guardar `product_id` e, quando disponível, `product_slug`. O Telegram pode receber `id`, `slug` ou `ref` como entrada operacional, mas resolve a entrada contra `public.products` antes de consultar ou alterar o registro. O ranking e os relatórios agrupam cliques por `product_clicks.product_id`, nunca por nome de produto.

Durante a ingestão, `productAutomation.ts` normaliza a URL, extrai identificadores de marketplace e procura duplicidade por URL normalizada, ID de marketplace, slug ou título. Depois da criação, o `id` persistido é a referência estável entre Supabase, catálogo exportado, URL, clique, analytics e Telegram.

## 4. Contrato de cliques e HTTP

O fluxo canônico é:

```text
Site → POST /api/track-click → productsRepository.recordProductClick()
     → public.product_clicks → analytics do backend/Telegram
```

O endpoint recebe `productId`, `productSlug`, `productName`, `productPrice`, UTMs, `fbclid`, `gclid`, `ttclid`, `referrer` e `landingPage`. O backend resolve o produto no Supabase antes de gravar, usa o nome/preço/slug verificados quando disponíveis e acrescenta User-Agent e endereço de origem no lado do servidor.

A tabela `public.product_clicks` é a única persistência analítica. `recordProductClick()` exige Supabase e propaga falhas de configuração, schema ou insert. Não existe fallback para `data/clicks.json`, memória ou mock.

| Situação | Resposta esperada |
|---|---|
| `productId` ausente | `400` com erro de validação. |
| Produto inválido ou falha inesperada de resolução | `500` com erro interno sem revelar credenciais. |
| Falha de configuração, conexão, schema ou insert em `public.product_clicks` | `503` com código `ANALYTICS_PERSISTENCE_ERROR`. |
| Insert concluído | `200` com `success: true`. |

## 5. Contrato de analytics

Analytics combina exclusivamente `public.products` e `public.product_clicks`. As consultas existentes fornecem:

- total de produtos, ativos e pausados;
- cliques de hoje, últimos 7 dias, últimos 30 dias e total;
- ranking por `product_id` e período;
- detalhes por produto;
- contagem por marketplace quando o dado estiver disponível;
- última data de clique;
- última origem `utm_source`, ou `Não identificada` quando ausente.

Nenhum relatório pode usar `pending_reviews`, `telegram_reviews.json`, `data/products.json`, dados fictícios ou uma contagem inferida de nomes como fonte analítica. Caso o Supabase não esteja disponível, o relatório deve falhar explicitamente.

## 6. Contrato do catálogo

O pipeline de projeção é:

```text
public.products
      ↓
productsRepository.getProducts()
      ↓
exportStaticProductsJson()
      ↓
public/data/products.json
      ↓
GitHub / main
      ↓
Render Static Site
      ↓
/data/products.json no domínio público
```

O backend gera o JSON durante sincronizações de publicação/edição/remoção/categoria. O build também pode gerar a projeção usando diretamente o Supabase ou, quando o build não possui credenciais do banco, consultando `/api/products`, que é apenas outra leitura da mesma fonte canônica. O build não pode ler `data/products.json` como fallback e não pode escrever um array vazio para mascarar falha de leitura.

A vitrine pública carrega exclusivamente `/data/products.json`. Os endpoints do backend permanecem destinados a operações administrativas e tracking, não à renderização do catálogo público.

A identidade e o estado devem ser comparados, não somente a quantidade. Para uma projeção pública válida, devem ser comparados `id`, `ref` quando presente, `slug`, título, preço, categoria, link, `ativo` e `status` segundo as regras de exportação. Registros pausados, pendentes, inválidos ou sem link não são publicados, mas continuam pertencendo à fonte canônica e devem aparecer como excluídos por regra, nunca como desaparecidos silenciosamente.

## 7. Detecção de divergência

As invariantes operacionais são:

```text
IDs públicos ⊆ IDs canônicos
IDs publicados = projeção determinística dos IDs canônicos válidos/ativos/publicados
COUNT(projeção JSON) = COUNT(JSON público servido) após o mesmo commit
SHA/commit do JSON sincronizado = SHA/commit registrado no GitHub/main
```

Uma verificação futura deve comparar, no mínimo, quantidade, conjunto de IDs, conjunto de `ref`, slugs, status, links e uma versão do artefato. A comparação deve distinguir três estados: fonte canônica, projeção gerada localmente e projeção efetivamente servida pelo Static Site.

## 8. Versionamento do catálogo

A estratégia mínima recomendada é usar o SHA do commit que contém `public/data/products.json` como versão do catálogo. O SHA é verificável no GitHub e vincula o JSON ao deploy do Render. Um checksum adicional do conteúdo pode ser calculado em auditorias futuras, mas não é necessário para o contrato atual.

## 9. Contrato do Telegram

O Telegram é uma interface administrativa do backend:

```text
Telegram → backend → Supabase
```

`/listar`, edição, remoção, categorias, status e analytics consultam ou alteram o Supabase através dos repositories. A paginação é somente UI: 8 produtos continuam sendo 8 produtos, mesmo quando a página mostra 5 e a seguinte mostra 3. Estados de revisão e conversação podem ser transitórios, mas não são catálogo paralelo.

Toda alteração de produto ou categoria deve persistir primeiro na fonte canônica e só então gerar a projeção. Se o commit derivado no GitHub falhar, a operação não deve responder como se a publicação estivesse completa; o erro deve ser explicitamente reportado ao administrador.

## 10. Responsabilidades do backend

O backend concentra regras de negócio, validação de URLs, deduplicação, acesso privilegiado ao Supabase, tracking, analytics, Telegram, sincronização, automação e integração com GitHub. O frontend é responsável por apresentação, navegação, leitura da projeção pública e envio de eventos/ações autorizadas; não é fonte de verdade.

## 11. Política global de erros

| Classe | Código | Comportamento |
|---|---:|---|
| Validação de entrada | `400` | Rejeitar sem alterar o banco. |
| Ausência de autenticação/autorização | `401`/`403` | Rejeitar sem executar operação administrativa. |
| Registro não encontrado | `404` | Informar que o recurso não existe. |
| Dependência indisponível ou falha de persistência | `503` | Não mascarar; informar indisponibilidade. |
| Erro interno inesperado | `500` | Registrar diagnóstico server-side sem revelar secrets. |

Repositórios não devem converter indisponibilidade do Supabase em `[]`, `null` ou `true` de sucesso. O exportador não deve converter exceção em `products.json` vazio.

## 12. Política de fallbacks

| Fallback | Decisão |
|---|---|
| `data/clicks.json` | Removido; analytics é exclusivamente Supabase. |
| `data/products.json` | Removido como fonte concorrente; o catálogo usa `public/data/products.json` como projeção pública. |
| API do backend durante build sem credenciais Supabase | Mantido como leitura operacional da mesma fonte `public.products`, com falha explícita se também indisponível. |
| Arquivos locais de revisão/estado Telegram | Mantidos somente para estado transitório, não para produtos ou analytics; devem ser tratados como fallback operacional de sessão. |
| Deploy Hook quando commit GitHub falha | Removido do fluxo de sincronização canônico; um deploy sem commit não substitui o código/artefato versionado. |

Um fallback permitido nunca pode fazer o sistema parecer saudável quando a fonte canônica está indisponível.

## 13. Contrato de deploy

```text
GitHub/main → Render build → artefato → produção
```

O build executa `node scripts/generate-static-catalog.js`, `vite build` e `esbuild server.ts ... --outfile=dist/server.cjs`. O resultado deve registrar o SHA no GitHub e o Render deve mostrar o mesmo commit como deployado. Um health check deve validar, no mínimo, o servidor, `/api/products` para operações de backend e `/data/products.json` no Static Site.

## 14. Segurança

A Service Role do Supabase, `GITHUB_TOKEN`, tokens do Telegram, credenciais GA4, Meta Access Token e senha administrativa são exclusivamente server-side. Não devem aparecer no frontend, no JSON público, no Telegram, nos logs ou no repositório. O frontend não recebe `SUPABASE_SERVICE_ROLE_KEY`. Rotas administrativas usam `requireAdminAuth` e o middleware é fail-closed quando `ADMIN_PASSWORD` não está configurada.

## 15. System Invariants

1. Supabase `public.products` é a fonte de verdade dos produtos.
2. Supabase `public.product_clicks` é a fonte de verdade dos cliques.
3. `public/data/products.json` é derivado e versionado, nunca canônico.
4. Telegram não mantém catálogo independente.
5. Analytics não usa dados locais, mocks ou revisões pendentes.
6. Falha de persistência não pode ser mascarada.
7. Código de produção corresponde à branch `main`.
8. O catálogo publicado corresponde à projeção determinística da fonte canônica.
9. `id` permanece a identidade estável entre componentes.
10. `slug` serve para URL e `ref` para administração; nenhum substitui silenciosamente o `id`.
11. Produtos excluídos da projeção devem ser explicáveis por regra de status/validade.
12. Toda alteração de catálogo precisa de exportação e sincronização verificáveis.
13. Um erro no GitHub/Render não pode ser respondido como publicação concluída.
14. Um erro do Supabase não pode ser convertido em lista vazia saudável.
15. Toda divergência de quantidade, identidade ou versão deve ser detectável.

## 16. Alterações implementadas neste bloco

Foram aplicadas somente alterações necessárias para compatibilizar os contratos:

- remoção da leitura de `data/products.json` pelo build;
- falha explícita do build quando Supabase e a API operacional estão indisponíveis;
- remoção da cópia local de produtos do repository;
- falha explícita quando exportação ou sincronização GitHub não conclui;
- remoção do fallback de Deploy Hook após falha do commit canônico;
- operações de categoria fail-closed;
- frontend público carregando exclusivamente `/data/products.json`;
- criação deste contrato arquitetural.

O Cerberus Operator não foi implementado.
