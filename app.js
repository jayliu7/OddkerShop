/**
 * 歐客衛浴 PWA 行動選購核心引擎 (Client-Side DOMParser Scraping + Multi-Level Spec Resolver)
 */

const BASE_ORIGIN = 'https://www.oddker1.com';
const SHOP_KEY = 'qj394';

/**
 * 若部署於 GitHub Pages，請將下方 CLOUDFLARE_WORKER_URL 改為您的 Cloudflare Worker 網址
 * 例如：const CLOUDFLARE_WORKER_URL = 'https://oddker-proxy.您的帳號.workers.dev';
 * (或於開啟 GitHub Pages 網址時帶入 ?worker=https://oddker-proxy.您的帳號.workers.dev 亦會自動記憶)
 */
const CLOUDFLARE_WORKER_URL = 'https://738ef145.oddker-proxy.pages.dev/';

function resolveProxyBase() {
  const urlParams = new URLSearchParams(window.location.search);
  const queryWorker = urlParams.get('worker')?.trim();
  if (queryWorker) {
    const cleaned = queryWorker.replace(/\/+$/, '');
    localStorage.setItem('oddker_worker_url', cleaned);
    return cleaned;
  }
  if (CLOUDFLARE_WORKER_URL) {
    return CLOUDFLARE_WORKER_URL.replace(/\/+$/, '');
  }
  const saved = localStorage.getItem('oddker_worker_url');
  if (saved && window.location.hostname.endsWith('github.io')) {
    return saved.replace(/\/+$/, '');
  }
  return '';
}

const PROXY_BASE = resolveProxyBase();
const PROXY_ENDPOINT = `${PROXY_BASE}/api/proxy?path=`;

// 歐客衛浴全台門市資料
const BRANCH_LIST = [
  {
    name: '新北泰山展示中心（總店）',
    phone: '02-2909-7971',
    address: '新北市泰山區楓江路86巷57號之3',
    hours: '週一至週六 09:00–18:00'
  },
  {
    name: '桃園中壢展示門市',
    phone: '03-462-5655',
    address: '桃園市中壢區普忠路259號',
    hours: '週一至週六 09:30–18:30'
  },
  {
    name: '台中烏日展示門市',
    phone: '04-2337-8585',
    address: '台中市烏日區中山路三段406號',
    hours: '週一至週六 09:30–18:30'
  },
  {
    name: '台南永康展示門市',
    phone: '06-253-8188',
    address: '台南市永康區中正北路343號',
    hours: '週一至週六 09:30–18:30'
  },
  {
    name: '高雄仁武展示門市',
    phone: '07-372-6566',
    address: '高雄市仁武區鳳仁路95之3號',
    hours: '週一至週六 09:30–18:30'
  }
];

// 全局狀態
const state = {
  activeTab: 'catalog',
  categories: [],
  selectedMainCatId: '',
  selectedSubCatId: '',
  searchQuery: '',
  sortOrder: 'DEFAULT', // DEFAULT, HOT, PRICE_ASC, PRICE_DESC
  products: [],
  currentPage: 1,
  totalPages: 1,
  isLoadingCatalog: false,

  // 詳情頁狀態
  currentDetail: null,
  selectedSpecs: {}, // { 1: '30公分', 2: '左開' }
  resolvedSpecResult: null, // { contId, price, stock, picId, isQuotation }
  isQueryingSpec: false,
  detailQuantity: 1,

  // 購物車與收藏
  cart: JSON.parse(localStorage.getItem('oddker_pwa_cart') || '[]'),
  favorites: JSON.parse(localStorage.getItem('oddker_pwa_favs') || '[]')
};

let deferredInstallPrompt = null;

// ==================== 初始化與 PWA 註冊 ====================

document.addEventListener('DOMContentLoaded', () => {
  sanitizeLocalCartOnStartup();
  initServiceWorkerAndInstallPrompt();
  bindUIEvents();
  renderBranches();
  updateCartBadgeAndView();
  renderFavorites();
  loadCatalog(true);
});

function sanitizeLocalCartOnStartup() {
  if (!Array.isArray(state.cart)) {
    state.cart = [];
    saveCart();
    return;
  }
  let changed = false;
  const merged = [];
  for (const raw of state.cart) {
    if (!raw || !raw.productId) {
      changed = true;
      continue;
    }
    const cleanContId =
      raw.optionContId &&
      String(raw.optionContId).trim() !== '' &&
      String(raw.optionContId).trim() !== '0' &&
      String(raw.optionContId).trim() !== 'null'
        ? String(raw.optionContId).trim()
        : null;
    if (cleanContId !== raw.optionContId) {
      raw.optionContId = cleanContId;
      changed = true;
    }
    const existing = merged.find(
      m =>
        String(m.productId) === String(raw.productId) &&
        String(m.specSummary || '') === String(raw.specSummary || '')
    );
    if (existing) {
      existing.quantity = (existing.quantity || 1) + (raw.quantity || 1);
      if (!existing.optionContId && cleanContId) existing.optionContId = cleanContId;
      changed = true;
    } else {
      merged.push(raw);
    }
  }
  state.cart = merged;
  if (changed) saveCart();
}

function initServiceWorkerAndInstallPrompt() {
  // 清除舊版 Service Worker 快取 (oddker-pwa-v1 / v2 / v3)，避免瀏覽器卡在舊版 JS 或舊結帳頁快取
  if ('caches' in window) {
    caches.keys().then(keys => {
      keys.forEach(k => {
        if (k !== 'oddker-pwa-v4') {
          caches.delete(k);
        }
      });
    }).catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js?v=4')
      .then(reg => {
        reg.update().catch(() => {});
      })
      .catch(err => {
        console.warn('Service Worker 註冊略過:', err);
      });

    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data && event.data.type === 'SW_CACHE_UPGRADED') {
        window.location.reload();
      }
    });
  }

  const installBtn = document.getElementById('btn-install-pwa');
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.classList.remove('hidden');
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.classList.add('hidden');
  });
}

// ==================== 網路代理與退避機制 ====================

