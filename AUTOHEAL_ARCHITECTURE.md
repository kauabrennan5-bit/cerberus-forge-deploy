# Cerberus Finds Archive — Safe Auto-Heal Architecture

**Repositório:** `kauabrennan5-bit/cerberus-forge-deploy`  
**Branch de produção:** `main`  
**Escopo:** Bloco 5 — Autocorreção Segura / Safe Auto-Heal

O Cerberus Operator utiliza um **registro fechado e determinístico de ações autorizadas**. Ele não aceita comandos arbitrários, não executa shell, não cria SQL dinâmico e não pode alterar secrets, infraestrutura, código-fonte ou dados destrutivamente.

---

## 1. Action Registry

Cada ação registrada define obrigatoriamente: `id`, `name`, `description`, `risk`, `allowed`, `preconditions`, `execute`, `validate`, `rollback` quando aplicável, `timeoutMs`, `cooldownMs`, `maxRetries` e `retryable`.

| Ação | Risco | Execução | Validação | Rollback |
|---|---|---|---|---|
| `REVALIDATE_SERVICES` | LOW | Repete health checks E2E | Status verificável | Não aplicável |
| `REGENERATE_STATIC_CATALOG` | LOW | Gera `public/data/products.json` a partir de `public.products` | Contagem, IDs, slugs e campos essenciais | Restaura snapshot anterior |
| `REVALIDATE_TRACKING` | LOW | Consulta `products` e `product_clicks` sem inserir clique | Ambas as tabelas acessíveis | Não aplicável |
| `REVALIDATE_ANALYTICS` | LOW | Consulta diagnóstica em `product_clicks` | Query válida sem mutação | Não aplicável |
| `REVALIDATE_GITHUB_SYNC` | MEDIUM | Executa somente o fluxo canônico `syncCatalogAndDeploy` | Projeção pública compatível | Exige aprovação explícita |

## 2. Risco, Modo e Aprovação

- **LOW**: pode ser executada em `SAFE_AUTO_HEAL`, depois de pré-condições válidas.
- **MEDIUM**: pode ser configurada para aprovação; a sincronização GitHub é sempre encaminhada para aprovação explícita.
- **HIGH**: não é executada automaticamente; requer aprovação administrativa.
- **CRITICAL**: nunca é executada automaticamente.

O modo padrão do Operator é **`OBSERVE`**. Os modos suportados são `OBSERVE`, `SAFE_AUTO_HEAL`, `DRY_RUN` e `ADMIN_APPROVAL`. Apenas o administrador autorizado no Telegram pode alterá-los por callback inline validado.

## 3. Ciclo de Execução

1. O incidente recebe fingerprint.
2. O Operator escolhe somente uma ação registrada compatível.
3. As pré-condições são verificadas.
4. Em `DRY_RUN`, a ação é apenas relatada.
5. A execução tem timeout definido.
6. O resultado é validado contra o estado canônico.
7. Falhas de validação disparam rollback quando houver snapshot.
8. Cada resultado entra no audit log sem dados sensíveis.
9. Falhas repetidas acionam cooldown e circuit breaker.

## 4. Retry, Cooldown e Circuit Breaker

Retries só existem em ações marcadas explicitamente como `retryable`, com backoff exponencial e limite pequeno. Nenhuma ação destrutiva recebe retry. Uma mesma combinação de `ação + fingerprint de incidente` respeita cooldown. Após três falhas consecutivas, o circuit breaker bloqueia novas tentativas durante 30 minutos e exige intervenção administrativa.

## 5. Segurança e Limites

O registry rejeita toda ação não registrada, incluindo tentativas de `DROP_DATABASE`, shell, alteração de credenciais, alteração de secrets, exclusão em massa, modificações de schema e deploy de código não versionado. Logs registram somente identificadores, status, validação, duração e erro sanitizado; tokens, senhas e service role keys não são registrados nem enviados ao Telegram.

## 6. Limitação Operacional

O scheduler do Bloco 4 pode ser interrompido por sleep/cold start no Render gratuito. O painel Telegram mantém as ações manuais e aprovadas disponíveis quando o backend está acordado. Esta limitação não é mascarada por retries infinitos ou por serviços externos não configurados.
