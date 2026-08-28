export interface ParsedTelegramCommand {
  name: string;
  args: string;
}

export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

/** Apenas o que merece aparecer no menu nativo do Telegram. */
export const PRIMARY_TELEGRAM_COMMANDS: readonly TelegramCommandDefinition[] = Object.freeze([
  { command: "start", description: "Abrir o painel Cerberus" },
  { command: "menu", description: "Atalhos principais" },
  { command: "hoje", description: "Resumo e prioridade de agora" },
  { command: "status", description: "Saúde do sistema" },
  { command: "pendentes", description: "Revisões aguardando decisão" },
  { command: "aprovados", description: "Decisões e catálogo ativo" },
  { command: "produtos", description: "Gerenciar catálogo" },
  { command: "categorias", description: "Taxonomia pública e contagens" },
  { command: "shopee", description: "Analisar até 10 itens Shopee" },
  { command: "publicar", description: "Encaminhar review com confirmação" },
  { command: "analytics", description: "Cliques e desempenho" },
  { command: "campanhas", description: "Campanhas recentes" },
  { command: "redes", description: "Links sociais oficiais" },
  { command: "cancelar", description: "Cancelar o fluxo atual" },
  { command: "ajuda", description: "Como usar o bot" },
  { command: "avancado", description: "Comandos técnicos" },
]);

export const ADVANCED_TELEGRAM_COMMANDS = Object.freeze([
  "/discover ML|SH <url|busca>",
  "/discover_batch ML|SH <urls>",
  "/research <candidate_id>",
  "/assess <candidate_id>",
  "/priority · /opportunities · /risks",
  "/experiments · /agents · /decisions",
  "/recommendations · /affiliates",
  "/cycle status <cycle_id>",
  "/shopee-schema",
  "/shopee-offer <shop_id> <item_id>",
  "/campanha2 · /boasvindas",
]);

const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  admin: "start",
  help: "ajuda",
  listar: "produtos",
  campaigns: "campanhas",
  "redes-sociais": "redes",
  colecao: "campanha2",
  discover_batch: "discover-batch",
});

const KNOWN_COMMANDS = new Set([
  ...PRIMARY_TELEGRAM_COMMANDS.map(item => item.command),
  "admin",
  "help",
  "listar",
  "campaigns",
  "redes-sociais",
  "discover",
  "discover-batch",
  "discover_batch",
  "research",
  "assess",
  "priority",
  "opportunities",
  "risks",
  "experiments",
  "agents",
  "decisions",
  "recommendations",
  "affiliates",
  "cycle",
  "shopee-schema",
  "shopee-offer",
  "campanha2",
  "boasvindas",
  "colecao",
]);

export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
  const match = String(text || "").trim().match(/^\/([a-z0-9_-]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] || "").trim() };
}

export function canonicalTelegramCommand(name: string): string {
  const normalized = String(name || "").toLowerCase();
  return ALIASES[normalized] || normalized;
}

export function isKnownTelegramCommand(name: string): boolean {
  return KNOWN_COMMANDS.has(String(name || "").toLowerCase());
}

function normalizePhrase(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Atalhos naturais estritamente read-only; nunca inferem publicação/mutation. */
export function resolveReadOnlyShortcut(text: string): string | null {
  const value = normalizePhrase(text);
  const shortcuts: Record<string, string> = {
    menu: "menu",
    "ver menu": "menu",
    hoje: "hoje",
    resumo: "hoje",
    "resumo de hoje": "hoje",
    status: "status",
    "ver status": "status",
    pendentes: "pendentes",
    "ver pendentes": "pendentes",
    aprovados: "aprovados",
    "ver aprovados": "aprovados",
    produtos: "produtos",
    "listar produtos": "produtos",
    categorias: "categorias",
    "ver categorias": "categorias",
  };
  return shortcuts[value] || null;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const before = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = before;
    }
  }
  return row[b.length];
}

export function suggestTelegramCommand(name: string): string | null {
  const normalized = String(name || "").toLowerCase();
  let best: { name: string; distance: number } | null = null;
  for (const item of PRIMARY_TELEGRAM_COMMANDS) {
    const distance = levenshtein(normalized, item.command);
    if (!best || distance < best.distance) best = { name: item.command, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(normalized.length / 3)) ? best.name : null;
}

export function renderPrimaryCommandHelp(): string {
  return (
    "🛡️ <b>CERBERUS FINDS</b>\n" +
    "Use o bot como painel, não como terminal.\n\n" +
    "⚡ <b>AGORA</b>\n" +
    "/hoje — resumo + próxima prioridade\n" +
    "/pendentes — fila humana\n" +
    "/aprovados — decisões e catálogo ativo\n" +
    "/status — saúde do sistema\n\n" +
    "📦 <b>CATÁLOGO</b>\n" +
    "/produtos · /categorias · /analytics\n\n" +
    "🔎 <b>DESCOBERTA</b>\n" +
    "/shopee N [termo ou link]\n" +
    "/publicar &lt;review_id&gt; — sempre com confirmação humana\n\n" +
    "🧰 <b>ADMIN</b>\n" +
    "/campanhas · /redes · /cancelar\n" +
    "/avancado — ferramentas técnicas\n\n" +
    "Você também pode escrever: <i>status</i>, <i>ver pendentes</i>, <i>listar produtos</i>.\n" +
    "DECISION ≠ ACTION · mutações só acontecem em fluxos explícitos."
  );
}

export function renderAdvancedCommandHelp(): string {
  return (
    "🧰 <b>COMANDOS AVANÇADOS</b>\n\n" +
    ADVANCED_TELEGRAM_COMMANDS.map(item => `• <code>${item.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`).join("\n") +
    "\n\nEsses comandos continuam disponíveis por compatibilidade, mas não poluem o menu principal."
  );
}