import requests

url = "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products"
try:
    r = requests.get(url, timeout=10)
    print(f"Status Code: {r.status_code}")
    payload = r.json()
    products = payload if isinstance(payload, list) else payload.get("products", payload.get("data", []))
    print(f"Total products in canonical public API: {len(products)}")
    for p in products:
        print(f"- ID: {p.get('id')} | Produto: {p.get('produto')} | Preço: {p.get('preco')}")
        if 'ref' in p or 'reference' in p:
            print(f"  Ref: {p.get('ref') or p.get('reference')}")
except Exception as e:
    print(f"Error fetching canonical public API: {e}")
