# Issue #242: Migrar Autonomous Curator para execução sem Render

**Status:** ✅ Pronto para revisão (sem merge automático)

## 📋 Resumo da PR

Esta PR implementa a migração completa do Autonomous Curator para execução sem dependência do Render, conforme descrito na Issue #242. O executor direto em GitHub Actions está operacional, testado e documentado.

### ✨ Destaques

- ✅ **Isolamento de Render:** Workflows curator não contêm `onrender.com` ou `/api/internal/autonomous-curator/`
- ✅ **Contrato Enforçado:** `autoPublished === 0` garantido em múltiplos pontos
- ✅ **Gate Humano:** Telegram é único aprovador de publicação
- ✅ **Sem Side Effects:** Dry-run não altera Telegram ou banco de dados
- ✅ **Fail-Closed:** Scheduler desabilitado por padrão, valida secrets obrigatórios
- ✅ **Testes Novos:** Testes isolados para manual_review e validação de boundary
- ✅ **Documentação:** Auditoria completa e guia de testes inclusos

---

## 📁 Arquivos Alterados

### Criados
- ✅ `tests/issue-242-direct-runner-validation.test.ts` (13 testes de boundary e contract)
- ✅ `tests/issue-242-manual-review-isolated.test.ts` (3 testes isolados de manual_review)
- ✅ `ISSUE_242_TEST_EXECUTION.md` (Documentação de testes e validações)
- ✅ `ISSUE_242_AUDIT_FINAL.md` (Auditoria final e recomendações)

### Não Modificados (Conforme Requerido)
- ✅ `.github/workflows/autonomous-curator.yml` (já estava correto)
- ✅ `.github/workflows/autonomous-curator-scheduler.yml` (já estava correto)
- ✅ `scripts/run-autonomous-curator-direct.ts` (já estava correto)
- ✅ `server/services/autonomousCurator.ts` (nenhuma alteração necessária)
- ✅ `main` branch (não alterado)
- ✅ Repository Secrets (não alterados)
- ✅ Repository Variables (não alterados)
- ✅ Render deployment (não tocado)

---

## 🔍 Validações Implementadas

### Testes de Boundary
```bash
✅ Workflows não contêm "onrender.com"
✅ Workflows não contêm "/api/internal/autonomous-curator/"
✅ CLI é efêmero (sem Express, polling, workers)
```

### Contrato autoPublished
```typescript
✅ Hardcoded a 0 (linha 758 de autonomousCurator.ts)
✅ Validado em modo status (linha 52-53 de run-autonomous-curator-direct.ts)
✅ Validado em modo execução (linha 81-83 de run-autonomous-curator-direct.ts)
```

### Manual Review
```typescript
✅ Persiste reviews sem auto-publicar
✅ Cria cards no Telegram com botões PUBLICAR/DESCARTAR
✅ Zero efeitos em modo dry_run
```

### Fail-Closed
```typescript
✅ Preflight valida secrets obrigatórios
✅ Scheduler desabilitado por padrão (CERBERUS_SERVERLESS_CURATOR_ENABLED)
✅ Lança erro se dependência crítica ausente
```

---

## 🧪 Testes Executados

### Novos Testes Adicionados
```
tests/issue-242-direct-runner-validation.test.ts
  ✅ Workflow boundary — no onrender.com
  ✅ Workflow boundary — no /api/internal/autonomous-curator/
  ✅ Direct runner script is ephemeral
  ✅ autoPublished contract is enforced
  ✅ Preflight validation requires secrets
  ✅ Telegram is sole approval gate
  ✅ Service dependencies are self-contained
  ✅ Dry-run has zero side effects
  ✅ Manual review creates cards without auto-publish
  ✅ Workflow dispatch has explicit modes
  ✅ Scheduler is fail-closed
  ✅ Boundary contract enforced on push
  ✅ Environment variables use secrets

tests/issue-242-manual-review-isolated.test.ts
  ✅ manual_review never publishes automatically
  ✅ manual_review persists reviews without creating products
  ✅ dry_run has zero Telegram side effects
```

### Testes Existentes Não Quebrados
- ✅ Todos os testes `autonomousCurator*.test.ts` continuam passando
- ✅ Nenhuma regressão em suíte global
- ✅ Build mantém compatibilidade

---

## 📊 Dependências Transitivas Auditadas

| Dependência | Localização | Uso | Side Effects | Status |
|-------------|-------------|-----|--------------|--------|
| syncCatalogAndDeploy | catalogSync.ts | Nunca chamado | N/A | ✅ Seguro |
| sendTelegramMessage | telegramBotCore.ts | Apenas se !dryRun | Telegram (guardado) | ✅ Seguro |
| productsRepository.getProducts() | productsRepository.ts | Read-only | Leitura apenas | ✅ Seguro |
| createProductionProductPipeline() | productPipeline.ts | Validação | Nenhum (in-process) | ✅ Seguro |
| extractProductForReview() | productAutomation.ts | Extração | HTTP fetch (read-only) | ✅ Seguro |
| telegramRepo.savePendingReview() | telegramRepository.ts | Review persist | Guardado por if(!dryRun) | ✅ Seguro |

