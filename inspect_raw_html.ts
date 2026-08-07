import fetch from 'node-fetch';

async function inspect(url: string, userAgent: string) {
  console.log("------------------------------------------");
  console.log("FETCHING:", url);
  console.log("WITH UA:", userAgent);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      },
      redirect: "follow"
    });
    console.log("Status:", res.status, "Final URL:", res.url);
    const html = await res.text();
    console.log("HTML length:", html.length);

    // Find JSON-LD
    const jsonLds = html.match(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    console.log("JSON-LD count:", jsonLds.length);
    for (let i = 0; i < jsonLds.length; i++) {
      console.log(`--- JSON-LD #${i+1} ---`);
      console.log(jsonLds[i].replace(/<[^>]+>/g, "").slice(0, 500));
    }

    // Find OG tags
    const ogMetas = html.match(/<meta\s+(?:property|name|itemprop)=["'](?:og:[^"']+|product:[^"']+|twitter:[^"']+|price[^"']*)["']\s+content=["']([^"']+)["']/gi) ||
                    html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name|itemprop)=["'](?:og:[^"']+|product:[^"']+|twitter:[^"']+|price[^"']*)["']/gi) || [];
    console.log("OG Metas count:", ogMetas.length);
    ogMetas.forEach(m => console.log("META:", m));

    // Find script tags with state or data
    const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    const dataScripts = scripts.filter(s => s.includes("image") || s.includes("price") || s.includes("D_NQ_NP") || s.includes("susercontent"));
    console.log("Scripts with image/price count:", dataScripts.length);
    if (dataScripts.length > 0) {
      console.log("Sample script content snippet:", dataScripts[0].slice(0, 400));
    }

    // Find Mercado Livre images (D_NQ_NP)
    const mlImgs = [...html.matchAll(/https:\/\/http2\.mlstatic\.com\/D_NQ_NP_[^"'\s\)\\]+/gi)].map(m => m[0]);
    console.log("ML Imgs raw count:", mlImgs.length);
    if (mlImgs.length > 0) {
      console.log("Sample ML Imgs:", [...new Set(mlImgs)].slice(0, 5));
    }

    // Find Shopee images (susercontent)
    const shopeeImgs = [...html.matchAll(/https:\/\/(?:down-br\.img\.susercontent\.com|sg-11134201-[^"'\s\\]+|cf\.shopee\.com\.br)\/file\/[a-zA-Z0-9_\-]+/gi)].map(m => m[0]);
    console.log("Shopee Imgs raw count:", shopeeImgs.length);
    if (shopeeImgs.length > 0) {
      console.log("Sample Shopee Imgs:", [...new Set(shopeeImgs)].slice(0, 5));
    }

  } catch (err) {
    console.error("Fetch Error:", err);
  }
}

async function run() {
  // Mercado Livre catalog product URL
  await inspect(
    "https://www.mercadolivre.com.br/tenis-casual-masculino-urbano-streetwear-preto/p/MLB28509431",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  // Mercado Livre item listing URL
  await inspect(
    "https://produto.mercadolivre.com.br/MLB-3564024329-tenis-oversized-casual-streetwear-preto-e-branco-_JM",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  // Shopee URL with Googlebot / WhatsApp bot UA
  await inspect(
    "https://shopee.com.br/Camiseta-Oversized-Streetwear-100-Algod%C3%A3o-Pima-100-Original-i.404286121.23390382910",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
  );

  await inspect(
    "https://shopee.com.br/Camiseta-Oversized-Streetwear-100-Algod%C3%A3o-Pima-100-Original-i.404286121.23390382910",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
  );
}

run();
