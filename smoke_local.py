#!/usr/bin/env python3
import json, urllib.request, urllib.error

BASE = "http://localhost:5000"

def get(path, headers=None):
    req = urllib.request.Request(BASE + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return 0, str(e)

tests = [
    ("/api/health", "health"),
    ("/api/products", "products"),
    ("/api/delivery/status", "delivery status (GET, no auth)"),
    ("/api/delivery/proof-image", "proof-image GET (no auth)"),
    ("/api/delivery/management/partners", "mgmt partners GET (no auth)"),
    ("/api/delivery/management/today", "mgmt today GET (no auth)"),
]

for path, label in tests:
    code, body = get(path)
    snippet = body[:140].replace('\n', ' ')
    print("%-42s -> %s  %s" % (label, code, snippet))
    if code == 200:
        try:
            j = json.loads(body)
            if j.get('success') in (True, False):
                print("   success:", j['success'])
            if 'data' in j and isinstance(j['data'], list):
                print("   data len:", len(j['data']))
            if path == "/api/products":
                veg = [p for p in j['data'] if p.get('category', '').lower() == 'vegetables']
                print("   vegetables:", len(veg), "| first:", veg[0].get('name') if veg else None)
        except json.JSONDecodeError:
            pass
    print()