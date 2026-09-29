#!/usr/bin/env python3
import os, re
os.chdir(r'D:\vegetable store')

targets = []
for root, dirs, files in os.walk('.'):
    if 'node_modules' in root or '.git' in root or 'images' in root or 'groceries' in root:
        continue
    for f in files:
        if f.endswith(('.html', '.js', '.css')):
            targets.append(os.path.join(root, f))

print('scanning', len(targets), 'files for HTML-entity corruption...')
for t in targets:
    with open(t, 'rb') as fh:
        b = fh.read()
    try:
        c = b.decode('utf-8', errors='replace')
    except Exception:
        continue
    # Patterns indicating entity values were decoded into broken JS:
    # map values that should be &amp; &lt; &gt; &quot; &#39;
    broken = []
    for m in re.finditer(r'["\']:[ \t]*["\']<["\']', c):
        broken.append(m.group(0))
    for m in re.finditer(r'["\']:[ \t]*["\']&["\']', c):
        broken.append(m.group(0))
    for m in re.finditer(r'["\']:[ \t]*""+"', c):
        broken.append(m.group(0))
    # bare &quot; style:  '"': """  (three double quotes)
    for m in re.finditer(r'"\'\'\': "[^",}]*"', c):
        broken.append(m.group(0))
    if broken:
        print(t, '->', set(broken))