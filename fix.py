with open('D:\\vegetable store\\routes\\deliveryRoutes.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()
# Fix line 203 (index 202) - change '        });' to '        }'
for i, line in enumerate(lines):
    if i == 202:  # line 203 (0-indexed = 202)
        if '});' in line:
            lines[i] = line.replace('});', '}')
            print(f"Fixed line {i+1}: {line.strip()!r} -> {lines[i].strip()!r}")
with open('D:\\vegetable store\\routes\\deliveryRoutes.js', 'w', encoding='utf-8') as f:
    f.writelines(lines)
print("Done")