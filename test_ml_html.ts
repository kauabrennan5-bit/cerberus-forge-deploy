import fetch from 'node-fetch';

async function testMLHtml() {
  const url = "https://produto.mercadolivre.com.br/MLB-3564024329-tenis-oversized-casual-streetwear-preto-e-branco-_JM";

  const configs = [
    {
      name: "Desktop Chrome full headers",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1"
      }
    },
    {
      name: "Mobile iPhone Safari",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9"
      }
    },
    {
      name: "Mobile Android Chrome",
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9",
        "Sec-Ch-Ua-Mobile": "?1"
      }
    },
    {
      name: "MercadoLivre App UA",
      headers: {
        "User-Agent": "MercadoLivre/10.0.0 Android/10",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    }
  ];

  for (const c of configs) {
    console.log("---------------------------------------");
    console.log("Config:", c.name);
    try {
      const res = await fetch(url, { headers: c.headers, redirect: "follow" });
      const html = await res.text();
      console.log("Status:", res.status, "Final URL:", res.url);
      console.log("Is account-verification?", res.url.includes("account-verification"));
      console.log("HTML length:", html.length);
      
      // Check for price or images in HTML
      const priceMeta = html.match(/<meta\s+(?:property|name|itemprop)=["'](?:og:price:amount|product:price:amount|price)["']\s+content=["']([^"']+)["']/i);
      console.log("Price Meta:", priceMeta?.[1]);

      const imgs = [...html.matchAll(/https:\/\/http2\.mlstatic\.com\/D_NQ_NP_[^"'\s\)\\]+/gi)].map(m => m[0]);
      console.log("Images found count:", new Set(imgs).size);
    } catch (e: any) {
      console.error("Error:", e.message);
    }
  }
}

testMLHtml();