async function fetchViaProxy(targetPath, options = {}) {
  const proxyUrl = PROXY_ENDPOINT + encodeURIComponent(targetPath);
  try {
    const resp = await fetch(proxyUrl, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  } catch (err) {
    // 若使用者直接以純靜態伺服器開啟且僅為 GET，自動退避至公開 CORS Proxy
    if (!options.method || options.method === 'GET') {
      const fallbackUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(BASE_ORIGIN + targetPath)}`;
      return fetch(fallbackUrl);
    }
    throw err;
  }
}

function toAbsoluteImageUrl(src) {
  if (!src) return '';
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  if (src.startsWith('//')) return 'https:' + src;
  return BASE_ORIGIN + (src.startsWith('/') ? '' : '/') + src;
}

function extractProductTitleAndSerial(rawTitle) {
  const cleaned = (rawTitle || '').trim();
  const match = cleaned.match(/[\(（]\s*編號[:：]\s*([^\)）]+)[\)）]/);
  if (match) {
    const serial = match[1].trim();
    const title = cleaned.replace(match[0], '').trim();
    return { title: title || cleaned, serial };
  }
  return { title: cleaned, serial: '' };
}

// ==================== HTML 解析器 (Browser DOMParser) ====================

function parseCatalogHtml(htmlText) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');

  // 1. 跑馬燈公告
  const marqueeEl = doc.querySelector('marquee.topMarq');
  const marqueeText = marqueeEl ? marqueeEl.textContent.replace(/\s+/g, ' ').trim() : '';

  // 2. 雙層商品分類樹 (.productCateList)
  const categories = [{ id: '', name: '全部商品', subCategories: [] }];
  doc.querySelectorAll('.productCateList > .panel.panel-default').forEach(panel => {
    const mainLink = panel.querySelector('.panel-heading .panel-title a.prdTitle, .panel-heading .panel-title a');
    if (!mainLink) return;
    const name = mainLink.textContent.trim();
    const href = mainLink.getAttribute('href') || '';
    const cateMatch = href.match(/cateId=(\d+)/);
    const id = cateMatch ? cateMatch[1] : '';

    const subCategories = [];
    panel.querySelectorAll('.prdSubCateList .panel-body a').forEach(subA => {
      const subName = subA.textContent.trim();
      const subHref = subA.getAttribute('href') || '';
      const subMatch = subHref.match(/cateId=(\d+)/);
      if (subMatch && subName) {
        subCategories.push({ id: subMatch[1], name: subName, parentId: id });
      }
    });

    if (name && (id || subCategories.length > 0)) {
      categories.push({ id, name, subCategories });
    }
  });

  // 3. 商品卡片列表 (ul#productlist > li)
  const products = [];
  doc.querySelectorAll('ul#productlist > li').forEach(li => {
    const linkEl = li.querySelector('h4.productName a, a[href*="ProductDetail"]');
    if (!linkEl) return;
    const href = linkEl.getAttribute('href') || '';
    const idMatch = href.match(/productId=(\d+)/);
    if (!idMatch) return;
    const id = idMatch[1];

    const nameEl = li.querySelector('h4.productName a');
    const rawName = nameEl ? nameEl.textContent.trim() : linkEl.textContent.trim();
    const { title, serial } = extractProductTitleAndSerial(rawName);

    const imgEl = li.querySelector('img.productImg, img');
    const thumbUrl = toAbsoluteImageUrl(imgEl ? imgEl.getAttribute('src') : '');

    const priceEl = li.querySelector('span.newprice, span.priceRange, .productPrice');
    const priceDisplay = priceEl ? priceEl.textContent.replace(/\s+/g, ' ').trim() : '查看售價';
    const numMatches = (priceDisplay.match(/[\d,]+/g) || []).map(s => parseInt(s.replace(/,/g, ''), 10)).filter(n => !isNaN(n));
    const minPrice = numMatches.length > 0 ? Math.min(...numMatches) : 0;

    products.push({
      id,
      title,
      serial,
      thumbUrl,
      priceDisplay,
      minPrice
    });
  });

  // 4. 分頁總頁數
  let totalPages = 1;
  doc.querySelectorAll('.pagination li a').forEach(a => {
    const href = a.getAttribute('href') || '';
    const pMatch = href.match(/page=(\d+)/);
    if (pMatch) {
      const p = parseInt(pMatch[1], 10);
      if (p > totalPages) totalPages = p;
    }
  });

  return { marqueeText, categories, products, totalPages };
}

function parseProductDetailHtml(productId, htmlText) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');

  // 與原生 Android App (OddkerScraperRepository.kt) 對齊：#prdDetail .eshop-product-body h3
  const h3El = doc.querySelector(
    '#prdDetail .eshop-product-body h3, .eshop-product-body h3, h3.productTitle, h2.productTitle, .productInfo h3'
  );
  const snoFont = h3El ? h3El.querySelector('font.productSno') : null;
  const rawSno = snoFont ? snoFont.textContent.trim() : '';
  const cleanSno = rawSno
    .replace(/^[\(（]/, '')
    .replace(/[\)）]$/, '')
    .replace(/^編號[:：]/, '')
    .trim();

  const rawH3Text = h3El ? h3El.textContent.replace(/\s+/g, ' ').trim() : '';
  let title = rawSno ? rawH3Text.replace(rawSno, '').trim() : rawH3Text;
  let serial = cleanSno;
  if (!serial && rawH3Text) {
    const extracted = extractProductTitleAndSerial(rawH3Text);
    title = extracted.title;
    serial = extracted.serial;
  }
  if (!title) title = `歐客衛浴商品 #${productId}`;

  // 輪播圖片 (#projectCarousel)
  const images = [];
  doc.querySelectorAll('#projectCarousel .carousel-inner .item img, .carousel-inner img').forEach(img => {
    const src = toAbsoluteImageUrl(img.getAttribute('src'));
    const picIdAttr = (img.getAttribute('id') || '').replace('carouselPic_', '');
    if (src) images.push({ url: src, picId: picIdAttr });
  });

  // 初始售價顯示 (.product-price .newprice)
  const priceDisplay =
    doc
      .querySelector('.product-price .newprice, #prdPrice, span.newprice, .productPrice')
      ?.textContent?.replace(/\s+/g, ' ')
      ?.trim() || '請選擇規格';

  // 最大可購買數量 (select#addCartNum[data-max])
  const maxBuyQty =
    parseInt(doc.querySelector('select#addCartNum')?.getAttribute('data-max') || '30', 10) || 30;

  // 優惠活動與重點說明 (.eshop-product-body .activity p & p.roominfo)
  const summaryLines = [];
  doc.querySelectorAll('.eshop-product-body .activity p').forEach(p => {
    const t = p.textContent.replace(/\s+/g, ' ').trim();
    if (t && !summaryLines.includes(t)) summaryLines.push('🎁 ' + t);
  });
  const roomInfoEl = doc.querySelector('.eshop-product-body p.roominfo');
  if (roomInfoEl) {
    roomInfoEl.textContent.split(/\r?\n/).forEach(line => {
      const t = line.trim();
      if (t) summaryLines.push(t);
    });
  }
  doc.querySelectorAll('.productInfo ul li, .prdInfoList li').forEach(li => {
    const t = li.textContent.replace(/\s+/g, ' ').trim();
    if (t && !summaryLines.includes(t)) summaryLines.push(t);
  });

  // 多階層規格 (select.prdOptSelect)
  const specLevels = [];
  doc.querySelectorAll('select.prdOptSelect').forEach(sel => {
    const level = parseInt(sel.getAttribute('data-level') || '1', 10);
    // 優先讀取隱藏 option.optContHidden 的標題文字 (如「馬桶管距」、「開放格方向」)
    const hiddenOpt = sel.querySelector('option.optContHidden');
    let label = hiddenOpt ? hiddenOpt.textContent.trim() : `規格階層 ${level}`;

    const options = [];
    sel.querySelectorAll('option:not(.optContHidden)').forEach(opt => {
      const valAttr = opt.getAttribute('value');
      const val = (valAttr !== null ? valAttr : opt.textContent || '').trim();
      if (val && !val.includes('請選擇')) {
        options.push(val);
      }
    });

    specLevels.push({ level, label, options: [...options], initialOptions: [...options] });
  });

  // 單一規格隱藏欄位 (若無多階層下拉選單則不帶空字串)
  const rawOptionContId = (doc.querySelector('#optionContId, input[name="optionContId"]')?.getAttribute('value') || '').trim();
  const defaultOptionContId = rawOptionContId && rawOptionContId !== '0' ? rawOptionContId : null;

  // 圖文介紹區塊 (.textEditor) — 清除寫死的超大寬高與破版屬性
  const editorEl = doc.querySelector('.textEditor, #productDescription, .tab-content');
  let cleanDescriptionHtml = '';
  if (editorEl) {
    const clone = editorEl.cloneNode(true);
    clone.querySelectorAll('img').forEach(img => {
      const src = toAbsoluteImageUrl(img.getAttribute('src'));
      img.setAttribute('src', src);
      img.removeAttribute('width');
      img.removeAttribute('height');
      img.style.width = '100%';
      img.style.height = 'auto';
      img.style.maxWidth = '100%';
      img.setAttribute('loading', 'lazy');
    });
    clone.querySelectorAll('[style]').forEach(el => {
      if (el.tagName !== 'IMG') {
        el.style.width = '';
        el.style.height = '';
        el.style.whiteSpace = 'normal';
      }
    });
    cleanDescriptionHtml = clone.innerHTML;
  }

  return {
    id: productId,
    title,
    serial,
    images: images.length > 0 ? images : [{ url: '/icon.svg', picId: '' }],
    priceDisplay,
    maxBuyQty,
    summary: summaryLines.join('\n'),
    specLevels: specLevels.sort((a, b) => a.level - b.level),
    defaultOptionContId,
    cleanDescriptionHtml
  };
}

// ==================== 商品目錄載入與篩選 ====================

async function loadCatalog(resetPage = true) {
  if (state.isLoadingCatalog) return;
  state.isLoadingCatalog = true;

  if (resetPage) {
    state.currentPage = 1;
    state.products = [];
    document.getElementById('product-grid').innerHTML = '';
  }

  document.getElementById('catalog-loading').classList.remove('hidden');
  document.getElementById('catalog-load-more-wrap').classList.add('hidden');

  const activeCateId = state.selectedSubCatId || state.selectedMainCatId;
  const params = new URLSearchParams({ key: SHOP_KEY, page: String(state.currentPage) });
  if (activeCateId) params.set('cateId', activeCateId);
  if (state.searchQuery) params.set('name', state.searchQuery);
  if (state.sortOrder === 'HOT') params.set('sortByOrder', 'DESC');
  if (state.sortOrder === 'PRICE_ASC') params.set('sortByPrice', 'ASC');
  if (state.sortOrder === 'PRICE_DESC') params.set('sortByPrice', 'DESC');

  const targetPath = `/h/Product?${params.toString()}`;

  try {
    const resp = await fetchViaProxy(targetPath);
    const html = await resp.text();
    const parsed = parseCatalogHtml(html);

    if (parsed.marqueeText) {
      document.getElementById('marquee-text').textContent = parsed.marqueeText;
    }

    if (state.categories.length === 0 && parsed.categories.length > 1) {
      state.categories = parsed.categories;
      renderCategoryRows();
      renderCategoryDirectory();
    }

    // 合併商品並去重
    const existingIds = new Set(state.products.map(p => p.id));
    parsed.products.forEach(p => {
      if (!existingIds.has(p.id)) {
        state.products.push(p);
        existingIds.add(p.id);
      }
    });

    state.totalPages = parsed.totalPages;
    renderProductGrid();
  } catch (err) {
    showToast('載入目錄失敗，請確認網路連線');
    console.error(err);
  } finally {
    state.isLoadingCatalog = false;
    document.getElementById('catalog-loading').classList.add('hidden');
    const moreWrap = document.getElementById('catalog-load-more-wrap');
    if (state.currentPage < state.totalPages) {
      moreWrap.classList.remove('hidden');
    } else {
      moreWrap.classList.add('hidden');
    }
  }
}

function renderCategoryRows() {
  const mainRow = document.getElementById('main-category-row');
  const subRow = document.getElementById('sub-category-row');
  mainRow.innerHTML = '';
  subRow.innerHTML = '';

  state.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `cat-chip ${state.selectedMainCatId === cat.id ? 'active' : ''}`;
    btn.textContent = cat.name;
    btn.addEventListener('click', () => {
      state.selectedMainCatId = cat.id;
      state.selectedSubCatId = '';
      renderCategoryRows();
      loadCatalog(true);
    });
    mainRow.appendChild(btn);
  });

  const activeMain = state.categories.find(c => c.id === state.selectedMainCatId);
  if (activeMain && activeMain.subCategories && activeMain.subCategories.length > 0) {
    subRow.classList.remove('hidden');

    const allSubBtn = document.createElement('button');
    allSubBtn.className = `cat-chip ${state.selectedSubCatId === '' ? 'active' : ''}`;
    allSubBtn.textContent = `全部${activeMain.name}`;
    allSubBtn.addEventListener('click', () => {
      state.selectedSubCatId = '';
      renderCategoryRows();
      loadCatalog(true);
    });
    subRow.appendChild(allSubBtn);

    activeMain.subCategories.forEach(sub => {
      const sBtn = document.createElement('button');
      sBtn.className = `cat-chip ${state.selectedSubCatId === sub.id ? 'active' : ''}`;
      sBtn.textContent = sub.name;
      sBtn.addEventListener('click', () => {
        state.selectedSubCatId = sub.id;
        renderCategoryRows();
        loadCatalog(true);
      });
      subRow.appendChild(sBtn);
    });
  } else {
    subRow.classList.add('hidden');
  }
}

