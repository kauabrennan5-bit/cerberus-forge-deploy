const INTERNAL_CURATOR_NOTE_PATTERN = /^AUTONOMOUS_CURATOR_[A-Z0-9_]+\s*:/i;

/**
 * Mantém a nota editorial humana disponível para a vitrine, mas bloqueia
 * metadados operacionais serializados pelo Autonomous Curator. Esses valores
 * são estado interno de fila/auditoria e nunca devem atravessar a fronteira
 * pública do catálogo.
 */
export function sanitizePublicCuratorNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const note = value.trim();
  if (!note) return undefined;
  if (INTERNAL_CURATOR_NOTE_PATTERN.test(note)) return undefined;
  return note;
}

export const publicCuratorNoteInternals = {
  INTERNAL_CURATOR_NOTE_PATTERN,
};
