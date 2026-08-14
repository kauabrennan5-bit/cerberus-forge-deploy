# AUDIT_ARCHITECTURE.md — Cerberus Finds Archive

## 1. Arquitetura Atual
O sistema **Cerberus Finds Archive** é composto por três pilares principais:
1. **Frontend (Vitrine Pública / SPA)**: Desenvolvido em React 19, Vite e Tailwind CSS v4, servido de forma estática pelo Render Static Site. A vitrine carrega exclusivamente a projeção relativa `/data/products.json`; o backend é utilizado por operações administrativas e registro de cliques de afiliado.
2. **Backend (Servidor de Automação, API e Bot do Telegram)**: Desenvolvido em Node.js com Express e TypeScript (compilado via `esbuild`), responsável por:
   - Executar o bot do Telegram (webhooks/polling) para curadoria, publicação, listagem, edição, remoção e relatórios de analytics.
   - Fornecer endpoints REST (`/api/products`, `/api/track-click`, `/api/meta-capi`, `/api/admin/*`).
   - Sincronizar o catálogo com o Supabase e disparar a atualização do arquivo estático no GitHub (`public/data/products.json`).
3. **Fonte de Verdade Canônica (Supabase - PostgreSQL)**:
   - `public.products`: Armazena todos os dados dos produtos.
   - `public.product_clicks`: Armazena todos os eventos de clique de afiliado com UTMs, identificadores de tráfego e metadados.

---

## 2. Componentes Principais
- **`server.ts`**: Ponto de entrada do servidor Node.js/Express, gerencia rotas REST, CORS, autenticação administrativa (`requireAdminAuth` com bcrypt e falha fechada), webhooks e inicialização do bot.
- **`server/services/telegramBot.ts`**: Roteador do Telegram, painel administrativo por namespaces (`admin_*`, `products_*`, `analytics_*`), comandos `/start`, `/admin`, `/listar`, `/editar`, `/remover`, `/categorias`, `/analytics`.
- **`server/repositories/productsRepository.ts`**: Camada de persistência Supabase para produtos e registro estrito de cliques, sem fallback local de analytics.
- **`server/services/catalogSync.ts` & `githubCatalogSync.ts`**: Sincronizadores que geram `public/data/products.json`, realizam o commit/push via Octokit para o repositório GitHub (`kauabrennan5-bit/cerberus-forge-deploy`), acionam Deploy Hooks do Render e validam a propagação do arquivo.
- **`scripts/generate-static-catalog.js`**: Script executado no `npm run build` para popular `public/data/products.json`.
- **`src/services/api.ts`**: Cliente frontend para requisições de produtos, rastreamento de cliques e eventos CAPI do Meta.

---

## 3. Fluxos de Dados Ponta a Ponta

### A) Cadastro de Produto
1. O administrador envia um link de produto (Shopee / Mercado Livre) para o Bot do Telegram.
2. O bot processa a URL por meio do scraper e da IA (Gemini), gerando uma revisão pendente (`telegram_reviews.json` / Supabase).
3. O administrador clica em **"Confirmar & Publicar"**.
4. O backend insere o produto na tabela `public.products` do Supabase.
5. O serviço de sincronização (`catalogSync`) gera o arquivo `public/data/products.json`.
6. O sincronizador faz o commit automático do JSON no repositório GitHub (`kauabrennan5-bit/cerberus-forge-deploy`) na branch `main`.
7. O Render detecta o commit no GitHub, executa o build estático e publica o site atualizado.

### B) Clique de Afiliado (Tracking)
1. O visitante clica no botão de compra de um produto na vitrine pública (`cerberusfinds.com`).
2. O frontend executa `trackProductClickApi()`, enviando um `POST` para `/api/track-click` com ID do produto, URL de destino, UTMs, `fbclid`, `gclid`, `ttclid`, IP e User-Agent.
3. O backend valida o produto e grava o registro na tabela `public.product_clicks` do Supabase.
4. O Telegram (via comando `/analytics`) consulta diretamente `public.product_clicks` no Supabase para exibir os relatórios consolidados.

---

## 4. Fontes de Verdade
- **Produtos**: Tabela `public.products` no Supabase (única fonte de verdade para CRUD e listagens).
- **Cliques e Analytics**: Tabela `public.product_clicks` no Supabase (nenhum clique é gravado em arquivos locais).
- **Catálogo Estático Público**: Arquivo `public/data/products.json` gerado durante o build e atualizado via sincronização com o GitHub.
- **Estado de Revisão do Telegram**: Armazenado em `data/telegram_reviews.json` / `data/telegram_user_states.json` com suporte a fallback local.

---

## 5. Integrações Externas
- **Telegram Bot API**: Comunicação bidirecional para administração do acervo.
- **Supabase**: Banco de dados relacional principal.
- **GitHub API (Octokit)**: Sincronização automática do catálogo estático na branch `main`.
- **Meta Conversions API (CAPI)**: Envio de eventos server-side para deduplicação de anúncios.
- **Google Analytics Data API**: Consulta de relatórios GA4 diretamente pelo backend.

---

## 6. Mapa de Riscos (Classificação)
- 🟢 **BAIXO**: O build pode consultar a API do backend somente como leitura alternativa da mesma fonte canônica quando não possui credenciais do Supabase; nunca lê JSON local como fonte concorrente.
- 🟡 **MÉDIO**: Dependência de conectividade com a API do GitHub e estabilidade do Render Web Service no plano gratuito (possibilidade de cold start de até 60s se inativo).
- 🔴 **CRÍTICO**: A referência histórica de token Telegram foi removida da documentação versionada e o token foi rotacionado administrativamente. Segredos permanecem exclusivamente no ambiente server-side.
