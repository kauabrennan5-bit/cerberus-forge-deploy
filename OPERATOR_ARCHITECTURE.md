# Cerberus Finds Archive — Operator Architecture

**Repositório:** `kauabrennan5-bit/cerberus-forge-deploy`  
**Branch de código e produção:** `main`  
**Escopo:** Bloco 3 — Cerberus Operator / Sistema Operacional

Este documento formaliza a arquitetura, os modos de operação, os health checks, o sistema de incidentes e as políticas de segurança do **Cerberus Operator**, incorporado ao sistema como camada central de observabilidade e controle operacional via Telegram.

---

## 1. Visão Geral
O Cerberus Operator é o sistema operacional administrativo do Cerberus Finds. Ele atua como uma inteligência intermediária entre o ecossistema (Supabase, API, GitHub, Render, Telegram, Tracking e Analytics) e o administrador, observando, diagnosticando e executando correções seguras sem ferir a fonte única de verdade definida no Bloco 2.

## 2. Modos de Operação
O Operator opera em três níveis configuráveis:
1. **`OBSERVE`**: Monitoramento passivo. Nenhuma ação automática de correção é executada.
2. **`SAFE_AUTO_HEAL` (Padrão)**: Executa automaticamente apenas correções pré-validadas, seguras e reversíveis (ex: revalidação de catálogo, reexecução de health checks, limpeza de estado transitório).
3. **`ADMIN_APPROVAL`**: Incidentes de risco ou alterações estruturais exigem confirmação explícita do administrador no Telegram antes de qualquer resolução.

## 3. Health Checks Centrais
O subsistema de saúde monitora os seguintes componentes:
- **Backend**: Disponibilidade do servidor Node.js/Express.
- **Supabase**: Conectividade PostgreSQL e acesso às tabelas `public.products` e `public.product_clicks`.
- **Catálogo**: Consistência entre a fonte canônica e a projeção pública.
- **Tracking**: Consulta somente leitura à tabela `public.product_clicks`, sem gerar clique artificial.
- **Analytics**: Disponibilidade de consultas agregadas em `public.product_clicks`.
- **Telegram**: Operacionalidade dos manipuladores de webhook e callbacks.
- **Site**: Verificação HTTP independente da página pública.
- **Deploy**: Registrado como `UNKNOWN` quando não existe uma API autenticada do Render configurada. A disponibilidade do site ou de `products.json` não é tratada como prova de que um deploy específico terminou.

Cada componente retorna `HEALTHY`, `DEGRADED`, `DOWN` ou `UNKNOWN`, juntamente com latência, timestamp, operation ID e, em caso de falha, diagnóstico estruturado.

## 4. Sistema de Incidentes e Severidade
Qualquer anomalia detectada gera um registro interno com `id`, `fingerprint`, severidade, componente, status, operation ID, operação, etapa, dependência, HTTP status quando houver, causa provável, impacto, recuperabilidade, ação tomada, resultado e timestamps. O Operator não usa o diagnóstico genérico “degradação ou indisponibilidade de conexão”.

Uma ação de recovery não encerra um incidente apenas porque retornou `SUCCESS`. O Operator executa um health check posterior e só marca `RESOLVED` quando o componente afetado volta a `HEALTHY`; caso contrário, o incidente é escalado.

## 5. Ações Permitidas e Segurança
- **Seguras (Safe)**: Reexecução de health checks, revalidação de catálogo e limpeza de estado transitório de sessões do bot.
- **Destruidoras / Exclusivas de Admin Approval**: Apagar produtos em massa, alterar schema do Supabase, modificar branch, alterar credenciais ou modificar código em produção.

## 6. Integração com o Telegram
O painel administrativo do Telegram agora inclui a seção central **🧠 Cerberus Operator**, acessível por botões inline, permitindo:
- Visualizar o status agregado do sistema.
- Executar verificações manuais de saúde.
- Listar incidentes ativos.
- Disparar ações de correção E2E.
- Visualizar logs operacionais recentes.
