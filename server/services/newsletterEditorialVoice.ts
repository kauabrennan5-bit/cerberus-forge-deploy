/**
 * Contrato editorial vigente do Cerberus Finds, compartilhado pela curadoria
 * de produto e pelos microeditoriais da newsletter. Não é um novo prompt.
 */
export const CERBERUS_EDITORIAL_VOICE_CONTRACT = "tom cru, direto e curatorial" as const;
export const CERBERUS_EDITORIAL_FOCUS = "tecido, corte, caimento e estética" as const;

/**
 * Microeditoriais fechados: não fazem promessa sobre preço, qualidade ou
 * atributo não presente nos dados. O conteúdo apenas organiza a seleção.
 */
export const CERBERUS_NEWSLETTER_MICROEDITORIALS = [
  { eyebrow: "Olha o que encontramos", copy: "Peças com presença, escolhidas para sair do óbvio." },
  { eyebrow: "Seu próximo achado", copy: "Qual desses combina com você?" },
  { eyebrow: "Curadoria em movimento", copy: "A seleção muda. O olhar continua atento." },
] as const;

/**
 * Temas fechados para a capa da edição; seguem o contrato cru, direto e
 * curatorial e não fazem alegações sobre preço, disponibilidade ou atributos.
 */
export const CERBERUS_NEWSLETTER_MASTHEAD_THEMES = [
  { headline: "OBJETOS PARA OLHAR DE NOVO.", deck: "Uma seleção direta, guiada por forma, material e presença." },
  { headline: "UM OLHAR ATENTO PARA O QUE ENTRA.", deck: "Uma edição curta para descobrir o que saiu do óbvio." },
] as const;
