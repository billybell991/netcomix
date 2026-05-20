import json
ij = json.load(open('public/comics/tales-from-the-crypt-v2/tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero/issue.json'))
print('id:', ij['id'])
total_panels = sum(len(p.get('panels', [])) for p in ij['pages'])
print('total panels across all pages:', total_panels)
for i, p in enumerate(ij['pages']):
    if p.get('panels'):
        print(f'first page with panels: page {i+1} with {len(p["panels"])} panels')
        break
else:
    print('NO PANELS FOUND')
