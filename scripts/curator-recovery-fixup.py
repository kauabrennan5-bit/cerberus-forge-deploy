from pathlib import Path


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"fixup anchor not found in {path}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "server/services/autonomousCurator.ts",
    '''      const queryOrder = [primaryQuery, ...profile.queries.filter(candidateQuery => candidateQuery !== primaryQuery)];
      let prepared: Awaited<ReturnType<typeof prepareCategoryCandidate>> | null = null;
      for (const candidateQuery of queryOrder) {
        query = candidateQuery;
        prepared = await prepareCategoryCandidate({ profile, query, runId: open.run.id, config, existingProducts, client, deps });
        if (prepared.candidate) break;
        // Source-level failures affect every query; candidate-level rejections
        // continue through the remaining deterministic alternatives.
        if (prepared.decision === "failed") break;
      }
      if (!prepared) throw new Error("AUTONOMOUS_CURATOR_QUERY_CYCLE_EMPTY");
      if (!prepared.candidate) {
''',
    '''      const queryOrder = [primaryQuery, ...profile.queries.filter(candidateQuery => candidateQuery !== primaryQuery)];
      let prepared: Awaited<ReturnType<typeof prepareCategoryCandidate>> | null = null;
      let strongestPrepared: Awaited<ReturnType<typeof prepareCategoryCandidate>> | null = null;
      const decisionRank = (decision: string) => decision === "duplicate" ? 3 : decision === "reject" ? 2 : decision === "none" ? 1 : 0;
      for (const candidateQuery of queryOrder) {
        query = candidateQuery;
        const currentPrepared = await prepareCategoryCandidate({ profile, query, runId: open.run.id, config, existingProducts, client, deps });
        prepared = currentPrepared;
        if (currentPrepared.candidate) break;
        if (!strongestPrepared || decisionRank(currentPrepared.decision) > decisionRank(strongestPrepared.decision)) strongestPrepared = currentPrepared;
        // Source-level failures affect every query; candidate-level rejections
        // continue through the remaining deterministic alternatives.
        if (currentPrepared.decision === "failed") break;
      }
      if (!prepared) throw new Error("AUTONOMOUS_CURATOR_QUERY_CYCLE_EMPTY");
      if (!prepared.candidate && strongestPrepared && decisionRank(strongestPrepared.decision) > decisionRank(prepared.decision)) prepared = strongestPrepared;
      if (!prepared.candidate) {
''',
)

p = Path("tests/autonomousCurator.test.ts")
text = p.read_text()
text = text.replace('Abajur Bauhaus ruim', 'Abajur Cogumelo Bauhaus Retro Ruim')
p.write_text(text)
