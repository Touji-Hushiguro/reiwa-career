const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { exec } = require('child_process');

const app       = express();
const PORT      = 5501;
const SITE_ROOT = path.resolve(__dirname, '..');
const TMP_DIR   = path.join(__dirname, 'tmp');
const SLOTS_CFG = require('./slots.json');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({ dest: TMP_DIR });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/site', express.static(SITE_ROOT));

// ------------------------------------------------------------------ helpers

/**
 * スロットマーカー間のコンテンツを抽出し、現在 img が設定されているか確認
 */
function readSlotState(html, slotId) {
  const startTag = `<!-- SLOT:${slotId}:START -->`;
  const endTag   = `<!-- SLOT:${slotId}:END -->`;
  const si = html.indexOf(startTag);
  const ei = html.indexOf(endTag);
  if (si === -1 || ei === -1) return { found: false, src: null };

  const inner = html.slice(si + startTag.length, ei).trim();
  const m = inner.match(/<img[^>]+src="([^"]+)"/);
  return { found: true, src: m ? m[1] : null };
}

/**
 * HTML ファイルのスロットを新しい img タグ（または元のプレースホルダ）で書き換え
 */
function patchSlot(htmlPath, slotId, newInnerHtml) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const startTag = `<!-- SLOT:${slotId}:START -->`;
  const endTag   = `<!-- SLOT:${slotId}:END -->`;
  const si = html.indexOf(startTag);
  const ei = html.indexOf(endTag);
  if (si === -1 || ei === -1) throw new Error(`Slot "${slotId}" markers not found in ${htmlPath}`);

  html = html.slice(0, si + startTag.length) + '\n          ' + newInnerHtml + '\n          ' + html.slice(ei);
  fs.writeFileSync(htmlPath, html, 'utf8');
}

/**
 * スロットタイプ別の img タグを生成
 */
function makeImgTag(type, src, label) {
  const base = { alt: label || '', loading: 'lazy' };
  switch (type) {
    case 'placeholder':
      return `<img src="${src}" alt="${base.alt}" loading="${base.loading}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;">`;
    case 'photo-circle':
      return `<img src="${src}" alt="${base.alt}" loading="${base.loading}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    case 'voice-thumb':
      return `<img src="${src}" alt="${base.alt}" loading="${base.loading}" style="width:100%;height:160px;object-fit:cover;display:block;border-radius:var(--radius-md,8px) var(--radius-md,8px) 0 0;">`;
    case 'cta-illust':
      return `<img src="${src}" alt="${base.alt}" loading="${base.loading}" style="width:100%;max-width:260px;height:auto;display:block;margin:0 auto;">`;
    default:
      return `<img src="${src}" alt="${base.alt}" loading="${base.loading}" style="width:100%;height:100%;object-fit:cover;display:block;">`;
  }
}

/**
 * ページの全スロット状態を返す
 */
function getPageSlotStates(page) {
  const htmlPath = path.join(SITE_ROOT, page.htmlFile);
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';

  return page.slots.map(slot => {
    if (slot.type === 'file-replace') {
      const filePath = path.join(SITE_ROOT, slot.targetFile);
      const exists = fs.existsSync(filePath);
      return {
        ...slot,
        src: exists ? `/${slot.targetFile}?t=${Date.now()}` : null,
        hasImage: exists
      };
    }
    const { found, src } = readSlotState(html, slot.id);
    return { ...slot, src: src ? src + `?t=${Date.now()}` : null, hasImage: !!src, found };
  });
}

// ------------------------------------------------------------------ API

// GET /api/pages
app.get('/api/pages', (_req, res) => {
  const pages = SLOTS_CFG.pages.map(p => ({ id: p.id, label: p.label, icon: p.icon }));
  res.json({ pages });
});

// GET /api/slots/:pageId
app.get('/api/slots/:pageId', (req, res) => {
  const page = SLOTS_CFG.pages.find(p => p.id === req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  try {
    res.json({ slots: getPageSlotStates(page) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/slots/:pageId/:slotId  (upload image → patch HTML)
app.post('/api/slots/:pageId/:slotId', upload.single('file'), (req, res) => {
  try {
    const { pageId, slotId } = req.params;
    const page = SLOTS_CFG.pages.find(p => p.id === pageId);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    const slot = page.slots.find(s => s.id === slotId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (!req.file)  return res.status(400).json({ error: 'No file uploaded' });

    const ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const filename = `${slotId}${ext}`;
    const destDir  = path.join(SITE_ROOT, 'images', pageId);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, filename);
    fs.renameSync(req.file.path, dest);

    const webPath = `/images/${pageId}/${filename}`;

    if (slot.type === 'file-replace') {
      // 直接上書き（fv-bg.jpg など）
      fs.copyFileSync(dest, path.join(SITE_ROOT, slot.targetFile));
    } else {
      // HTML のスロットマーカーを書き換え
      const htmlPath = path.join(SITE_ROOT, page.htmlFile);
      const imgTag   = makeImgTag(slot.type, webPath, slot.label);
      patchSlot(htmlPath, slotId, imgTag);
    }

    res.json({ success: true, src: webPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/slots/:pageId/:slotId  (restore placeholder)
app.delete('/api/slots/:pageId/:slotId', (req, res) => {
  try {
    const { pageId, slotId } = req.params;
    const page = SLOTS_CFG.pages.find(p => p.id === pageId);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    const slot = page.slots.find(s => s.id === slotId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });

    if (slot.type === 'file-replace') {
      // file-replace は削除不可（元ファイルが壊れるため）
      return res.status(400).json({ error: 'Cannot delete a file-replace slot. Upload a new image to replace it.' });
    }

    const placeholder = getDefaultPlaceholder(slot.type, slot.label);
    const htmlPath = path.join(SITE_ROOT, page.htmlFile);
    patchSlot(htmlPath, slotId, placeholder);

    // 画像ファイルも削除
    const ext = ['jpg','jpeg','png','webp','gif','svg','avif'];
    ext.forEach(e => {
      const f = path.join(SITE_ROOT, 'images', pageId, `${slotId}.${e}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getDefaultPlaceholder(type, label) {
  const svgPhoto = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
  const svgImage = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;
  switch (type) {
    case 'photo-circle':
      return `<div class="advisor-photo-placeholder">${svgPhoto}<span>写真</span></div>`;
    case 'voice-thumb':
      return `${svgImage}<span>転職成功者写真（こちらに画像が入ります）</span>`;
    case 'cta-illust':
      return `<div class="cta-campaign-illust"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg><span>キャンペーンイラスト<br>（こちらに画像が入ります）</span></div>`;
    default:
      return `<div class="img-placeholder">${svgImage}<span>（こちらに画像が入ります）</span></div>`;
  }
}

// POST /api/publish
app.post('/api/publish', (req, res) => {
  const msg = (req.body.message || '画像を更新').replace(/"/g, '\\"');
  const cmd = [
    `cd "${SITE_ROOT}"`,
    'git add -A',
    `git diff --cached --quiet && echo "NOTHING" || git commit -m "chore: ${msg}"`,
    'git push origin main'
  ].join(' && ');

  exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && !stdout.includes('NOTHING')) {
      return res.status(500).json({ error: stderr || err.message });
    }
    const nothing = stdout.includes('NOTHING');
    res.json({ success: true, nothing, output: stdout + stderr });
  });
});

// ------------------------------------------------------------------ start
app.listen(PORT, () => {
  console.log(`\n✅ れいキャリ 画像管理パネル`);
  console.log(`   http://localhost:${PORT}\n`);
});
