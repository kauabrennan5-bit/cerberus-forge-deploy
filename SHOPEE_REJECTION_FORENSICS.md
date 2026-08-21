# Investigação Forense — Rejeição Shopee e Replacement de Candidatos

## Evidência inicial de produção

Em 21/08/2026, a página autenticada de logs do Render mostrou que o Web Service recebeu e autorizou os comandos `/shopee` do chat administrativo. A cadeia de log observada foi: `update_received` → `admin_authorized` → `command=/shopee` → `DDG Search` com `ddg_bot_challenge` → fallback Gemini Grounding → `Gemini Discovery` com **1 candidato** → respostas Telegram com `response_success=true`.

Esta sequência prova que o bot, o webhook e o envio de mensagens continuam operacionais. Ela também revela que a descoberta por termo está fornecendo somente um candidato após o desafio do DDG, insuficiente para um pedido de cinco itens elegíveis. Nenhuma evidência observada nesta etapa demonstra que um filtro de governança N13–N17 rejeitou candidatos: o caminho `/shopee` atual realiza aquisição Affiliate, scraper, identidade, `PendingReview` e card antes de qualquer avaliação de governança comercial.

## Causa raiz comprovada

O lote utilizava `directUrls[position - 1]`, isto é, tratava o resultado da descoberta como lista de posições fixas e não como um pool de candidatos. A atribuição de slot era feita antes da aquisição oficial. Um retorno `not_found` da Affiliate API rejeitava corretamente aquele candidato, mas o `continue` seguia para o próximo slot, sem buscar nem avaliar um substituto. Quando a descoberta retornava um único URL para um pedido de cinco, as posições 2–5 terminavam como `discovery_failed`.

O código do caminho `/shopee` não invoca `evaluateGovernanceDecision` nem os filtros N13–N17 antes de criar o `PendingReview`. Portanto, a rejeição observada ocorreu nas etapas de descoberta e aquisição Affiliate, não por relaxamento ou bloqueio da governança.

## Correção mínima aplicada

O orquestrador agora solicita até `min(N × 3, 30)` candidatos para buscas por termo, processa um pool sequencial e só encerra quando alcança `N` cards ou esgota os candidatos. Cada candidato continua fail-closed: URL sem identidade, duplicata, `not_found` da Affiliate API, falha de scraper, erro de persistência ou falha de Telegram não cria card, não cria produto e não é aprovado automaticamente. Após uma rejeição, o próximo candidato único é avaliado.

A deduplicação ocorre por `shopId:itemId` quando extraíveis, com fallback para a URL canônica. O relatório final passou a distinguir `candidatos rejeitados`, `candidatos avaliados` e `busca esgotada antes de completar o lote`. Os logs passam a emitir uma matriz sanitizada por candidato: lote, índice, etapa, resultado e motivo técnico controlado; nenhum token, URL de afiliado ou dado pessoal é registrado.

O provider de fallback Gemini também passou a coletar URLs Shopee do texto da resposta **e** das citações `groundingChunks` retornadas pela mesma chamada. Isso amplia o pool disponível sem fazer chamadas adicionais ao modelo, sem aceitar domínios externos e sem dispensar a validação canônica de `shopId:itemId`.

## Evidências de validação local

| Validação | Resultado | Evidência |
|---|---:|---|
| Replacement | Aprovado | teste com primeiro candidato `not_found` e segundo elegível: 1 card criado após 2 candidatos avaliados |
| Over-fetch | Aprovado | para `/shopee 1 cozinha`, a descoberta foi chamada com limite 3 |
| Deduplicação | Aprovado | nove candidatos repetidos produziram um único card e oito rejeições `duplicate_candidate` |
| Citações Grounding | Aprovado | teste reúne URLs do texto e de `groundingChunks`, deduplicando e ignorando domínio externo |
| Fail-closed sem resultado | Aprovado | ausência/erro de descoberta não cria card e mantém a meta não preenchida explícita |
| Testes focados | Aprovado | `tests/shopeeCommand.test.ts`: 10/10 testes aprovados |
| TypeScript | Aprovado | `npm run lint` concluído sem erro |
| Build | Aprovado | `npm run build` concluiu e obteve 15 produtos da projeção canônica do backend |

## Limitação residual

A descoberta pode continuar retornando menos que `N × 3` candidatos quando DDG ou Gemini estiverem indisponíveis ou com baixa cobertura. Nesse caso o lote não inventa produtos: informa separadamente que a busca foi esgotada. A validação de um novo lote real em produção deve ocorrer após o deploy desta correção.
