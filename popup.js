console.log('[Brand Inspector] popup loaded');

// ---------- helpers ----------
function showError(err){
  const box = document.getElementById('errorBox');
  const wrap = document.getElementById('errors');
  if (box && wrap) { box.textContent = String(err || 'Unknown error'); wrap.style.display = 'block'; }
  console.error('[Brand Inspector]', err);
}
function isRestrictedUrl(url){
  return url.startsWith('chrome://') ||
         url.startsWith('edge://') ||
         url.startsWith('about:') ||
         url.startsWith('chrome-extension://') ||
         url.includes('chrome.google.com/webstore');
}
async function getActiveTab(){
  const tabs = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tabs || !tabs.length) throw new Error('No active tab');
  return tabs[0];
}
async function runOnActiveTab(func, args = []) {
  let tab;
  try { tab = await getActiveTab(); }
  catch(e){ showError('tabs.query failed: ' + (chrome.runtime?.lastError?.message || e)); throw e; }

  if (!tab?.id || !tab.url) { const msg = 'No active tab or URL unavailable.'; showError(msg); throw new Error(msg); }
  if (isRestrictedUrl(tab.url)) { const msg = 'Injection blocked on this URL: ' + tab.url + '\nВідкрий http(s) сторінку і повтори Scan.'; showError(msg); throw new Error(msg); }

  try {
    const [{result}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args
    });
    return result;
  } catch(e){
    showError('scripting.executeScript failed: ' + (chrome.runtime?.lastError?.message || e));
    throw e;
  }
}
function copyText(text) { navigator.clipboard.writeText(text).catch(() => {}); }
function downloadJSON(obj, filename='brand.json') {
  const data = new Blob([JSON.stringify(obj, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(data);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ---------- Figma / tokens ----------
function fontsPlain(list){ if (!list?.length) return ''; return [...new Set(list.map(f=>f.name))].join(', '); }
function toTokens(state){
  const colors = state?.colors || {};
  return {
    brand: state?.brand || '',
    keywords: state?.keywords || [],
    description: state?.description || '',
    fonts: [...new Set((state?.fonts||[]))],
    colors: {
      primary: colors.primary || '',
      secondary: colors.secondary || '',
      accent: colors.accent || '',
      background: colors.background || '',
      foreground: colors.foreground || '',
      text: colors.text || ''
    },
    logos: state?.logos || {}
  };
}
function figmaBlock(state){
  const t = toTokens(state);
  return [
    `Brand: ${t.brand || '—'}`,
    t.keywords?.length ? `Keywords: ${t.keywords.join(', ')}` : 'Keywords: —',
    `Description: ${state?.description || '—'}`,
    '',
    'Fonts:',
    (t.fonts?.length ? t.fonts.map(n=>'• '+n).join('\n') : '—'),
    '',
    'Colors:',
    `• Primary: ${t.colors.primary || '—'}`,
    `• Secondary: ${t.colors.secondary || '—'}`,
    `• Accent: ${t.colors.accent || '—'}`,
    `• Background: ${t.colors.background || '—'}`,
    `• Foreground: ${t.colors.foreground || '—'}`,
    `• Text: ${t.colors.text || '—'}`
  ].join('\n');
}

// ---------- UI events ----------
document.addEventListener('DOMContentLoaded', () => {
  const $ = (id)=>document.getElementById(id.startsWith ? (id.startsWith('#')?id.slice(1):id) : id);
  const on = (id,type,fn)=>{ const el=$(id); if(el) el.addEventListener(type,fn); };

  on('scan','click', ()=>{ try{ scan(); }catch(e){ showError(e); } });
  on('copyKeywords','click', ()=> copyText($('#keywords').textContent.trim()));
  on('copyDescription','click', ()=> copyText($('#description').textContent.trim()));
  on('copyFonts','click', ()=> copyText((window.__brandState?.fonts||[]).join(', ')));

  // сховати верхні Export / Copy JSON
  const topCopyJson = $('#copyTokens'); if (topCopyJson) topCopyJson.style.display = 'none';
  const topExport = $('#exportJson');   if (topExport)   topExport.style.display   = 'none';

  // кнопка "Copy all colors" (якщо існує у розмітці)
  on('copyAllColors','click', ()=>{
    const pal = (window.__brandState?.colors)||{};
    const css = `:root{\n${Object.entries(pal).map(([k,v])=>`  --${k}: ${v};`).join('\n')}\n}`;
    const json = JSON.stringify(pal, null, 2);
    copyText(css + '\n\n' + json);
  });

  const copyFigmaBtn = $('#copyFigma');
  if (copyFigmaBtn) copyFigmaBtn.addEventListener('click', ()=> copyText(figmaBlock(window.__brandState)));
});

// ---------- main ----------
async function scan() {

  // Load stopwords.json from extension
  if (!window.__STOPWORDS) {
    try {
      const url = chrome.runtime.getURL('stopwords.json');
      const file = await fetch(url);
      const json = await file.json();
      window.__STOPWORDS = new Set(json.stopwords || []);
    } catch(e) {
      console.warn('Stopwords load failed:', e);
      window.__STOPWORDS = new Set();
    }
  }

  const data = await runOnActiveTab(
    (STOPWORDS) => {
      const decode = (s) => {
        const el = document.createElement('textarea');
        el.innerHTML = s || '';
        return el.value;
      };
      // helper — URL на тому ж домені
      const sameHost = (u) => {
        try { return new URL(u, location.href).hostname === location.hostname; }
        catch(e){ return false; }
      };
      const getMeta = (selector) => document.querySelector(selector)?.content?.trim() || "";
      const abs = (u) => { try { return new URL(u, location.href).href; } catch(e) { return ""; } };

    // ---- JSON-LD Organization.logo
    const jsonLdLogos = (() => {
      const urls = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try {
          const json = JSON.parse(s.textContent);
          const arr = Array.isArray(json) ? json : [json];
          arr.forEach(obj => {
            const visit = (o) => {
              if (!o || typeof o !== 'object') return;
              if (o['@type'] === 'Organization' && o.logo) {
                if (typeof o.logo === 'string') urls.push(abs(o.logo));
                else if (o.logo?.url) urls.push(abs(o.logo.url));
              }
              Object.values(o).forEach(v => { if (v && typeof v === 'object') visit(v); });
            };
            visit(obj);
          });
        } catch(e){}
      });
      return urls.filter(Boolean);
    })();

    // ---- Logo candidates
    const logoLinks = [
      ...document.querySelectorAll('link[rel~="icon"], link[rel="icon"], link[rel="apple-touch-icon"], link[rel*="mask-icon"]')
    ].map(l => abs(l.getAttribute('href'))).filter(Boolean);
    const ogImage = getMeta('meta[property="og:image"]');
    const imageSrc = document.querySelector('link[rel="image_src"]')?.getAttribute('href') || "";
    const good = /(header|topbar|masthead|site-brand|navbar|brand)/i;
    const bad  = /(footer|partners|clients|brands|sponsors|carousel|gallery|grid)/i;
    const imgLogos = [...document.images].filter(img=>{
      const bag = (img.alt||'') + ' ' + (img.className||'') + ' ' + (img.id||'');
      if (!/logo/i.test(bag)) return false;
      const src = abs(img.currentSrc || img.src);
      if (!src || !sameHost(src)) return false;

      const ancEl = img.closest('[class], header, nav, footer');
      const anc = (ancEl && (ancEl.className||'')) || '';
      if (bad.test(anc)) return false;

      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w && h) {
        const ar = w/h;
        if (ar < 0.3 || ar > 4) return false;         // занадто витягнуті
        if (w*h > 600*400) return false;              // імовірно банер
      }
      return good.test(anc) || /logo/i.test(bag);
    }).map(img => abs(img.currentSrc || img.src));
    const svgLogos = [...document.querySelectorAll('svg')]
      .filter(s => {
        const id = s.id || '';
        const cls = s.getAttribute('class') || '';
        const title = s.querySelector('title')?.textContent || '';
        return /logo/i.test(id+cls+title);
      })
      .map(s => {
        const clone = s.cloneNode(true);
        if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        return clone.outerHTML;
      });

    // ---- Brand / meta
    const brand = getMeta('meta[property="og:site_name"]') || document.title || location.hostname;

    // ---- Keywords: meta -> fallback з контенту
    const keywordsMeta = getMeta('meta[name="keywords"]');
    let keywords = [];
    if (keywordsMeta) {
      const stop = new Set(Array.isArray(STOPWORDS) ? STOPWORDS : []);
      keywords = keywordsMeta
        .split(',')
        .map(s => s.trim().toLowerCase())
        .map(w => w.replace(/[^\p{Letter}\p{Number}\s-]+/gu, '')) // легка нормалізація
        .filter(w => w && w.length >= 3 && !stop.has(w));
      keywords = [...new Set(keywords)].slice(0, 12);
    } else {
      const visible = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node){
          const t = (node.textContent||'').trim();
          if (!t) return NodeFilter.FILTER_REJECT;
          const el = node.parentElement;
          const cs = el && getComputedStyle(el);
          const hidden = !el || !cs || cs.display==='none' || cs.visibility==='hidden' || parseFloat(cs.opacity||'1')===0;
          const inSvg = el && (el.closest('svg')!=null);
          if (hidden || inSvg) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      while (walker.nextNode()) visible.push(walker.currentNode.textContent.trim());

      const stop = new Set(Array.isArray(STOPWORDS) ? STOPWORDS : []);

      const sourceText = [
        decode(document.title || ''),
        decode(getMeta('meta[name="description"]') || ''),
        decode(getMeta('meta[property="og:description"]') || ''),
        decode([...document.querySelectorAll('h1,h2,article header')].map(el=>el.textContent||'').join(' '))
      ].join(' \n ');

      const textAll = (sourceText + ' ' + visible.join(' '))
        .toLowerCase()
        .replace(/&(?:[a-z]+|#\d+);/gi, ' ')   // &quot; &amp; &#1234; →
        .replace(/['’]s\b/g, ' ')              // ’s
        .replace(/[^\p{Letter}\p{Number}\s\-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const freq = new Map();
      for (const w of textAll.split(/\s+/)) {
        const word = w.trim();
        if (!word || word.length < 3) continue;
        if (stop.has(word)) continue;
        if (/^\d+$/.test(word)) continue;
        freq.set(word, (freq.get(word) || 0) + 1);
      }

      keywords = [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([w])=>w);
    }

    const description = getMeta('meta[name="description"]') || getMeta('meta[property="og:description"]');

    // ---- Fonts (content-only, без іконок/utility/SVG)
    const fontNames = new Set();
    const candidates = document.querySelectorAll('main, article, [role="main"], .content, .post, .entry, body');
    const pickFrom = new Set(['h1','h2','h3','p','li','a','button','input','textarea','small','span','label','blockquote']);
    const seen = new Set();

    candidates.forEach(rootEl=>{
      rootEl.querySelectorAll('*').forEach(el=>{
        const tag = el.tagName.toLowerCase();
        if (!pickFrom.has(tag)) return;
        if (el.closest('svg')) return;
        const txt = (el.textContent||'').trim();
        if (!txt || txt.length<2) return;

        const cs = getComputedStyle(el);
        if (!cs || cs.display==='none' || cs.visibility==='hidden' || parseFloat(cs.opacity||'1')===0) return;

        const ff = (cs.fontFamily||'').split(',')[0].replaceAll('"','').trim();
        if (!ff) return;
        if (/(icon|icons|awesome|fontawesome|fa-|glyph|material|vc_|jeg|plugin)/i.test(ff)) return;

        const key = ff + '|' + cs.fontWeight + '|' + cs.fontStyle;
        if (!seen.has(key)) { seen.add(key); fontNames.add(ff); }
      });
    });

    // Повертаємо просто масив назв для UI (без джерел/посилань)
    const fonts = [...fontNames];

    // Detect Google Fonts links and map exact families -> CSS URL
    // Посилання на Google Fonts із реально підключених CSS
    const links = [...document.querySelectorAll('link[rel="stylesheet"], link[href]')]
      .map(l => abs(l.getAttribute('href')));
    const ggMap = new Map();
    links.filter(u => /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(u||'')).forEach(u=>{
      try {
        const url = new URL(u);
        const fam = url.searchParams.get('family') || '';
        fam.split('|').forEach(chunk=>{
          const nm = decodeURIComponent(chunk.split(':')[0]).replace(/\+/g,' ').trim();
          if (nm) ggMap.set(nm, u);
        });
      } catch(e){}
    });

    const fontsDetailed = fonts.map(name => ({ 
      name, 
      gf: ggMap.get(name) || ''   // якщо є — це саме GF
    }));



    // ---- Colors: стабільне мапування
    const toRGB = (input) => {
      const c = document.createElement('canvas').getContext('2d');
      c.fillStyle = '#000';
      try { c.fillStyle = input; } catch(e){ return null; }
      const v = c.fillStyle;
      if (v.startsWith('rgb')) {
        const m = v.match(/\d+/g)?.map(Number);
        if (m && m.length >= 3) return {r:m[0],g:m[1],b:m[2]};
      } else if (v.startsWith('#')) {
        const hex = v.slice(1);
        const n = hex.length;
        const parse = (h) => parseInt(h,16);
        if (n===3) return {r:parse(hex[0]+hex[0]), g:parse(hex[1]+hex[1]), b:parse(hex[2]+hex[2])};
        if (n===6) return {r:parse(hex.slice(0,2)), g:parse(hex.slice(2,4)), b:parse(hex.slice(4,6))};
      }
      return null;
    };
    const toHex = ({r,g,b}) => '#' + [r,g,b].map(n=>Math.max(0,Math.min(255,n)).toString(16).padStart(2,'0')).join('');
    const rgbToHsl = ({r,g,b})=>{
      r/=255; g/=255; b/=255;
      const max=Math.max(r,g,b), min=Math.min(r,g,b);
      let h=0, s=0, l=(max+min)/2, d=max-min;
      if (d!==0){
        s = d / (1 - Math.abs(2*l - 1));
        switch(max){
          case r: h = (g-b)/d + (g<b?6:0); break;
          case g: h = (b-r)/d + 2; break;
          case b: h = (r-g)/d + 4; break;
        }
        h = Math.round(h*60);
      }
      return {h, s, l};
    };

    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const pick = v => (root.getPropertyValue(v) || '').trim();
    const initial = {
      primary:    pick('--primary'),
      secondary:  pick('--secondary'),
      accent:     pick('--accent'),
      background: pick('--background') || body.backgroundColor,
      foreground: pick('--foreground') || body.color,
      text:       pick('--text') || body.color
    };

    const sampleSelectors = ['body','header','main','footer','nav','.btn','button','a','.card','h1','h2','h3','p'];
    const colorCounts = new Map();
    const addColor = (cssColor) => {
      const rgb = toRGB(cssColor); if (!rgb) return;
      const key = toHex(rgb);
      colorCounts.set(key, (colorCounts.get(key)||0)+1);
    };
    sampleSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        const cs = getComputedStyle(el);
        addColor(cs.backgroundColor);
        addColor(cs.color);
        ['borderTopColor','borderRightColor','borderBottomColor','borderLeftColor'].forEach(p=>addColor(cs[p]));
      });
    });

    const ranked = [...colorCounts.entries()]
      .map(([hex,count])=>{
        const rgb = toRGB(hex); if (!rgb) return null;
        const {s,l} = rgbToHsl(rgb);
        const isGray = Math.abs(rgb.r-rgb.g)<6 && Math.abs(rgb.g-rgb.b)<6;
        const score = (isGray?0:1) * (s*1.5 + count*0.02);
        return {hex, score, sat:s, l};
      })
      .filter(Boolean)
      .sort((a,b)=>b.score - a.score);

    const palette = {...initial};
    const take = (skip=[])=>{
      for (const c of ranked){
        if (skip.includes(c.hex)) continue;
        if (c.l < 0.08 || c.l > 0.92) continue; // уникаємо майже чорного/білого
        return c.hex;
      }
      return ranked[0]?.hex || '#3b82f6';
    };

    if (!palette.primary)   palette.primary   = take([]);
    if (!palette.secondary) palette.secondary = take([palette.primary]);
    if (!palette.accent)    palette.accent    = ranked.find(c=>![palette.primary,palette.secondary].includes(c.hex) && c.sat>0.35)?.hex || take([palette.primary,palette.secondary]);

    const bgRGB = toRGB(palette.background) || {r:255,g:255,b:255};
    const fgRGB = toRGB(palette.foreground) || {r:17,g:24,b:39};
    palette.background = toHex(bgRGB);
    palette.foreground = toHex(fgRGB);
    if (!palette.text) palette.text = palette.foreground;

    // нормалізація
    Object.keys(palette).forEach(k => {
      const rgb = toRGB(palette[k]); if (rgb) palette[k] = toHex(rgb);
    });

    return {
      brand,
      logos: {
        links: [...new Set([
          ...logoLinks,
          abs(ogImage),
          abs(imageSrc),
          ...jsonLdLogos,
          ...imgLogos
        ])].filter(Boolean).slice(0, 15),
        svgs: svgLogos.slice(0, 8)
      },
      keywords,
      description,
      fontsDetailed,
      colors: palette
    };
  },
  [ Array.from(window.__STOPWORDS || []) ]   // ✅ Ось тут! ПРАВИЛЬНЕ місце
);

  // ------- render in popup -------
  window.__brandState = data;
  window.__palette = data.colors;

  // Brand
  document.getElementById('brandName').textContent = data.brand || '—';

  // Logos (без hostname/meta, з Copy SVG)
  const logosWrap = document.getElementById('logos'); logosWrap.innerHTML = '';
  if (data.logos.svgs.length) {
    data.logos.svgs.forEach(svgTxt => {
      const div = document.createElement('div'); div.className = 'media';
      const ta = document.createElement('textarea'); ta.value = svgTxt;
      const row = document.createElement('div'); row.className='row';
      const btn = document.createElement('button'); btn.className='copy'; btn.textContent = 'Copy SVG';
      btn.addEventListener('click', () => copyText(svgTxt));
      row.append(btn); div.append(ta, row); logosWrap.append(div);
    });
  }
  if (data.logos.links.length) {
    data.logos.links.forEach(url => {
      const div = document.createElement('div'); div.className = 'media';
      const img = document.createElement('img'); img.src = url;
      const row = document.createElement('div'); row.className='row';

      // Copy URL
      const btnUrl = document.createElement('button');
      btnUrl.className = 'copy';
      btnUrl.textContent = 'Copy URL';
      btnUrl.addEventListener('click', () => copyText(url));
      row.append(btnUrl);

      // NEW: if .svg -> Copy SVG (fetch text)
      if (/\.svg(\?|#|$)/i.test(url)) {
        const btnSvg = document.createElement('button');
        btnSvg.className = 'copy';
        btnSvg.textContent = 'Copy SVG';
        btnSvg.addEventListener('click', async () => {
          try {
            const res = await fetch(url);
            const txt = await res.text();
            copyText(txt);
          } catch (e) {
            showError('Cannot fetch SVG: ' + e);
          }
        });
        row.append(btnSvg);
      }

      div.append(img, row);
      logosWrap.append(div);
    });
  }
  if (!data.logos.svgs.length && !data.logos.links.length) { logosWrap.textContent = '—'; }

  // Meta blocks
  document.getElementById('keywords').textContent = data.keywords?.length ? data.keywords.join(', ') : '—';
  document.getElementById('description').textContent = data.description || '—';

  // Fonts — тільки назви
  const fontsWrap = document.getElementById('fonts'); fontsWrap.innerHTML = '';
  (data.fontsDetailed || []).forEach(f=>{
    const row = document.createElement('div'); row.className='font-item';
    const n = document.createElement('div'); n.className='font-name'; n.textContent = f.name;

    const actions = document.createElement('div'); actions.className='font-actions';
    if (f.gf) {
      const specimen = 'https://fonts.google.com/specimen/' + encodeURIComponent(f.name.replace(/\s+/g,' '));
      const open = document.createElement('button'); open.className='btn tiny ghost'; open.textContent='Open';
      open.onclick = ()=> window.open(specimen, '_blank');
      actions.appendChild(open);
    } else {
      // NEW: "Find" у Google
      const q = encodeURIComponent(`${f.name} font download`);
      const find = document.createElement('button'); find.className='btn tiny ghost'; find.textContent='Find';
      find.onclick = ()=> window.open(`https://www.google.com/search?q=${q}`, '_blank');
      actions.appendChild(find);
    }

    row.append(n, actions); 
    fontsWrap.append(row);
  });
  if (!data.fontsDetailed?.length) fontsWrap.textContent = '—';

  // Colors
  const colorsWrap = document.getElementById('colors'); colorsWrap.innerHTML = '';
  const order = ['primary','secondary','accent','background','foreground','text'];
  order.forEach(k=>{
    const v = data.colors?.[k]; if (!v) return;
    const row = document.createElement('div'); row.className='swatch';
    const box = document.createElement('div'); box.className='box'; box.style.background = v;
    const key = document.createElement('div'); key.className='name'; key.textContent = k;
    const btn = document.createElement('button'); btn.className='copy'; btn.textContent = 'Copy';
    const val = document.createElement('div'); val.className='val'; val.textContent = v;
    btn.addEventListener('click', () => copyText(v));
    row.append(box, key, btn, val); colorsWrap.append(row);
  });
}
