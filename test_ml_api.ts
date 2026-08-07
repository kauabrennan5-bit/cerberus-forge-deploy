import fetch from 'node-fetch';

async function testMLApi() {
  const itemUrl = "https://produto.mercadolivre.com.br/MLB-3564024329-tenis-oversized-casual-streetwear-preto-e-branco-_JM";
  const catalogUrl = "https://www.mercadolivre.com.br/tenis-casual-masculino-urbano-streetwear-preto/p/MLB28509431";

  // Extract MLB ID
  const itemIdMatch = itemUrl.match(/(MLB-?\d+)/i);
  const catalogIdMatch = catalogUrl.match(/(MLB\d+)/i);

  console.log("Item ID match:", itemIdMatch?.[1]);
  console.log("Catalog ID match:", catalogIdMatch?.[1]);

  if (itemIdMatch) {
    const rawId = itemIdMatch[1].replace("-", "");
    const apiRes = await fetch(`https://api.mercadolibre.com/items/${rawId}`);
    console.log("Item API Status:", apiRes.status);
    const itemData: any = await apiRes.json();
    console.log("Item API Title:", itemData.title);
    console.log("Item API Price:", itemData.price);
    console.log("Item API Base Price:", itemData.base_price);
    console.log("Item API Original Price:", itemData.original_price);
    console.log("Item API Pictures Count:", itemData.pictures?.length);
    console.log("Item API Sample Pictures:", itemData.pictures?.slice(0, 3).map((p: any) => p.secure_url || p.url));
  }

  if (catalogIdMatch) {
    const catalogId = catalogIdMatch[1];
    const apiRes = await fetch(`https://api.mercadolibre.com/products/${catalogId}`);
    console.log("\nCatalog API Status:", apiRes.status);
    const prodData: any = await apiRes.json();
    console.log("Catalog API Name:", prodData.name);
    console.log("Catalog API Pictures Count:", prodData.pictures?.length);
    console.log("Catalog API Sample Pictures:", prodData.pictures?.slice(0, 3).map((p: any) => p.secure_url || p.url));
    console.log("Catalog API Buy Box / Price:", prodData.buy_box_winner?.price || prodData.price);
  }
}

testMLApi();
