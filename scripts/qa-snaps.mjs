/**
 * QA script: fetch the live issue from the Railway API and print the
 * snap count produced by expandWidePanels for every page.
 *
 * Usage:
 *   node scripts/qa-snaps.mjs [issueId]
 *
 * Default issueId: tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero
 */

const API_URL   = "https://netcomix-api-production.up.railway.app";
const ACCESS    = "comix2026";
const ISSUE_ID  = process.argv[2] ?? "tales-from-the-crypt-v2-01-papercutz-2007-wildbluezero";
const WIDE = 0.85;
const Y_TOL = 5;

// ─── Replica of expandWidePanels (must stay in sync with src/library.ts) ─────

function expandWidePanels(manifest) {
  const pages = manifest.pages.map((page) => {
    if (!page.width || page.panels.length === 0) return page;
    const expanded = [];
    const halfW = Math.round(page.width / 2);
    for (let i = 0; i < page.panels.length; i++) {
      const panel = page.panels[i];
      let j = i + 1;
      while (j < page.panels.length && Math.abs(page.panels[j].y - panel.y) <= Y_TOL) j++;
      const subCount = j - i - 1;
      const isWide = panel.w / page.width >= WIDE;

      if (subCount > 0 || isWide) {
        expanded.push(
          { x: 0,     y: panel.y, w: halfW,              h: panel.h, centerX: Math.round(halfW / 2),                        centerY: panel.centerY },
          { x: halfW, y: panel.y, w: page.width - halfW, h: panel.h, centerX: Math.round(halfW + (page.width - halfW) / 2), centerY: panel.centerY },
        );
        i = j - 1;
      } else {
        expanded.push(panel);
      }
    }
    return { ...page, panels: expanded };
  });
  return { ...manifest, pages };
}

// ─── Fetch + report ──────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching ${API_URL}/api/issue/${ISSUE_ID} …\n`);

  const res = await fetch(`${API_URL}/api/issue/${ISSUE_ID}`, {
    headers: { Authorization: `Bearer ${ACCESS}` },
  });
  if (!res.ok) throw new Error(`API returned ${res.status}: ${await res.text()}`);

  const raw = await res.json();
  const manifest = expandWidePanels(raw);

  console.log(`Issue: ${manifest.title}  (${manifest.pages.length} pages)\n`);
  // Analyse raw panels to count wide-rows vs narrow standalones per page.
  function analyseRaw(page) {
    if (!page.width || page.panels.length === 0) return { wideRows: 0, narrows: 0 };
    let wideRows = 0, narrows = 0;
    for (let i = 0; i < page.panels.length; ) {
      const panel = page.panels[i];
      let j = i + 1;
      while (j < page.panels.length && Math.abs(page.panels[j].y - panel.y) <= Y_TOL) j++;
      const subCount = j - i - 1;
      const isWide = panel.w / page.width >= WIDE;
      if (subCount > 0 || isWide) wideRows++;
      else narrows++;
      i = j;
    }
    return { wideRows, narrows };
  }

  console.log("Page | Raw | Snaps | Wide rows | Narrows | Notes");
  console.log("-----+-----+-------+-----------+---------+------");

  let warnings = 0;
  for (let i = 0; i < manifest.pages.length; i++) {
    const rawPage = raw.pages[i];
    const expPage = manifest.pages[i];
    const rawCount = rawPage.panels.length;
    const snapCount = expPage.panels.length;
    const { wideRows, narrows } = analyseRaw(rawPage);
    const expected = wideRows * 2 + narrows;

    let note = "";
    if (rawCount === 0) {
      note = "full-page (cover/splash)";
    } else if (snapCount !== expected) {
      note = `⚠ expected ${expected}, got ${snapCount}`;
      warnings++;
    } else if (narrows === rawCount && rawCount > 2) {
      note = `⚠ all ${rawCount} panels narrow — sub-panel detection may have failed`;
      warnings++;
    }

    const pageNum = String(i + 1).padStart(4);
    const rawStr   = String(rawCount).padStart(4);
    const snapStr  = String(snapCount).padStart(5);
    const wideStr  = String(wideRows).padStart(9);
    const narrStr  = String(narrows).padStart(7);
    console.log(`${pageNum} |${rawStr} |${snapStr} |${wideStr} |${narrStr} | ${note}`);
  }

  console.log(`\n${warnings === 0 ? "✅ All pages look correct." : `⚠ ${warnings} page(s) need review.`}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