function renderCategoryDirectory() {
  const container = document.getElementById('category-directory-list');
  container.innerHTML = '';

  state.categories.forEach(cat => {
    const card = document.createElement('div');
    card.className = 'dir-card';

    const header = document.createElement('div');
    header.className = 'dir-card-header';
    header.innerHTML = `<span>${cat.name}</span><span>前往瀏覽 ➔</span>`;
    header.addEventListener('click', () => {
      state.selectedMainCatId = cat.id;
      state.selectedSubCatId = '';
      renderCategoryRows();
      switchTab('catalog');
      loadCatalog(true);
    });
    card.appendChild(header);

    if (cat.subCategories && cat.subCategories.length > 0) {
      const subWrap = document.createElement('div');
      subWrap.className = 'dir-sub-chips';
      cat.subCategories.forEach(sub => {
        const chip = document.createElement('button');
        chip.className = 'cat-chip';
        chip.textContent = sub.name;
        chip.addEventListener('click', () => {
          state.selectedMainCatId = cat.id;
          state.selectedSubCatId = sub.id;
          renderCategoryRows();
          switchTab('catalog');
          loadCatalog(true);
        });
        subWrap.appendChild(chip);
      });
      card.appendChild(subWrap);
    }

    container.appendChild(card);
  });
}

