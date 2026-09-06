import { requireSupabase } from "./productsRepository";

export type ManualShopeeIdentityReservationInput = {
  marketplace: "Shopee";
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  reviewId: string;
  ttlMinutes: number;
};

export type ManualShopeeIdentityReservation = {
  reserved: boolean;
  identity: {
    marketplace: string;
    shopId: string;
    itemId: string;
    sourceProductUrl: string;
    productId: string | null;
    reviewId: string | null;
    reservedRunId: string | null;
    reservedUntil: string | null;
  } | null;
};

function mapIdentity(row: any) {
  if (!row) return null;
  return {
    marketplace: String(row.marketplace),
    shopId: String(row.shop_id),
    itemId: String(row.item_id),
    sourceProductUrl: String(row.source_product_url),
    productId: row.product_id ? String(row.product_id) : null,
    reviewId: row.review_id ? String(row.review_id) : null,
    reservedRunId: row.reserved_run_id ? String(row.reserved_run_id) : null,
    reservedUntil: row.reserved_until ? String(row.reserved_until) : null,
  };
}

/**
 * Reserva identidade Shopee para um card exclusivamente manual.
 *
 * Não existe autonomous_curator_run para esse fluxo. A tabela possui FK em
 * reserved_run_id, portanto a reserva manual deve permanecer NULL nesse campo
 * e ser possuída exclusivamente pelo review_id + identidade oficial do anúncio.
 */
export async function reserveManualShopeeIdentity(
  input: ManualShopeeIdentityReservationInput,
): Promise<ManualShopeeIdentityReservation> {
  const client = requireSupabase();
  const now = Date.now();
  const ttlMinutes = Math.max(5, Math.min(24 * 60, Number(input.ttlMinutes) || 60));
  const reservedUntil = new Date(now + ttlMinutes * 60_000).toISOString();

  const payload = {
    marketplace: input.marketplace,
    shop_id: input.shopId,
    item_id: input.itemId,
    source_product_url: input.sourceProductUrl,
    source: "telegram_manual",
    review_id: input.reviewId,
    reserved_run_id: null,
    reserved_until: reservedUntil,
    updated_at: new Date(now).toISOString(),
  };

  const { data, error } = await client
    .from("product_source_identities")
    .insert(payload)
    .select("*")
    .single();

  if (!error && data) {
    return { reserved: true, identity: mapIdentity(data) };
  }

  if ((error as any)?.code !== "23505") throw error;

  const { data: existingRow, error: existingError } = await client
    .from("product_source_identities")
    .select("*")
    .eq("marketplace", input.marketplace)
    .eq("shop_id", input.shopId)
    .eq("item_id", input.itemId)
    .maybeSingle();
  if (existingError) throw existingError;

  const existing = mapIdentity(existingRow);
  if (!existing) return { reserved: false, identity: null };
  if (existing.productId) return { reserved: false, identity: existing };

  const expiry = existing.reservedUntil ? Date.parse(existing.reservedUntil) : 0;
  const expired = Number.isFinite(expiry) && expiry <= now;
  const sameReview = existing.reviewId === input.reviewId;
  if (!sameReview && !expired) return { reserved: false, identity: existing };

  const { data: updatedRow, error: updateError } = await client
    .from("product_source_identities")
    .update(payload)
    .eq("marketplace", input.marketplace)
    .eq("shop_id", input.shopId)
    .eq("item_id", input.itemId)
    .is("product_id", null)
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;

  const updated = mapIdentity(updatedRow);
  return updated
    ? { reserved: true, identity: updated }
    : { reserved: false, identity: existing };
}
