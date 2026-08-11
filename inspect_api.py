import requests

url = "https://cerberus-forge-deploy.onrender.com/api/products"
try:
    r = requests.get(url, timeout=10)
    print(f"Status Code: {r.status_code}")
    res = r.json()
    print("Response type:", type(res))
    if isinstance(res, dict):
        print("Dict keys:", list(res.keys()))
        products = res.get('products', res.get('data', []))
    elif isinstance(res, list):
        products = res
    else:
        products = []

    print(f"Total products in Web Service API: {len(products)}")
    for p in products:
        print(f"- ID: {p.get('id')} | Ref: {p.get('ref')} | Produto: {p.get('produto')} | Preço: {p.get('preco')}")
except Exception as e:
    print(f"Error fetching API: {e}")