function renderProductGrid() {
  const grid = document.getElementById('product-grid');
  grid.innerHTML = '';

  const statusText = document.getElementById('catalog-status-text');
  statusText.textContent = state.searchQuery
    ? `搜尋「${state.searchQuery}」共 ${state.products.length} 件`
    : `已載入 ${state.products.length} 件商品 (第 ${state.currentPage}/${state.totalPages} 頁)`;

  state.products.forEach(prod => {
    grid.appendChild(createProductCardElement(prod));
  });
}

function createProductCardElement(prod) {
  const card = document.createElement('div');
  card.className = 'product-card';

  const isFav = state.favorites.some(f => f.id === prod.id);

  card.innerHTML = `
    <div class="card-img-wrap">
      <img src="${prod.thumbUrl}" alt="${prod.title}" loading="lazy" />
      ${prod.serial ? `<span class="serial-badge">#${prod.serial}</span>` : ''}
      <button type="button" class="fav-btn-card" aria-label="收藏">${isFav ? '❤️' : '🤍'}</button>
    </div>
    <div class="card-body">
      <div class="card-title">${prod.title}</div>
      <div class="card-price-row">
        <span class="card-price">${prod.priceDisplay}</span>
        <span class="card-action-tag">選規格</span>
      </div>
    </div>
  `;

  const favBtn = card.querySelector('.fav-btn-card');
  favBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleFavorite(prod);
    renderProductGrid();
  });

  card.addEventListener('click', () => {
    openProductDetail(prod.id, prod);
  });

  return card;
}

// ==================== 商品詳情與多階層規格 API (/h/getPrdOptData) ====================

async function openProductDetail(productId, previewProd = null) {
  const modal = document.getElementById('detail-modal');
  modal.classList.remove('hidden');

  document.getElementById('detail-topbar-title').textContent = previewProd?.title || '商品詳情';
  document.getElementById('detail-title').textContent = previewProd?.title || '載入商品規格中...';
  document.getElementById('detail-price').textContent = previewProd?.priceDisplay || 'NT$ --';
  document.getElementById('detail-stock').textContent = '同步規格中...';
  document.getElementById('detail-summary').textContent = '';
  document.getElementById('spec-levels-container').innerHTML = '<div class="loading-box"><div class="spinner"></div><p>讀取多階層規格選單...</p></div>';
  document.getElementById('detail-description-blocks').innerHTML = '';
  document.getElementById('btn-detail-origin').href = `${BASE_ORIGIN}/h/ProductDetail?key=${SHOP_KEY}&productId=${productId}`;

  state.selectedSpecs = {};
  state.resolvedSpecResult = null;
  state.detailQuantity = 1;
  document.getElementById('detail-qty-val').textContent = '1';

  try {
    const resp = await fetchViaProxy(`/h/ProductDetail?key=${SHOP_KEY}&productId=${productId}`);
    const html = await resp.text();
    const detail = parseProductDetailHtml(productId, html);
    state.currentDetail = detail;

    renderProductDetailView(detail);
  } catch (err) {
    showToast('讀取商品詳情失敗');
    console.error(err);
  }
}

function renderProductDetailView(detail) {
  document.getElementById('detail-topbar-title').textContent = detail.title;
  document.getElementById('detail-title').textContent = detail.title;
  document.getElementById('detail-price').textContent = detail.priceDisplay;
  document.getElementById('detail-summary').textContent = detail.summary;

  const isFav = state.favorites.some(f => f.id === detail.id);
  document.getElementById('btn-detail-fav').textContent = isFav ? '❤️' : '🤍';

  // 編號角標
  const badgesWrap = document.getElementById('detail-badges');
  badgesWrap.innerHTML = '';
  if (detail.serial) {
    const b = document.createElement('span');
    b.className = 'badge-chip';
    b.textContent = `型號組合：#${detail.serial} (點擊複製)`;
    b.style.cursor = 'pointer';
    b.addEventListener('click', () => {
      navigator.clipboard?.writeText(detail.serial);
      showToast(`已複製型號：${detail.serial}`);
    });
    badgesWrap.appendChild(b);
  }

  // 輪播圖
  const carousel = document.getElementById('detail-carousel');
  carousel.innerHTML = '';
  detail.images.forEach(imgObj => {
    const slide = document.createElement('div');
    slide.className = 'carousel-slide';
    slide.dataset.picId = imgObj.picId || '';
    const img = document.createElement('img');
    img.src = imgObj.url;
    img.alt = detail.title;
    img.addEventListener('click', () => openLightbox(imgObj.url));
    slide.appendChild(img);
    carousel.appendChild(slide);
  });

  // 圖文介紹
  const descContainer = document.getElementById('detail-description-blocks');
  descContainer.innerHTML = detail.cleanDescriptionHtml || '<p>尚無額外圖文說明</p>';
  descContainer.querySelectorAll('img').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.src));
  });

  // 多階層規格選擇器初始化
  if (detail.specLevels.length === 0) {
    const stockMax = detail.maxBuyQty || 10;
    document.getElementById('detail-stock').textContent = `單一標準規格・現貨庫存：${stockMax} 組`;
    state.resolvedSpecResult = {
      contId: detail.defaultOptionContId || null,
      price: parsePriceNumber(detail.priceDisplay),
      stock: stockMax
    };
    document.getElementById('spec-levels-container').innerHTML =
      '<p style="font-size:13px;color:#5c6870;margin-bottom:8px;">此商品為單一標準規格，可直接加入購物車。</p>';
    updateDetailAddButtonState();
  } else {
    document.getElementById('detail-stock').textContent = `請依序選擇 ${detail.specLevels.length} 項規格`;
    renderSpecLevelsUI();
    updateDetailAddButtonState();
    // 若第一層只有唯一選項則自動選取
    if (detail.specLevels[0].options.length === 1) {
      onSelectSpecOption(1, detail.specLevels[0].options[0]);
    }
  }
}