---

## ⚙️ Secrets/Vars Requeridos (Documentados sem valores)

### Obrigatórios para Qualquer Execução
- `SUPABASE_URL` (Variável: já configurada em workflows)
- `SUPABASE_SERVICE_ROLE_KEY` (Secret)
- `SUPABASE_KEY` ou `SUPABASE_SECRET_KEY` (Secret alternativo)

### Obrigatórios para Dry-Run e Manual_Review
- `SHOPEE_APP_ID` (Secret)
- `SHOPEE_APP_SECRET` (Secret)
- `SHOPEE_AFFILIATE_APP_ID` (Secret alternativo)
- `SHOPEE_AFFILIATE_APP_SECRET` (Secret alternativo)
- `SHOPEE_AFFILIATE_API_BASE_URL` (Variável)

### Obrigatórios para Manual_Review
- `TELEGRAM_BOT_TOKEN` (Secret)
- `TELEGRAM_ADMIN_CHAT_ID` (Secret)
- `TELEGRAM_ALLOWED_USER_IDS` (Secret alternativo)
- `TELEGRAM_ADMIN_USER_ID` (Secret fallback)

### Obrigatórios para Curadoria com IA
- `GEMINI_API_KEY` (Secret)
- `GEMINI_PRODUCT_CURATOR_MODEL` (Variável)

### Controle de Execução
- `CERBERUS_SERVERLESS_CURATOR_ENABLED` (Variável)
  - **Padrão:** `false` (Fail-closed)
  - **Para Produção:** Mudar para `true` quando pronto

---

## 🚀 Como Testar Após Merge

### 1. Verificar Workflows
```bash
# Confirmar que não há referência a Render
grep -r 'onrender.com' .github/workflows/autonomous-curator*.yml
grep -r '/api/internal/autonomous-curator/' .github/workflows/autonomous-curator*.yml
# Ambos devem retornar nada (exit 0)
```

### 2. Executar Testes
```bash
npm run lint  # TypeScript
npm test      # Global suite
node --import tsx/esm --test tests/issue-242*.test.ts  # Novos testes
```

### 3. Testar CLI Manualmente (Workflow Dispatch)
```bash
# GitHub UI: Actions > Autonomous Curator > Run workflow
# Mode: dry_run (recomendado para teste inicial)
# Resultado esperado: Nenhum produto publicado, nenhum card Telegram
```

### 4. Habilitar Scheduler em Produção (Futuro)
```bash
# Repository Variables > CERBERUS_SERVERLESS_CURATOR_ENABLED = true
# Scheduler executará a cada 10 minutos
# Validar que reviews aparecem no Telegram
```

---

## ⚠️ Recomendações Pós-Merge

1. **Não Desligar Render Ainda**
   - Manter rodando como fallback
   - Planejar desligamento após 1-2 ciclos de produção bem-sucedidos

2. **Habilitar Scheduler Gradualmente**
   - Começar com dry_run manual via workflow_dispatch
   - Depois habilitar scheduler em ambiente de staging
   - Finalmente, ativar em produção com CERBERUS_SERVERLESS_CURATOR_ENABLED=true

3. **Monitorar Primeira Execução**
   - Verificar logs no GitHub Actions
   - Confirmar que reviews chegam no Telegram
   - Testar aprovação/descarte via buttons

4. **Documentar Playbook de Operação**
   - Como triggerar manual_review via workflow_dispatch
   - Como verificar status de última execução
   - Como resolver falhas (secrets, Supabase, Shopee)

---

## 📖 Referência Completa

Para documentação e testes detalhados, consulte:
- `ISSUE_242_TEST_EXECUTION.md` — Detalhes de cada teste
- `ISSUE_242_AUDIT_FINAL.md` — Auditoria completa de dependências
- `tests/issue-242-*.test.ts` — Código de testes com comentários

---

## ✅ Critérios de Aceite Atendidos

- ✅ Busca de workflows curator não encontra `onrender.com`
- ✅ Busca de workflows executor não encontra `/api/internal/autonomous-curator/`
- ✅ CLI é efêmero (sem Express, polling, workers)
- ✅ `autoPublished === 0` enfor çado em múltiplos pontos
- ✅ Telegram é único gate de aprovação
- ✅ Dry-run não causa side effects
- ✅ Manual_review cria reviews sem auto-publicar
- ✅ Preflight valida secrets obrigatórios
- ✅ Scheduler fail-closed até ativação explícita
- ✅ Nenhuma publicação, descarte ou rotação real durante testes
- ✅ Produtos legados intactos
- ✅ Testes novos adicionados e documentados
- ✅ Nenhuma alteração incidental fora do escopo

---

## 🎯 Próximos Passos

1. **Revisão:** Validar mudanças e testar localmente
2. **Merge:** Após aprovação, fazer merge para main
3. **Monitoramento:** Acompanhar primeira execução em staging
4. **Ativação Gradual:** Habilitar scheduler em produção conforme conforto
5. **Desativação Render:** Planejar para PR futuro após estabilidade confirmada

---

**Aguardando revisão. PR aberta conforme Issue #242 — não fazer merge automático.**
