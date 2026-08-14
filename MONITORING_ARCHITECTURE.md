# Cerberus Finds Archive — Monitoring Architecture

**Repositório:** `kauabrennan5-bit/cerberus-forge-deploy`  
**Branch de código e produção:** `main`  
**Escopo:** Bloco 4 — Monitoramento Contínuo, Health Checks e Detecção de Anomalias

Este documento especifica a arquitetura de monitoramento contínuo incorporada ao **Cerberus Operator**, detalhando o scheduler, o heartbeat, a detecção de anomalias com deduplicação por fingerprint e a detecção de recuperação.

---

## 1. Visão Geral do Monitoramento Contínuo
O sistema evoluiu de uma verificação puramente manual/reativa para um modelo de observabilidade autônoma. O **Cerberus Operator** executa verificações periódicas em background para atestar a saúde do ecossistema, catalogar incidentes, deduplicar alertas e registrar recuperações.

## 2. Scheduler e Frequência
- **Intervalo Padrão**: 10 minutos (configurável em `cerberusOperator.ts`).
- **Resiliência no Render Gratuito**: Como instâncias gratuitas no Render podem sofrer *sleep/cold start* após 15 minutos de inatividade, o scheduler interno é complementado por opções de execução manual imediata via Telegram (`/operator` ou botões inline). O design está preparado para receber pings externos ou cron jobs no futuro.

## 3. Health Checks e Cobertura
Os componentes monitorados compreendem:
- Backend, Supabase (`public.products` e `public.product_clicks`), Catálogo estático, Tracking (`/api/track-click`), Analytics, Telegram, Site público e Deploy no Render.

## 4. Anomalias, Deduplicação por Fingerprint e Padrões de Falha
- **Diferenciação de Falhas**: 1 timeout isolado gera um aviso preventivo (*WARNING*), enquanto 3 falhas consecutivas (`failureThresholdForError`) elevam o problema a *ERROR* persistente.
- **Fingerprinting**: Cada incidente possui uma chave única baseada no componente e no tipo de erro (`component + status + error`), evitando a duplicação de alertas no Telegram a cada ciclo do scheduler.
- **Recovery Detection**: Quando um componente anteriormente indisponível volta a responder com sucesso, o Operator atualiza automaticamente o incidente para `RESOLVED`, registrando o momento da recuperação e a duração total da indisponibilidade.

## 5. Histórico e Retenção
- O sistema armazena em memória um histórico circular restrito (máximo de 100 registros) de latências e status para auditoria rápida, evitando consumo excessivo de recursos.
- O Incident Manager gerencia até 50 incidentes recentes.

## 6. Segurança e Rate Limit
- Nenhum segredo ou credencial (Service Role Key, tokens do bot, GA4 JSON) é exposto nos relatórios de monitoramento ou nas mensagens enviadas ao Telegram.
- O rate limiting do scheduler evita sobrecarga no Supabase e no Render.