function updateDetailAddButtonState() {
  const addBtn = document.getElementById('btn-add-to-cart');
  const stockBadge = document.getElementById('detail-stock');
  if (!addBtn) return;

  if (state.isQueryingSpec) {
    addBtn.disabled = true;
    addBtn.style.opacity = '0.6';
    addBtn.textContent = '⏳ 查詢規格庫存中...';
    return;
  }

  if (state.resolvedSpecResult && Number(state.resolvedSpecResult.stock) <= 0) {
    addBtn.disabled = true;
    addBtn.style.opacity = '0.55';
    addBtn.textContent = '🚫 此規格目前缺貨 (請洽客服)';
    if (stockBadge) {
      stockBadge.style.background = '#FED7D7';
      stockBadge.style.color = '#9B2C2C';
    }
    return;
  }

  addBtn.disabled = false;
  addBtn.style.opacity = '1';
  addBtn.textContent = '🛒 加入購物車';
  if (stockBadge) {
    stockBadge.style.background = '';
    stockBadge.style.color = '';
  }
}

function renderSpecLevelsUI() {
  const detail = state.currentDetail;
  if (!detail) return;
  const container = document.getElementById('spec-levels-container');
  container.innerHTML = '';

  detail.specLevels.forEach(lvl => {
    const block = document.createElement('div');
    block.className = 'spec-level-block';

    const selectedVal = state.selectedSpecs[lvl.level] || '';
    const title = document.createElement('div');
    title.className = 'spec-level-title';
    title.textContent = `${lvl.level}. ${lvl.label} ${selectedVal ? `：已選【${selectedVal}】` : '(必選)'}`;
    block.appendChild(title);

    const wrap = document.createElement('div');
    wrap.className = 'spec-options-wrap';

    if (lvl.options.length === 0) {
      const hint = document.createElement('span');
      hint.style.fontSize = '12.5px';
      hint.style.color = '#888';
      hint.textContent = '請先選擇上一層規格';
      wrap.appendChild(hint);
    } else {
      lvl.options.forEach(optVal => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `spec-chip ${selectedVal === optVal ? 'selected' : ''}`;
        chip.textContent = optVal;
        chip.addEventListener('click', () => onSelectSpecOption(lvl.level, optVal));
        wrap.appendChild(chip);
      });
    }

    block.appendChild(wrap);
    container.appendChild(block);
  });
}

