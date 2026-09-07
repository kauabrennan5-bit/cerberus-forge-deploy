const INTERNAL_CURATOR_NOTE_PATTERN = /^AUTONOMOUS_CURATOR_[A-Z0-9_]+\s*:/i;

/**
 * `curatorNote` permanece disponível internamente para fila, auditoria e
 * operação editorial, mas nunca cruza a fronteira pública do storefront.
 * A página de produto já possui descrição factual; notas do curador não são
 * conteúdo público em nenhuma publicação.
 */
export function sanitizePublicCuratorNote(_value: unknown): string | undefined {
  return undefined;
}

export const publicCuratorNoteInternals = {
  INTERNAL_CURATOR_NOTE_PATTERN,
};
