import { requireSupabase } from "../repositories/productsRepository";

const ROTATION_CANDIDATE_CREATED_BY = "telegram_rotation_candidate";
const DELETABLE_ROTATION_STATUSES = new Set(["paused", "archived"]);

async function hasRotationReference(productId: string): Promise<boolean> {
  const client = requireSupabase();
  for (const column of ["source_product_id", "replacement_product_id", "candidate_product_id"] as const) {
    const { data, error } = await client
      .from("product_rotation_requests")
      .select("id")
      .eq(column, productId)
      .limit(1);
    if (error) throw error;
    if ((data || []).length > 0) return true;
  }
  return false;
}

/**
 * Permanently removes a rotation-only candidate that the user rejected.
 * Safety contract: never deletes public/active products, selected replacements,
 * catalog sources, autonomous queue inventory, or any product still referenced
 * by a rotation request.
 */
export async function hardDeleteRejectedRotationCandidate(productId: string): Promise<boolean> {
  const client = requireSupabase();
  const { data: product, error: readError } = await client
    .from("products")
    .select("id,created_by,ativo,status")
    .eq("id", productId)
    .maybeSingle();
  if (readError) throw readError;
  if (!product) {
    await client.from("product_source_identities").delete().eq("product_id", productId);
    return false;
  }

  if (
    String(product.created_by || "") !== ROTATION_CANDIDATE_CREATED_BY
    || product.ativo !== false
    || !DELETABLE_ROTATION_STATUSES.has(String(product.status || ""))
  ) {
    return false;
  }
  if (await hasRotationReference(productId)) return false;

  const { data: deleted, error: deleteError } = await client
    .from("products")
    .delete()
    .eq("id", productId)
    .eq("created_by", ROTATION_CANDIDATE_CREATED_BY)
    .eq("ativo", false)
    .in("status", ["paused", "archived"])
    .select("id")
    .maybeSingle();
  if (deleteError) throw deleteError;
  if (!deleted) return false;

  const { error: identityError } = await client
    .from("product_source_identities")
    .delete()
    .eq("product_id", productId);
  if (identityError) {
    console.error(`[ROTATION] rejected_candidate_identity_cleanup_failed candidate=${productId} error=${identityError.message}`);
  }
  return true;
}

/**
 * Before cancelling a candidate_ready request, detach a temporary Telegram-only
 * candidate so the terminal cancelled request does not keep a foreign-key hold
 * on a product the user explicitly declined. Autonomous queue candidates are
 * intentionally preserved for later curator use.
 */
export async function detachDisposableRotationCandidateForCancellation(requestId: string): Promise<string | null> {
  const client = requireSupabase();
  const { data: request, error: requestError } = await client
    .from("product_rotation_requests")
    .select("id,status,candidate_product_id,rejected_candidate_ids")
    .eq("id", requestId)
    .maybeSingle();
  if (requestError) throw requestError;
  const candidateId = request?.candidate_product_id ? String(request.candidate_product_id) : null;
  if (!candidateId || request?.status !== "candidate_ready") return null;

  const { data: product, error: productError } = await client
    .from("products")
    .select("id,created_by,ativo,status")
    .eq("id", candidateId)
    .maybeSingle();
  if (productError) throw productError;
  if (
    !product
    || String(product.created_by || "") !== ROTATION_CANDIDATE_CREATED_BY
    || product.ativo !== false
    || !DELETABLE_ROTATION_STATUSES.has(String(product.status || ""))
  ) {
    return null;
  }

  const rejected = Array.isArray(request.rejected_candidate_ids)
    ? request.rejected_candidate_ids.map(String)
    : [];
  const { data: detached, error: detachError } = await client
    .from("product_rotation_requests")
    .update({
      candidate_product_id: null,
      rejected_candidate_ids: [...new Set([...rejected, candidateId])],
      reason: "CANDIDATE_REJECTED_BY_USER",
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .eq("status", "candidate_ready")
    .eq("candidate_product_id", candidateId)
    .select("id")
    .maybeSingle();
  if (detachError) throw detachError;
  if (!detached) return null;

  const { error: archiveError } = await client
    .from("products")
    .update({ ativo: false, status: "archived" })
    .eq("id", candidateId)
    .eq("created_by", ROTATION_CANDIDATE_CREATED_BY)
    .eq("ativo", false);
  if (archiveError) throw archiveError;
  return candidateId;
}