async function onSelectSpecOption(level, value) {
  const detail = state.currentDetail;
  if (!detail) return;

  state.selectedSpecs[level] = value;

  // 清除後續階層的舊選擇與舊選項
  detail.specLevels.forEach(lvl => {
    if (lvl.level > level) {
      delete state.selectedSpecs[lvl.level];
      lvl.options = [];
    }
  });
  state.resolvedSpecResult = null;
  state.isQueryingSpec = true;
  renderSpecLevelsUI();
  updateDetailAddButtonState();

  // 組合 value 字串 (如 "30公分|左開")
  const valueChain = [];
  for (let i = 1; i <= level; i++) {
    if (state.selectedSpecs[i]) valueChain.push(state.selectedSpecs[i]);
  }
  const combinedValue = valueChain.join('|');

  const indicator = document.getElementById('spec-loading-indicator');
  indicator.classList.remove('hidden');

  try {
    const formBody = new URLSearchParams({
      productId: String(detail.id),
      value: combinedValue,
      level: String(level)
    });

    const resp = await fetchViaProxy('/h/getPrdOptData', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: formBody.toString()
    });

    const data = await resp.json();

    if (Array.isArray(data)) {
      // 中間階層：更新下一層 options
      const nextLevelObj = detail.specLevels.find(l => l.level === level + 1);
      if (nextLevelObj) {
        nextLevelObj.options = data;
        renderSpecLevelsUI();
        // 若下一層只有唯一選項則自動選取
        if (data.length === 1) {
          await onSelectSpecOption(level + 1, data[0]);
          return;
        }
      }
    } else if (data && typeof data === 'object' && 'contId' in data) {
      // 最終階層：獲得 contId、實際售價、庫存與對應圖片
      state.resolvedSpecResult = data;
      const priceNum = Number(data.price || 0);
      document.getElementById('detail-price').textContent = `NT$ ${priceNum.toLocaleString()}`;
      document.getElementById('detail-stock').textContent =
        data.stock > 0 ? `現貨庫存：${data.stock} 組` : '目前缺貨 (庫存 0) / 需預訂';

      if (data.stock > 0 && state.detailQuantity > data.stock) {
        state.detailQuantity = data.stock;
        document.getElementById('detail-qty-val').textContent = String(state.detailQuantity);
      }

      // 若有對應規格圖片 picId，自動滾動輪播圖
      if (data.picId) {
        const cleanPicId = String(data.picId).replace('carouselPic_', '');
        const slide = document.querySelector(
          `.carousel-slide[data-pic-id="${cleanPicId}"], .carousel-slide[data-pic-id="${data.picId}"]`
        );
        if (slide) slide.scrollIntoView({ behavior: 'smooth', inline: 'center' });
      }
    }
  } catch (err) {
    showToast('查詢規格價格失敗，請重試');
    console.error(err);
  } finally {
    state.isQueryingSpec = false;
    indicator.classList.add('hidden');
    updateDetailAddButtonState();
  }
}

function parsePriceNumber(str) {
  const m = (str || '').match(/[\d,]+/);
  return m ? parseInt(m[0].replace(/,/g, ''), 10) : 0;
}

// ==================== 購物車與雙軌結帳 ====================

function addCurrentDetailToCart() {
  const detail = state.currentDetail;
  if (!detail) return;

  if (detail.specLevels.length > 0 && !state.resolvedSpecResult) {
    showToast('請先完整選擇所有商品規格！');
    return;
  }

  if (state.resolvedSpecResult && Number(state.resolvedSpecResult.stock) <= 0) {
    showToast('很抱歉，此規格目前庫存為 0，請選擇其他規格或洽詢 LINE 客服');
    return;
  }

  const specSummary = detail.specLevels
    .map(l => `${l.label}:${state.selectedSpecs[l.level]}`)
    .join(' / ') || '標準規格';

  const rawContId = state.resolvedSpecResult?.contId ?? detail.defaultOptionContId ?? null;
  const optionContId = rawContId && String(rawContId) !== '0' ? String(rawContId) : null;

  const unitPrice = state.resolvedSpecResult?.price
    ? Number(state.resolvedSpecResult.price)
    : parsePriceNumber(detail.priceDisplay);

  const existingIdx = state.cart.findIndex(
    item => item.productId === detail.id && item.optionContId === optionContId && item.specSummary === specSummary
  );

  if (existingIdx >= 0) {
    state.cart[existingIdx].quantity += state.detailQuantity;
  } else {
    state.cart.push({
      productId: detail.id,
      title: detail.title,
      serial: detail.serial,
      thumbUrl: detail.images[0]?.url || '/icon.svg',
      specSummary,
      optionContId,
      unitPrice,
      quantity: state.detailQuantity
    });
  }

  saveCart();
  updateCartBadgeAndView();
  showToast('已加入購物車！');
  document.getElementById('detail-modal').classList.add('hidden');
}

function saveCart() {
  localStorage.setItem('oddker_pwa_cart', JSON.stringify(state.cart));
}

function calculatePromotionDiscount(subtotal) {
  if (subtotal >= 10000) return 500;
  if (subtotal >= 9000) return 300;
  return 0;
}

