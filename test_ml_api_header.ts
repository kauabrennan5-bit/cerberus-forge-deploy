import fetch from 'node-fetch';

async function testMLApiHeader() {
  const url = "https://api.mercadolibre.com/items/MLB3564024329";
  console.log("Fetching API:", url);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json"
      }
    });
    console.log("Status:", res.status);
    const json: any = await res.json();
    console.log("Title:", json.title);
    console.log("Price:", json.price);
    console.log("Original Price:", json.original_price);
    console.log("Pictures count:", json.pictures?.length);
    console.log("Sample pictures:", json.pictures?.map((p: any) => p.secure_url || p.url));
  } catch (e: any) {
    console.error("API error:", e);
  }
}

testMLApiHeader();
