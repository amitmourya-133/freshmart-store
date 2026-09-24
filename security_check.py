#!/usr/bin/env python3
import os
import re

os.chdir('D:\\vegetable store')

files = [
    'index.html', 'login.html', 'signup.html', 'checkout.html',
    'orders.html', 'admin.html', 'product-detail.html', 'help.html',
    'profile.html', 'subscription.html', 'delivery.html'
]

print("=" * 60)
print("FRESHMART SECURITY VERIFICATION")
print("=" * 60)

for f in files:
    if not os.path.exists(f):
        print(f"\n{f}: NOT FOUND")
        continue
    
    print(f"\n--- {f} ---")
    with open(f, 'r', encoding='utf-8', errors='replace') as fh:
        content = fh.read()
    
    issues = []
    
    # Check for embedded secrets
    # Passwords in plain text
    pwd_patterns = ['password\s*[:=]\s*["\' ]', 'passwd\s*[:=]\s*["\' ]']
    for pattern in pwd_patterns:
        matches = re.findall(pattern, content, re.IGNORECASE)
        if matches:
            issues.append(f'potential password field in HTML')
    
    # JWT secrets
    if 'freshmart_secret' in content.lower() or 'your_jwt_secret' in content.lower():
        issues.append('JWT secret placeholder found in HTML')
    
    # API keys
    if re.search(r'[\"\']?api[_-]?key["\']?\s*[:=]\s*["\']', content, re.IGNORECASE):
        issues.append('potential API key in HTML')
    
    # Google client ID/secret
    if re.search(r'google_client_id|google_client_secret', content, re.IGNORECASE):
        issues.append('Google OAuth credentials in HTML')
    
    # Debug mode
    if re.search(r'debug\s*[:=]\s*true', content, re.IGNORECASE):
        issues.append('debug mode enabled in HTML')
    
    # Console logs with sensitive data
    if 'console.log' in content:
        # Check if console.log might output sensitive data
        lines_with_log = [i+1 for i, l in enumerate(content.split('\n')) if 'console.log' in l]
        if lines_with_log:
            issues.append(f'console.log found at {len(lines_with_log)} line(s)')
    
    # Meta tags security
    # Check for proper charset
    if 'charset' not in content.lower().split('<meta')[0]:
        issues.append('missing or improper charset meta tag')
    
    # X-Frame-Options etc are server-side, but check if meta frames exist
    if re.search(r'[\"\']?frame[\"\']?', content, re.IGNORECASE):
        issues.append('potential frame injection concern')
    
    # Content Security Policy meta
    if 'content-security-policy' not in content.lower() and 'strict-dynamic' not in content.lower():
        issues.append('no Content-Security-Policy meta tag (server should handle this)')
    
    if issues:
        print(f'  Issues: {", ".join(set(issues))}')
    else:
        print('  No obvious security issues in HTML content')
    
print("\n" + "=" * 60)
print("Verification complete.")
print("=" * 60)
PYEOF