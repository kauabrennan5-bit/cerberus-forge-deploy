import requests

url = "https://cerberus-static-catalog.onrender.com/data/products.json"
try:
    r = requests.get(url, timeout=10)
    print(f"Status Code: {r.status_code}")
    products = r.json()
    print(f"Total products in remote JSON: {len(products)}")
    for p in products:
        print(f"- ID: {p.get('id')} | Produto: {p.get('produto')} | Preço: {p.get('preco')}")
        if 'ref' in p or 'reference' in p:
            print(f"  Ref: {p.get('ref') or p.get('reference')}")
except Exception as e:
    print(f"Error fetching remote JSON: {e}")