function updateCartBadgeAndView() {
  const totalCount = state.cart.reduce((sum, item) => sum + item.quantity, 0);
  const badge = document.getElementById('nav-cart-badge');
  if (totalCount > 0) {
    badge.textContent = String(totalCount);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const emptyState = document.getElementById('cart-empty-state');
  const filledState = document.getElementById('cart-filled-state');
  const listEl = document.getElementById('cart-items-list');

  if (state.cart.length === 0) {
    emptyState.classList.remove('hidden');
    filledState.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  filledState.classList.remove('hidden');
  document.getElementById('cart-count-label').textContent = `已選商品 (${totalCount} 件)`;

  listEl.innerHTML = '';
  let subtotal = 0;

  state.cart.forEach((item, idx) => {
    const lineTotal = item.unitPrice * item.quantity;
    subtotal += lineTotal;

    const card = document.createElement('div');
    card.className = 'cart-item-card';
    card.innerHTML = `
      <img src="${item.thumbUrl}" alt="${item.title}" class="cart-item-img" />
      <div class="cart-item-body">
        <div class="cart-item-title">${item.title}</div>
        <div class="cart-item-spec">${item.specSummary}</div>
        <div class="cart-item-bottom">
          <span class="cart-item-price">NT$ ${lineTotal.toLocaleString()}</span>
          <div class="qty-stepper">
            <button type="button" class="qty-btn btn-dec">−</button>
            <span class="qty-val">${item.quantity}</span>
            <button type="button" class="qty-btn btn-inc">＋</button>
          </div>
        </div>
      </div>
    `;

    card.querySelector('.btn-dec').addEventListener('click', () => {
      if (item.quantity > 1) {
        item.quantity -= 1;
      } else {
        state.cart.splice(idx, 1);
      }
      saveCart();
      updateCartBadgeAndView();
    });

    card.querySelector('.btn-inc').addEventListener('click', () => {
      item.quantity += 1;
      saveCart();
      updateCartBadgeAndView();
    });

    listEl.appendChild(card);
  });

  const discount = calculatePromotionDiscount(subtotal);
  const finalTotal = Math.max(0, subtotal - discount);

  document.getElementById('summary-subtotal').textContent = `NT$ ${subtotal.toLocaleString()}`;
  document.getElementById('summary-discount').textContent = `- NT$ ${discount.toLocaleString()}`;
  document.getElementById('summary-total').textContent = `NT$ ${finalTotal.toLocaleString()}`;
}

/**
 * 軌跡一：產生格式化訂購單並開啟官方 LINE (@677ptill)
 */
async function handleLineQuickOrder() {
  if (state.cart.length === 0) return;

  const name = document.getElementById('order-name').value.trim();
  const phone = document.getElementById('order-phone').value.trim();
  const address = document.getElementById('order-address').value.trim();
  const note = document.getElementById('order-note').value.trim();

  let subtotal = 0;
  const lines = ['【歐客衛浴 行動訂購單 (PWA)】', '--------------------'];

  state.cart.forEach((item, i) => {
    const lineTotal = item.unitPrice * item.quantity;
    subtotal += lineTotal;
    lines.push(`${i + 1}. ${item.title}`);
    if (item.serial) lines.push(`   型號：#${item.serial}`);
    lines.push(`   規格：${item.specSummary}`);
    lines.push(`   數量：${item.quantity} 組 × NT$${item.unitPrice.toLocaleString()} = NT$${lineTotal.toLocaleString()}`);
    lines.push(`   連結：${BASE_ORIGIN}/h/ProductDetail?key=${SHOP_KEY}&productId=${item.productId}`);
  });

  const discount = calculatePromotionDiscount(subtotal);
  const total = Math.max(0, subtotal - discount);

  lines.push('--------------------');
  lines.push(`商品小計：NT$ ${subtotal.toLocaleString()}`);
  if (discount > 0) lines.push(`滿額現折：- NT$ ${discount.toLocaleString()}`);
  lines.push(`預估總額：NT$ ${total.toLocaleString()} (運費另計)`);

  if (name || phone || address || note) {
    lines.push('--------------------');
    if (name) lines.push(`收件人：${name}`);
    if (phone) lines.push(`電話：${phone}`);
    if (address) lines.push(`配送地址：${address}`);
    if (note) lines.push(`備註：${note}`);
  }

  const orderText = lines.join('\n');
  try {
    await navigator.clipboard.writeText(orderText);
    showToast('已複製訂購單明細！即將開啟官方 LINE 貼上傳送');
  } catch (_) {
    showToast('即將開啟官方 LINE 客服');
  }

  setTimeout(() => {
    window.open('https://lin.ee/QAvqoH3', '_blank', 'noopener');
  }, 700);
}

/**
 * 軌跡二：將本地購物車同步至官網 Session (/api/sync-cart -> /h/addShopCart) 並開啟行動版收銀台
 */
async function handleWebSessionCheckout() {
  if (state.cart.length === 0) return;

  const btn = document.getElementById('btn-web-checkout');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 正在將商品同步至官網購物車...';

  try {
    // 優先呼叫伺服器端 / Cloudflare Worker 原子化同步端點 /api/sync-cart
    const syncResp = await fetch(`${PROXY_BASE}/api/sync-cart`, {
      method: 'POST',
      credentials: PROXY_BASE ? 'omit' : 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({ items: state.cart })
    });

    if (!syncResp.ok) {
      throw new Error(`Sync HTTP ${syncResp.status}`);
    }

    const syncData = await syncResp.json();
    if (!syncData.ok) {
      throw new Error(syncData.message || '同步失敗');
    }

    // 若伺服器自動修復了舊購物車項目的標題、編號或 optionContId，同步更新回本地購物車
    if (Array.isArray(syncData.healedItems) && syncData.healedItems.length > 0) {
      state.cart = syncData.healedItems;
      saveCart();
      updateCartBadgeAndView();
    }

    const syncedCount = syncData.syncedCount || 0;
    const failedItems = Array.isArray(syncData.failedItems) ? syncData.failedItems : [];
    const sidParam = syncData.sid ? `&sid=${encodeURIComponent(syncData.sid)}` : '';

    if (failedItems.length > 0) {
      showToast(
        `已同步 ${syncedCount} 項；「${failedItems[0].title.substring(0, 10)}...」因${failedItems[0].reason}未列入`
      );
    } else {
      showToast(`已成功同步全部 ${syncedCount} 項商品至官網結帳！`);
    }

    const checkoutUrl = `${PROXY_BASE}/checkout-proxy/h/ProductCheckOut?key=${SHOP_KEY}${sidParam}&_t=${Date.now()}`;
    const topTitle = document.getElementById('checkout-topbar-title');
    if (topTitle) {
      const priceText =
        syncData.totalOrderPrice > 0
          ? `・折後 NT$${Number(syncData.totalOrderPrice).toLocaleString()}`
          : '';
      topTitle.textContent = `官網結帳收銀台 (已同步 ${syncedCount} 項商品${priceText})`;
    }
    const openTabLink = document.getElementById('btn-open-checkout-tab');
    if (openTabLink) {
      openTabLink.href = checkoutUrl;
    }

    const modal = document.getElementById('checkout-iframe-modal');
    const iframe = document.getElementById('checkout-iframe');
    iframe.src = checkoutUrl;
    modal.classList.remove('hidden');
  } catch (err) {
    showToast('同步官網結帳失敗，請檢查網路或改用 LINE 傳單');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// ==================== 收藏與門市渲染 ====================

function toggleFavorite(prod) {
  const idx = state.favorites.findIndex(f => f.id === prod.id);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    showToast('已從收藏移除');
  } else {
    state.favorites.push({
      id: prod.id,
      title: prod.title,
      serial: prod.serial || '',
      thumbUrl: prod.thumbUrl || prod.images?.[0]?.url || '/icon.svg',
      priceDisplay: prod.priceDisplay || '查看售價'
    });
    showToast('已加入收藏清單 ❤️');
  }
  localStorage.setItem('oddker_pwa_favs', JSON.stringify(state.favorites));
  renderFavorites();
}

function renderFavorites() {
  const grid = document.getElementById('favorites-list');
  const emptyEl = document.getElementById('favorites-empty');
  grid.innerHTML = '';

  if (state.favorites.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  state.favorites.forEach(prod => {
    grid.appendChild(createProductCardElement(prod));
  });
}

function renderBranches() {
  const container = document.getElementById('branches-list');
  container.innerHTML = '';
  BRANCH_LIST.forEach(b => {
    const card = document.createElement('div');
    card.className = 'branch-card';
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('歐客衛浴 ' + b.address)}`;
    card.innerHTML = `
      <div class="branch-name">${b.name}</div>
      <div class="branch-detail">📍 ${b.address}</div>
      <div class="branch-detail">🕒 ${b.hours}</div>
      <div class="branch-actions">
        <a href="tel:${b.phone}" class="btn-mini-link">📞 撥打 ${b.phone}</a>
        <a href="${mapUrl}" target="_blank" rel="noopener" class="btn-mini-link">🗺️ Google 地圖導航</a>
      </div>
    `;
    container.appendChild(card);
  });
}

// ==================== 全螢幕圖片縮放檢視器 ====================

function openLightbox(imgSrc) {
  const modal = document.getElementById('lightbox-modal');
  const img = document.getElementById('lightbox-img');
  const range = document.getElementById('lightbox-zoom-range');
  img.src = imgSrc;
  range.value = '1';
  img.style.transform = 'scale(1)';
  modal.classList.remove('hidden');
}

// ==================== 事件綁定与導覽切換 ====================

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab-view').forEach(sec => {
    sec.classList.toggle('hidden', sec.id !== `tab-${tabName}`);
  });
  document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.getElementById('main-scroll').scrollTo({ top: 0, behavior: 'smooth' });
}

function bindUIEvents() {
  // 底部導覽列切換
  document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 搜尋列切換與送出
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  document.getElementById('btn-toggle-search').addEventListener('click', () => {
    searchForm.classList.toggle('hidden');
    if (!searchForm.classList.contains('hidden')) searchInput.focus();
  });

  searchForm.addEventListener('submit', e => {
    e.preventDefault();
    state.searchQuery = searchInput.value.trim();
    switchTab('catalog');
    loadCatalog(true);
  });

  document.getElementById('btn-clear-search').addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    searchForm.classList.add('hidden');
    loadCatalog(true);
  });

  // 排序按鈕
  document.querySelectorAll('.sort-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.sort-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.sortOrder = chip.dataset.sort;
      loadCatalog(true);
    });
  });

  // 載入更多與無限滾動
  document.getElementById('btn-load-more').addEventListener('click', () => {
    if (state.currentPage < state.totalPages && !state.isLoadingCatalog) {
      state.currentPage += 1;
      loadCatalog(false);
    }
  });

  const mainScroll = document.getElementById('main-scroll');
  mainScroll.addEventListener('scroll', () => {
    if (state.activeTab !== 'catalog' || state.isLoadingCatalog) return;
    if (state.currentPage >= state.totalPages) return;
    const nearBottom = mainScroll.scrollTop + mainScroll.clientHeight >= mainScroll.scrollHeight - 280;
    if (nearBottom) {
      state.currentPage += 1;
      loadCatalog(false);
    }
  });

  // 商品詳情頁關閉與動作
  document.getElementById('btn-close-detail').addEventListener('click', () => {
    document.getElementById('detail-modal').classList.add('hidden');
  });
  document.getElementById('detail-backdrop').addEventListener('click', () => {
    document.getElementById('detail-modal').classList.add('hidden');
  });

  document.getElementById('btn-detail-fav').addEventListener('click', () => {
    if (!state.currentDetail) return;
    toggleFavorite(state.currentDetail);
    const isFav = state.favorites.some(f => f.id === state.currentDetail.id);
    document.getElementById('btn-detail-fav').textContent = isFav ? '❤️' : '🤍';
  });

  document.getElementById('btn-qty-minus').addEventListener('click', () => {
    if (state.detailQuantity > 1) {
      state.detailQuantity -= 1;
      document.getElementById('detail-qty-val').textContent = String(state.detailQuantity);
    }
  });

  document.getElementById('btn-qty-plus').addEventListener('click', () => {
    state.detailQuantity += 1;
    document.getElementById('detail-qty-val').textContent = String(state.detailQuantity);
  });

  document.getElementById('btn-add-to-cart').addEventListener('click', addCurrentDetailToCart);

  // 購物車清空與雙軌結帳
  document.getElementById('btn-clear-cart').addEventListener('click', () => {
    state.cart = [];
    saveCart();
    updateCartBadgeAndView();
    showToast('已清空購物車');
  });

  document.getElementById('btn-line-order').addEventListener('click', handleLineQuickOrder);
  document.getElementById('btn-web-checkout').addEventListener('click', handleWebSessionCheckout);

  // 關閉官網結帳 Modal
  document.getElementById('btn-close-checkout-modal').addEventListener('click', () => {
    document.getElementById('checkout-iframe-modal').classList.add('hidden');
  });
  document.getElementById('checkout-backdrop').addEventListener('click', () => {
    document.getElementById('checkout-iframe-modal').classList.add('hidden');
  });

  // 全螢幕圖片縮放控制
  const lbImg = document.getElementById('lightbox-img');
  const lbRange = document.getElementById('lightbox-zoom-range');
  lbRange.addEventListener('input', () => {
    lbImg.style.transform = `scale(${lbRange.value})`;
  });
  lbImg.addEventListener('dblclick', () => {
    const nextScale = lbRange.value === '1' ? '2.5' : '1';
    lbRange.value = nextScale;
    lbImg.style.transform = `scale(${nextScale})`;
  });
  document.getElementById('btn-reset-zoom').addEventListener('click', () => {
    lbRange.value = '1';
    lbImg.style.transform = 'scale(1)';
  });
  document.getElementById('btn-close-lightbox').addEventListener('click', () => {
    document.getElementById('lightbox-modal').classList.add('hidden');
  });
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('hidden');
  }, 2400);
}
