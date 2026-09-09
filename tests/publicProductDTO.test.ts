import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_PRODUCT_DTO_FIELDS,
  toPublicProductDTO,
  toPublicProductDTOs,
} from "../supabase/functions/_shared/publicProductDTO";

const image = "https://cdn.example.com/product.jpg";
const fingerprint = `sha256:${"a".repeat(64)}`;

function rawProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    ref: "REF-1",
    slug: "produto-1",
    produto: "Produto Cerberus",
    display_title: "Produto Cerberus",
    categoria: "Iluminação",
    preco: 99.9,
    imagens: [image],
    link: "https://s.shopee.com.br/example",
    destaque: false,
    descricao: "Descrição pública.",
    pagina_ponte_url: "/produto/produto-1",
    ativo: true,
    status: "published",
    curator_note: "segredo editorial",
    lifecycle: { internal: true },
    publication_authorization: { internal: true },
    source_identity: { shop_id: "123", item_id: "456" },
    image_review_diagnostics: { provider: "internal" },
    ...overrides,
  };
}

test("the public DTO is a whitelist and recursively excludes editorial internals", () => {
  const dto = toPublicProductDTO(rawProduct());
  assert.ok(dto);
  assert.deepEqual(Object.keys(dto).sort(), [
    "ativo", "categoria", "descricao", "destaque", "displayTitle", "id", "imagens", "link",
    "paginaPonteUrl", "preco", "produto", "ref", "slug", "status",
  ].sort());
  assert.ok(Object.keys(dto).every(key => (PUBLIC_PRODUCT_DTO_FIELDS as readonly string[]).includes(key)));
  const serialized = JSON.stringify(dto);
  for (const forbidden of [
    "curator_note", "curatorNote", "lifecycle", "publication_authorization",
    "source_identity", "image_review_diagnostics",
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));
});

test("public collections include only exact active published products", () => {
  const products = toPublicProductDTOs([
    rawProduct({ id: "public" }),
    rawProduct({ id: "inactive", ativo: false }),
    rawProduct({ id: "paused", status: "paused" }),
    rawProduct({ id: "truthy-active", ativo: 1 }),
  ]);
  assert.deepEqual(products.map(product => product.id), ["public"]);
});

test("Curator-originated rows require persisted human proof bound to the current image", () => {
  const withoutApproval = rawProduct({ id: "curator-no-approval", created_by: "autonomous_curator_queue" });
  assert.equal(toPublicProductDTO(withoutApproval), null);

  const approved = rawProduct({
    id: "curator-approved",
    created_by: "autonomous_curator_queue",
    human_editorial_approved_at: "2026-09-08T12:00:00.000Z",
    human_editorial_image_url: image,
    human_editorial_image_fingerprint: fingerprint,
    human_editorial_review_id: "review-1",
    human_editorial_authorization_id: "authorization-1",
  });
  assert.equal(toPublicProductDTO(approved)?.id, "curator-approved");
  assert.equal(toPublicProductDTO({ ...approved, imagens: ["https://cdn.example.com/changed.jpg"] }), null);
});
