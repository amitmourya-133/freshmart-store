#!/usr/bin/env python3
import os
import re

os.chdir('D:\\vegetable store')

# Check JS files for secrets
js_files = ['script.js', 'admin.js', 'api.js', 'features.js', 'help.js', 'subscription.js']

print("=" * 60)
print("JAVASCRIPT SECURITY SCAN")
print("=" * 60)

for f in js_files:
    if not os.path.exists(f):
        print(f"\n{f}: NOT FOUND")
        continue
    
    print(f"\n--- {f} ---")
    with open(f, 'r', encoding='utf-8', errors='replace') as fh:
        content = fh.read()
    
    issues = []
    
    # Check for embedded JWT secrets
    jwt_patterns = [
        r'["\']?jwt["\']?\s*[:=]\s*["\']?[a-zA-Z0-9_\-.]+["\']?',
        r'["\']?jwt_secret["\']?\s*[:=]\s*["\']?',
        r'["\']?secret\s*[:=]\s*["\']?[a-zA-Z0-9]{20,}["\']?',
    ]
    for pattern in jwt_patterns:
        matches = re.findall(pattern, content, re.IGNORECASE)
        for m in matches:
            if len(m) > 10 and not m.startswith('change') and not m.endswith('_example'):
                issues.append(f'possible JWT secret: {m[:20]}...')
    
    # Check for Google API keys/secrets
    if 'google' in content.lower():
        if re.search(r'AIza[0-9_.-]{35}', content):
            issues.append('possible Google API key (AIza...)')
        if 'client_secret' in content.lower():
            issues.append('Google client_secret reference found')
    
    # Check for Cloudinary keys
    if 'cloudinary' in content.lower():
        issues.append('Cloudinary reference found in JS')
    
    # Check for Razorpay keys
    if 'razorpay' in content.lower():
        issues.append('Razorpay reference found in JS')
    
    # Check for email passwords
    if re.search(r['"\"?EMAIL_PASS|EMAIL_USER["\']?\s*[:=]\s*["\']', content]:
        issues.append('email credentials possibly in JS')
    
    # Check for console.log that might leak data
    log_lines = [i+1 for i, l in enumerate(content.split('\n')) if 'console.log' in l]
    if log_lines:
        issues.append(f'console.log at {len(log_lines)} line(s)')
    
    # Check for hardcoded URLs with credentials
    if re.search(r'mongodb://', content):
        issues.append('MongoDB URI possibly in JS')
    
    if issues:
        # Deduplicate
        unique_issues = list(set(issues))
        print(f'  Issues: {", ".join(unique_issues)}')
    else:
        print('  No obvious secrets embedded in JavaScript')
    
print("\n" + "=" * 60)
print("Scan complete.")
print("=" * 60)