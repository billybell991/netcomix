import json

WIDE_PANEL_RATIO = 0.85
PANEL_Y_TOLERANCE = 5

data = json.load(open('c:/Stuff/NetComix/public/comics/tales-from-the-crypt-v2-01-papercutz/tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero/issue.json'))
page = data['pages'][6]
panels = page['panels']
width = page['width']
halfW = round(width / 2)

print("Page 7 width:", width, "panels:", len(panels))
for p in panels:
    print("  panel y=%d w=%d ratio=%.3f" % (p['y'], p['w'], p['w']/width))

print()
expanded = []
i = 0
while i < len(panels):
    panel = panels[i]
    j = i + 1
    while j < len(panels) and abs(panels[j]['y'] - panel['y']) <= PANEL_Y_TOLERANCE:
        j += 1
    subCount = j - i - 1
    isWide = panel['w'] / width >= WIDE_PANEL_RATIO
    print("i=%d panel y=%d w=%d isWide=%s subCount=%d" % (i, panel['y'], panel['w'], isWide, subCount))
    if subCount > 0 or isWide:
        expanded.append({'x': 0, 'y': panel['y'], 'w': halfW, 'h': panel['h']})
        expanded.append({'x': halfW, 'y': panel['y'], 'w': width - halfW, 'h': panel['h']})
        i = j - 1
    else:
        expanded.append(panel)
    i += 1

print("expanded:", len(expanded), "snaps")
