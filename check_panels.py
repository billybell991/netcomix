import psycopg2, os
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
issue_id = "tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero"
cur.execute("SELECT pages FROM issues WHERE id=%s", (issue_id,))
pages = cur.fetchone()[0]
conn.close()

# show panel key format from first panel found
for p in pages:
    if p.get("panels"):
        print("Panel keys:", list(p["panels"][0].keys()))
        break

for i, p in enumerate(pages):
    panels = p.get("panels", [])
    if i < 2 or i > 8:
        continue
    pw = p.get("width", p.get("w", 1))
    ph = p.get("height", p.get("h", 1))
    print(f"Page {i}: {len(panels)} panels  (page {pw}x{ph})")
    for j, pan in enumerate(panels):
        x0 = pan.get("x0", pan.get("x", 0))
        y0 = pan.get("y0", pan.get("y", 0))
        x1 = pan.get("x1", x0 + pan.get("w", pan.get("width", 0)))
        y1 = pan.get("y1", y0 + pan.get("h", pan.get("height", 0)))
        w = x1 - x0; h = y1 - y0
        ratio = w / pw if pw else 0
        print(f"  P{j}: ({x0},{y0})-({x1},{y1})  w={w} h={h}  w/pageW={ratio:.2f}")
