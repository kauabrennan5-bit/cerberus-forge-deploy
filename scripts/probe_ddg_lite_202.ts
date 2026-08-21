import axios from "axios";

async function probe() {
  const url = "https://duckduckgo.com/lite/";
  const query = "site:shopee.com.br/product organizador cozinha";
  
  console.log(`\n🔍 [Probe] Testando DuckDuckGo Lite (Diagnóstico 202)...`);
  
  try {
    const response = await axios.get(url, {
      params: { q: query },
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://duckduckgo.com/",
        "DNT": "1",
        "Upgrade-Insecure-Requests": "1"
      }
    });
    
    console.log(`✅ [Probe] Status HTTP: ${response.status}`);
    console.log(`📄 [Probe] Amostra do HTML (500 chars): ${response.data.substring(0, 500)}`);
  } catch (error: any) {
    if (error.response) {
      console.error(`❌ [Probe] Erro HTTP ${error.response.status}: ${error.response.statusText}`);
      console.error(`📝 [Probe] Cabeçalhos de Resposta:`, error.response.headers);
    } else {
      console.error(`❌ [Probe] Erro: ${error.message}`);
    }
  }
}

probe();
