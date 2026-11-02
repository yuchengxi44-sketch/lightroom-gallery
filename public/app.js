(() => {
  const $ = s => document.querySelector(s);

  const CATEGORY_LABELS = {
    landscape: '风光', portrait: '人像', street: '街拍', still: '静物',
    animal: '动物', architecture: '建筑', documentary: '纪实', other: '其他'
  };

  const state = { type: 'all', categories: [], q: '', sort: 'new', page: 1, limit: 12, hasMore: true, items: [] };
  let currentUser = null;
  let pendingAction = null;

  const grid = $('#grid');
  const emptyState = $('#emptyState');
  const emptyText = $('#emptyText');
  const loadMoreBtn = $('#loadMore');
  const countEl = $('#count');

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function renderTagList(tags, max = 0) {
    if (!Array.isArray(tags) || !tags.length) return '';
    const shown = max > 0 ? tags.slice(0, max) : tags;
    const more = max > 0 && tags.length > max ? tags.length - max : 0;
    return shown.map(t => `<span class="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')
      + (more ? `<span class="tag more">+${more}</span>` : '');
  }
  function renderCatLabels(cats) {
    const arr = Array.isArray(cats) ? cats : (cats ? [cats] : []);
    return arr.map(c => CATEGORY_LABELS[c] || '其他').join(' / ');
  }
  function parseTagsClient(raw) {
    return [...new Set(String(raw || '').split(/[\s,，、]+/).map(t => t.replace(/^#+/, '').trim()).filter(t => t && t.length <= 20))].slice(0, 10);
  }
  function coverOf(item) {
    if (Array.isArray(item.images) && item.images.length) return item.images[0];
    return item.url || item.cover || '';
  }
  function copyText(text) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch {}
      document.body.removeChild(ta); return ok;
    };
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true).catch(fallback);
    return Promise.resolve(fallback());
  }

  function loadUser() {
    const token = localStorage.getItem('gallery_token');
    const username = localStorage.getItem('gallery_username');
    if (token && username) currentUser = { token, username };
  }
  function saveUser(token, username) {
    currentUser = { token, username };
    localStorage.setItem('gallery_token', token);
    localStorage.setItem('gallery_username', username);
    updateAuthUI();
  }
  function clearUser() {
    currentUser = null;
    localStorage.removeItem('gallery_token');
    localStorage.removeItem('gallery_username');
    updateAuthUI();
    updateNotifBadge(0);
  }
  function updateAuthUI() {
    const logged = !!currentUser;
    $('#guestArea').hidden = logged;
    $('#authArea').hidden = !logged;
    ['#navMy', '#navCollected', '#navHistory', '#btnMy2', '#btnCollected2'].forEach(sel => {
      const el = $(sel); if (el) el.hidden = !logged;
    });
    if (logged) $('#usernameText').textContent = 'Hi, ' + currentUser.username;
  }
  async function verifyUser() {
    if (!currentUser) return;
    try {
      const res = await fetch('/api/auth/me', { headers: { 'x-user-token': currentUser.token } });
      if (!res.ok) clearUser();
    } catch {}
  }

  const authModal = $('#authModal');
  const authForm = $('#authForm');
  const authMsg = $('#authMsg');
  const authSubmit = $('#authSubmit');
  const authTitle = $('#authTitle');
  const authSub = $('#authSub');
  let authMode = 'login';

  function openAuth(mode = 'login') {
    authMode = mode;
    authTitle.textContent = mode === 'login' ? '登录' : '注册新账号';
    authSub.textContent = mode === 'login' ? '登录后可上传作品、查看审核结果' : '注册后即可上传作品';
    authSubmit.textContent = mode === 'login' ? '登录' : '注册';
    authMsg.textContent = '';
    document.querySelectorAll('#authTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    authForm.reset();
    authModal.hidden = false; document.body.style.overflow = 'hidden';
    setTimeout(() => authForm.username.focus(), 50);
  }
  function closeAuth() { authModal.hidden = true; document.body.style.overflow = ''; }
  document.querySelectorAll('#authTabs .tab').forEach(t => t.addEventListener('click', () => openAuth(t.dataset.mode)));
  authModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeAuth));

  authForm.addEventListener('submit', async e => {
    e.preventDefault();
    const username = (authForm.username.value || '').trim();
    const password = authForm.password.value || '';
    if (!username || !password) { authMsg.textContent = '请输入用户名和密码'; return; }
    authSubmit.disabled = true;
    const oldText = authSubmit.textContent;
    authSubmit.textContent = '处理中…';
    authMsg.textContent = '';
    try {
      const url = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await res.json();
      if (res.ok && data.ok) {
        saveUser(data.token, data.username);
        closeAuth();
        if (pendingAction === 'upload-photo') { pendingAction = null; photoUploader.open(); }
        else if (pendingAction === 'upload-video') { pendingAction = null; videoUploader.open(); }
        else if (pendingAction === 'my') { pendingAction = null; openMy(); }
        else if (pendingAction === 'collected') { pendingAction = null; openCollected(); }
        else if (pendingAction === 'history') { pendingAction = null; openHistory(); }
        else if (pendingAction === 'notif') { pendingAction = null; openNotif(); }
        refreshUnread();
        fetchItems(true);
      } else {
        authMsg.textContent = data.error || '操作失败';
      }
    } catch { authMsg.textContent = '网络错误'; }
    finally { authSubmit.disabled = false; authSubmit.textContent = oldText; }
  });

  $('#btnLogin').addEventListener('click', () => openAuth('login'));
  $('#btnLogout').addEventListener('click', async () => {
    if (!currentUser) return;
    try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-user-token': currentUser.token } }); } catch {}
    clearUser();
    fetchItems(true);
  });

  function requireLogin(action) {
    if (currentUser) return false;
    pendingAction = action;
    openAuth('login');
    return true;
  }

  const searchInput = $('#searchInput');
  const searchClear = $('#searchClear');
  let searchTimer = null;
  function doSearch(immediate = false) {
    const v = searchInput.value.trim();
    searchClear.hidden = !v;
    clearTimeout(searchTimer);
    if (immediate) applySearch(v);
    else searchTimer = setTimeout(() => applySearch(v), 300);
  }
  function applySearch(v) {
    if (state.q === v) return;
    state.q = v; fetchItems(true);
  }
  searchInput.addEventListener('input', () => doSearch(false));
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(true); } });
  searchClear.addEventListener('click', () => { searchInput.value = ''; searchClear.hidden = true; applySearch(''); searchInput.focus(); });

  document.addEventListener('click', e => {
    const tagEl = e.target.closest('.tag[data-tag]');
    if (!tagEl) return;
    const tag = tagEl.dataset.tag;
    if (!tag) return;
    if (!document.getElementById('lightbox').hidden) closeLightbox();
    searchInput.value = tag; searchClear.hidden = false; applySearch(tag);
    document.getElementById('gallery').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const sortSelect = $('#sortSelect');
  sortSelect.addEventListener('change', () => { state.sort = sortSelect.value; fetchItems(true); });

  async function loadHotTags() {
    try {
      const res = await fetch('/api/tags/hot?limit=15');
      const data = await res.json();
      const tags = data.tags || [];
      const wrap = $('#hotTagsWrap');
      const box = $('#hotTags');
      if (!tags.length) { wrap.hidden = true; return; }
      wrap.hidden = false;
      box.innerHTML = tags.map(t =>
        `<button class="hot-tag" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)} <span class="cnt">${t.count}</span></button>`
      ).join('');
      box.querySelectorAll('.hot-tag').forEach(btn => {
        btn.addEventListener('click', () => {
          searchInput.value = btn.dataset.tag;
          searchClear.hidden = false;
          applySearch(btn.dataset.tag);
        });
      });
    } catch {}
  }

  const catHint = $('#catHint');
  function updateCatChips() {
    document.querySelectorAll('#catTabs .cat-chip').forEach(el => {
      const cc = el.dataset.cat;
      if (cc === 'all') el.classList.toggle('active', state.categories.length === 0);
      else el.classList.toggle('active', state.categories.includes(cc));
    });
    catHint.hidden = state.categories.length < 2;
  }
  $('#catTabs').addEventListener('click', e => {
    const chip = e.target.closest('.cat-chip');
    if (!chip) return;
    const c = chip.dataset.cat;
    if (c === 'all') {
      state.categories = [];
    } else {
      const idx = state.categories.indexOf(c);
      if (idx >= 0) state.categories.splice(idx, 1);
      else state.categories.push(c);
    }
    updateCatChips();
    fetchItems(true);
  });

  let reqSeq = 0;
  async function fetchItems(reset = false) {
    const seq = ++reqSeq;
    if (reset) { state.page = 1; state.items = []; }
    loadMoreBtn.disabled = true;
    try {
      const q = new URLSearchParams({ page: state.page, limit: state.limit, sort: state.sort });
      if (state.type !== 'all') q.set('type', state.type);
      if (state.categories.length) q.set('categories', state.categories.join(','));
      if (state.q) q.set('q', state.q);
      const headers = {};
      if (currentUser) headers['x-user-token'] = currentUser.token;
      const res = await fetch('/api/items?' + q, { headers });
      const data = await res.json();
      if (seq !== reqSeq) return;
      state.items = reset ? data.items : state.items.concat(data.items);
      state.hasMore = data.hasMore;
      state.page++;
      render();
    } catch (e) { console.error(e); }
    finally { if (seq === reqSeq) loadMoreBtn.disabled = false; }
  }

  function render() {
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    state.items.forEach(item => frag.appendChild(createCard(item)));
    grid.appendChild(frag);
    const empty = state.items.length === 0;
    emptyState.hidden = !empty;
    if (empty) emptyText.textContent = state.q ? `没有找到与「${state.q}」相关的作品` : '还没有作品';
    loadMoreBtn.hidden = !state.hasMore;
    countEl.textContent = state.items.length ? `共 ${state.items.length} 件作品` : '';
  }

  function createCard(item) {
    const card = document.createElement('article');
    card.className = 'card'; card.tabIndex = 0;
    card.dataset.itemId = item.id;
    const media = document.createElement('div'); media.className = 'media';
    const cover = coverOf(item);

    if (item.type === 'video') {
      const v = document.createElement('video');
      v.src = cover; v.preload = 'metadata'; v.muted = true; v.playsInline = true;
      media.appendChild(v);
      const badge = document.createElement('span');
      badge.className = 'badge'; badge.textContent = '▶ 视频';
      media.appendChild(badge);
    } else {
      const img = document.createElement('img');
      img.src = cover; img.loading = 'lazy'; img.decoding = 'async'; img.alt = item.title;
      media.appendChild(img);
      if (Array.isArray(item.images) && item.images.length > 1) {
        const badge = document.createElement('span');
        badge.className = 'img-count';
        badge.textContent = '🖼 ' + item.images.length;
        media.appendChild(badge);
      }
    }

    const likeBtn = document.createElement('button');
    likeBtn.className = 'like-btn' + (item.liked ? ' on' : '');
    likeBtn.dataset.itemId = item.id;
    likeBtn.innerHTML = `${item.liked ? '♥' : '♡'} <span class="num">${item.likeCount || 0}</span>`;
    likeBtn.title = item.liked ? '取消点赞' : '点赞';
    likeBtn.addEventListener('click', e => { e.stopPropagation(); toggleLike(item, likeBtn); });
    media.appendChild(likeBtn);

    const collectBtn = document.createElement('button');
    collectBtn.className = 'collect-btn' + (item.collected ? ' on' : '');
    collectBtn.dataset.itemId = item.id;
    collectBtn.textContent = item.collected ? '★' : '☆';
    collectBtn.title = item.collected ? '取消收藏' : '收藏';
    collectBtn.addEventListener('click', e => { e.stopPropagation(); toggleCollect(item, collectBtn); });
    media.appendChild(collectBtn);

    const meta = document.createElement('div'); meta.className = 'meta';
    const h3 = document.createElement('h3'); h3.textContent = item.title;
    const p = document.createElement('p');
    p.innerHTML = 'by <a class="author-link" data-author="' + escapeHtml(item.author) + '" title="查看该作者主页">' + escapeHtml(item.author) + '</a>';
    meta.append(h3, p);

    const catText = renderCatLabels(item.category);
    if (catText) {
      const cat = document.createElement('span');
      cat.className = 'cat'; cat.textContent = catText;
      meta.appendChild(cat);
    }
    if (Array.isArray(item.tags) && item.tags.length) {
      const tagList = document.createElement('div');
      tagList.className = 'tag-list';
      tagList.innerHTML = renderTagList(item.tags, 3);
      meta.appendChild(tagList);
    }

    card.append(media, meta);
    const authorLink = card.querySelector('.author-link');
    if (authorLink) authorLink.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); openAuthor(item.author); });
    card.addEventListener('click', () => openLightbox(item));
    card.addEventListener('keydown', e => { if (e.key === 'Enter') openLightbox(item); });
    return card;
  }

  function syncCardUI(item) {
    document.querySelectorAll(`.card[data-item-id="${item.id}"] .like-btn`).forEach(btn => {
      btn.classList.toggle('on', !!item.liked);
      btn.innerHTML = `${item.liked ? '♥' : '♡'} <span class="num">${item.likeCount || 0}</span>`;
      btn.title = item.liked ? '取消点赞' : '点赞';
    });
    document.querySelectorAll(`.card[data-item-id="${item.id}"] .collect-btn`).forEach(btn => {
      btn.classList.toggle('on', !!item.collected);
      btn.textContent = item.collected ? '★' : '☆';
      btn.title = item.collected ? '取消收藏' : '收藏';
    });
  }

  async function toggleLike(item, btnEl) {
    if (!currentUser) { openAuth('login'); return; }
    try {
      const res = await fetch('/api/like/' + item.id, { method: 'POST', headers: { 'x-user-token': currentUser.token } });
      if (res.status === 401) { clearUser(); openAuth('login'); return; }
      const data = await res.json();
      if (res.ok && data.ok) {
        item.liked = data.liked; item.likeCount = data.count;
        syncCardUI(item);
        if (!lb.hidden && lbCurrentItem && lbCurrentItem.id === item.id) updateLbActions();
      }
    } catch {}
  }

  async function toggleCollect(item, btnEl) {
    if (!currentUser) { openAuth('login'); return; }
    try {
      const res = await fetch('/api/collect/' + item.id, { method: 'POST', headers: { 'x-user-token': currentUser.token } });
      if (res.status === 401) { clearUser(); openAuth('login'); return; }
      const data = await res.json();
      if (res.ok && data.ok) {
        item.collected = data.collected; item.collectCount = data.count;
        syncCardUI(item);
        if (!lb.hidden && lbCurrentItem && lbCurrentItem.id === item.id) updateLbActions();
      }
    } catch {}
  }

  $('#typeTabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab || tab.classList.contains('active')) return;
    document.querySelectorAll('#typeTabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active'); state.type = tab.dataset.type; fetchItems(true);
  });
  loadMoreBtn.addEventListener('click', () => fetchItems(false));

  const lb = $('#lightbox');
  const lbStage = $('#lbStage');
  const lbTitle = $('#lbTitle');
  const lbMeta = $('#lbMeta');
  const lbTags = $('#lbTags');
  const lbDesc = $('#lbDesc');
  const lbLike = $('#lbLike');
  const lbCollect = $('#lbCollect');
  const lbCopy = $('#lbCopy');
  const lbDownload = $('#lbDownload');
  const lbPrev = $('#lbPrev');
  const lbNext = $('#lbNext');
  const lbCounter = $('#lbCounter');
  const lbThumbs = $('#lbThumbs');
  let lbCurrentItem = null;
  let lbImages = [];
  let lbIndex = 0;
  let lbType = 'image';

  function openLightbox(item) {
    lbCurrentItem = item;
    lbImages = Array.isArray(item.images) && item.images.length
      ? item.images.slice()
      : (item.url ? [item.url] : (item.cover ? [item.cover] : []));
    lbType = item.type || 'image';
    lbIndex = 0;
    renderLbStage();

    lbTitle.textContent = item.title;
    const catText = renderCatLabels(item.category);
    lbMeta.textContent = `by ${item.author}${catText ? ' · ' + catText : ''}`;
    lbTags.innerHTML = '';
    if (Array.isArray(item.tags) && item.tags.length) {
      const wrap = document.createElement('div');
      wrap.className = 'lb-tags-wrap';
      wrap.innerHTML = renderTagList(item.tags);
      lbTags.appendChild(wrap);
    }
    lbDesc.textContent = item.description || '';
    renderLbExif(item);
    updateLbActions();
    lb.hidden = false; document.body.style.overflow = 'hidden';

    if (currentUser) {
      fetch('/api/view/' + item.id, { method: 'POST', headers: { 'x-user-token': currentUser.token } }).catch(() => {});
    }
  }

  function renderLbExif(item) {
    const lbExif = $('#lbExif');
    if (item.type === 'image' && item.exif) {
      const rows = [];
      if (item.exif.make || item.exif.model) rows.push(['相机', [item.exif.make, item.exif.model].filter(Boolean).join(' ')]);
      if (item.exif.lens) rows.push(['镜头', item.exif.lens]);
      if (item.exif.fNumber) rows.push(['光圈', 'f/' + item.exif.fNumber]);
      if (item.exif.exposureTime) {
        const t = item.exif.exposureTime;
        rows.push(['快门', t >= 1 ? t.toFixed(1).replace(/\.0$/, '') + 's' : '1/' + Math.round(1 / t) + 's']);
      }
      if (item.exif.iso) rows.push(['ISO', item.exif.iso]);
      if (item.exif.focalLength) rows.push(['焦距', Math.round(item.exif.focalLength) + 'mm']);
      if (item.exif.dateTimeOriginal) rows.push(['拍摄', new Date(item.exif.dateTimeOriginal).toLocaleDateString('zh-CN')]);
      lbExif.innerHTML = rows.map(([k, v]) => `<div class="exif-cell"><div class="exif-k">${k}</div><div class="exif-v">${escapeHtml(String(v))}</div></div>`).join('');
      lbExif.hidden = false;
    } else {
      lbExif.innerHTML = '';
      lbExif.hidden = true;
    }
  }

  function renderLbStage() {
    lbStage.innerHTML = '';
    const src = lbImages[lbIndex];
    if (!src) return;
    if (lbType === 'video') {
      const v = document.createElement('video');
      v.src = src; v.controls = true; v.autoplay = true; v.muted = true; v.playsInline = true;
      v.preload = 'metadata';
      lbStage.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = src; img.alt = lbCurrentItem ? lbCurrentItem.title : '';
      lbStage.appendChild(img);
    }
    const multi = lbImages.length > 1;
    lbPrev.hidden = !multi; lbNext.hidden = !multi;
    lbCounter.hidden = !multi; lbThumbs.hidden = !multi;
    if (multi) {
      lbCounter.textContent = `${lbIndex + 1} / ${lbImages.length}`;
      lbPrev.disabled = lbIndex === 0;
      lbNext.disabled = lbIndex === lbImages.length - 1;
      renderLbThumbs();
    }
  }

  function renderLbThumbs() {
    lbThumbs.innerHTML = '';
    lbImages.forEach((src, i) => {
      const t = document.createElement('button');
      t.className = 'lb-thumb' + (i === lbIndex ? ' active' : '');
      t.type = 'button';
      if (lbType === 'video') {
        t.textContent = '▶';
        t.style.color = '#fff';
      } else {
        const im = document.createElement('img');
        im.src = src; im.alt = '';
        t.appendChild(im);
      }
      t.addEventListener('click', () => { lbIndex = i; renderLbStage(); });
      lbThumbs.appendChild(t);
    });
  }

  function lbGo(delta) {
    if (lbImages.length < 2) return;
    const next = lbIndex + delta;
    if (next < 0 || next >= lbImages.length) return;
    lbIndex = next; renderLbStage();
  }

  function updateLbActions() {
    if (!lbCurrentItem) return;
    lbLike.classList.toggle('on', !!lbCurrentItem.liked);
    lbLike.classList.toggle('like', true);
    lbLike.textContent = (lbCurrentItem.liked ? '♥ 已点赞' : '♡ 点赞')
      + (lbCurrentItem.likeCount > 0 ? ` (${lbCurrentItem.likeCount})` : '');
    lbCollect.classList.toggle('on', !!lbCurrentItem.collected);
    lbCollect.textContent = (lbCurrentItem.collected ? '★ 已收藏' : '☆ 收藏')
      + (lbCurrentItem.collectCount > 0 ? ` (${lbCurrentItem.collectCount})` : '');
  }

  function closeLightbox() {
    lb.hidden = true; lbStage.innerHTML = ''; lbThumbs.innerHTML = '';
    lbCurrentItem = null; lbImages = []; lbIndex = 0;
    document.body.style.overflow = '';
  }
  $('#lbClose').addEventListener('click', closeLightbox);
  lb.addEventListener('click', e => {
    if (e.target === lb || e.target === lbStage) closeLightbox();
  });
  document.addEventListener('keydown', e => {
    if (lb.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lbGo(-1);
    else if (e.key === 'ArrowRight') lbGo(1);
  });
  lbPrev.addEventListener('click', () => lbGo(-1));
  lbNext.addEventListener('click', () => lbGo(1));

  lbLike.addEventListener('click', () => { if (lbCurrentItem) toggleLike(lbCurrentItem, null); });
  lbCollect.addEventListener('click', () => { if (lbCurrentItem) toggleCollect(lbCurrentItem, null); });
  lbDownload.addEventListener('click', async () => {
    if (!lbCurrentItem) return;
    const it = lbCurrentItem;
    const src = lbImages[lbIndex];
    if (!src) return;
    const oldText = lbDownload.textContent;
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const orig = (Array.isArray(it.originalnames) ? it.originalnames[lbIndex] : '') || it.title.replace(/[\\/:*?"<>|]/g, '_') + (it.type === 'video' ? '.mp4' : '.jpg');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = orig; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
      lbDownload.textContent = '✅ 已下载';
    } catch {
      lbDownload.textContent = '下载失败';
    }
    setTimeout(() => { lbDownload.textContent = oldText; }, 1500);
  });
  lbCopy.addEventListener('click', async () => {
    if (!lbCurrentItem) return;
    const it = lbCurrentItem;
    const lines = [];
    lines.push(it.title);
    if (it.description) lines.push(it.description);
    if (Array.isArray(it.tags) && it.tags.length) lines.push(it.tags.map(t => '#' + t).join(' '));
    lines.push(`by ${it.author}`);
    const ok = await copyText(lines.join('\n'));
    const oldText = lbCopy.textContent;
    lbCopy.textContent = ok ? '✅ 已复制' : '复制失败';
    setTimeout(() => { lbCopy.textContent = oldText; }, 1500);
  });

  function setupUploadModal(modalId, formId, kind) {
    const modal = document.getElementById(modalId);
    const form = document.getElementById(formId);
    const drop = form.querySelector('.drop');
    const dropInner = form.querySelector('.drop-inner');
    const previewList = form.querySelector('.preview-list');
    const fileInput = form.querySelector('input[type=file]');
    const progressWrap = form.querySelector('.progress');
    const bar = form.querySelector('.bar');
    const pct = form.querySelector('.pct');
    const msg = form.querySelector('.msg');
    const submitBtn = form.querySelector('.submit-btn');
    const tagInput = form.querySelector('input[name=tags]');
    const tagPreview = form.querySelector('.tag-preview');
    const catInputs = form.querySelectorAll('.cat-picker input[type=checkbox]');
    const maxFiles = kind === 'image' ? 9 : 1;
    let selectedFiles = [];

    form.querySelectorAll('[data-max]').forEach(el => {
      const max = parseInt(el.dataset.max);
      const field = el.closest('.field');
      const counter = field?.querySelector('.char-count');
      if (!counter) return;
      const update = () => {
        const len = el.value.length;
        counter.textContent = `${len} / ${max}`;
        counter.classList.toggle('warn', len >= max * 0.85 && len < max);
        counter.classList.toggle('over', len >= max);
      };
      el.addEventListener('input', update); update();
    });

    function updateTagPreview() { tagPreview.innerHTML = renderTagList(parseTagsClient(tagInput.value)); }
    tagInput.addEventListener('input', updateTagPreview);

    function resetPreviews() {
      selectedFiles = [];
      previewList.innerHTML = '';
      previewList.hidden = true;
      dropInner.hidden = false;
      fileInput.value = '';
    }

    function renderPreviews() {
      previewList.innerHTML = '';
      if (!selectedFiles.length) {
        previewList.hidden = true; dropInner.hidden = false; return;
      }
      previewList.hidden = false; dropInner.hidden = true;
      selectedFiles.forEach((f, i) => {
        const box = document.createElement('div');
        box.className = 'preview-item';
        const thumb = document.createElement(kind === 'video' ? 'video' : 'img');
        thumb.src = URL.createObjectURL(f);
        if (kind === 'video') { thumb.muted = true; thumb.playsInline = true; }
        const rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'preview-rm'; rm.textContent = '×';
        rm.title = '移除';
        rm.addEventListener('click', e => {
          e.stopPropagation();
          selectedFiles.splice(i, 1);
          renderPreviews();
        });
        box.append(thumb, rm);
        previewList.appendChild(box);
      });
      if (selectedFiles.length < maxFiles) {
        const add = document.createElement('button');
        add.type = 'button'; add.className = 'preview-add'; add.textContent = '+';
        add.title = '继续添加';
        add.addEventListener('click', () => fileInput.click());
        previewList.appendChild(add);
      }
    }

    function addFiles(fileList) {
      const arr = Array.from(fileList || []);
      const valid = [];
      for (const f of arr) {
        const ok = kind === 'image' ? f.type.startsWith('image/') : f.type.startsWith('video/');
        if (!ok) { showMsg(kind === 'image' ? '只能选择图片文件' : '只能选择视频文件', true); continue; }
        if (f.size > 300 * 1024 * 1024) { showMsg(`「${f.name}」超过 300MB 限制`, true); continue; }
        valid.push(f);
      }
      if (kind === 'image') {
        const merged = selectedFiles.concat(valid);
        if (merged.length > maxFiles) {
          showMsg(`最多只能选择 ${maxFiles} 张图片`, true);
          selectedFiles = merged.slice(0, maxFiles);
        } else {
          selectedFiles = merged;
          msg.innerHTML = '';
        }
      } else {
        selectedFiles = valid.slice(0, 1);
        msg.innerHTML = '';
      }
      const total = selectedFiles.reduce((s, f) => s + f.size, 0);
      if (total > 500 * 1024 * 1024) {
        showMsg('文件总大小超过 500MB，请减少数量', true);
      }
      renderPreviews();
    }

    function open() {
      if (requireLogin(kind === 'image' ? 'upload-photo' : 'upload-video')) return;
      modal.hidden = false; document.body.style.overflow = 'hidden';
      msg.innerHTML = ''; msg.className = 'msg'; updateTagPreview();
    }
    function close() {
      if (submitBtn.disabled) return;
      modal.hidden = true; document.body.style.overflow = '';
    }
    modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));

    drop.addEventListener('click', e => {
      if (e.target.closest('.preview-rm') || e.target.closest('.preview-add')) return;
      if (e.target.closest('.preview-list')) return;
      fileInput.click();
    });
    ['dragenter', 'dragover'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(evt => drop.addEventListener(evt, e => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', e => {
      const files = e.dataTransfer.files;
      if (files && files.length) addFiles(files);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
      fileInput.value = '';
    });

    function showMsg(text, isErr = false) { msg.innerHTML = escapeHtml(text); msg.className = 'msg' + (isErr ? ' err' : ''); }

    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!currentUser) { close(); requireLogin(kind === 'image' ? 'upload-photo' : 'upload-video'); return; }
      if (!selectedFiles.length) { showMsg('请先选择文件', true); return; }

      const title = (form.title.value || '').trim();
      const author = (form.author.value || '').trim();
      const cats = [...catInputs].filter(c => c.checked).map(c => c.value);
      if (!title || !author) { showMsg('标题和作者为必填', true); return; }
      if (!cats.length) { showMsg('请至少选择一个题材分类', true); return; }

      const fd = new FormData(form);
      fd.delete('files');
      selectedFiles.forEach(f => fd.append('files', f));
      fd.set('category', cats.join(','));
      fd.set('tags', parseTagsClient((fd.get('tags') || '').toString()).join(' '));

      submitBtn.disabled = true; submitBtn.textContent = '上传中…'; progressWrap.hidden = false;
      bar.style.setProperty('--w', '0%'); pct.textContent = '0%';

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('x-user-token', currentUser.token);
      xhr.upload.onprogress = ev => {
        if (!ev.lengthComputable) return;
        const p = Math.round(ev.loaded / ev.total * 100);
        bar.style.setProperty('--w', p + '%'); pct.textContent = p + '%';
      };
      xhr.onload = () => {
        submitBtn.disabled = false; submitBtn.textContent = '提交审核';
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          bar.style.setProperty('--w', '100%'); pct.textContent = '100%';
          msg.className = 'msg';
          msg.innerHTML = `✅ 提交成功！请到 <a id="toMy" style="color:var(--accent-2);text-decoration:underline;cursor:pointer">我的投稿</a> 查看审核状态。`;
          msg.querySelector('#toMy').addEventListener('click', () => { close(); openMy(); });
          form.reset();
          form.querySelectorAll('[data-max]').forEach(el => el.dispatchEvent(new Event('input')));
          resetPreviews(); tagPreview.innerHTML = '';
          loadHotTags();
          setTimeout(() => { progressWrap.hidden = true; bar.style.setProperty('--w', '0%'); pct.textContent = '0%'; }, 1200);
        } else {
          showMsg(data.error || '上传失败，请重试', true); progressWrap.hidden = true;
        }
      };
      xhr.onerror = () => {
        submitBtn.disabled = false; submitBtn.textContent = '提交审核'; progressWrap.hidden = true;
        showMsg('网络错误，上传失败', true);
      };
      xhr.send(fd);
    });

    return { open, close };
  }

  const photoUploader = setupUploadModal('photoModal', 'photoForm', 'image');
  const videoUploader = setupUploadModal('videoModal', 'videoForm', 'video');

  ['#btnUploadPhoto', '#btnUploadPhoto2', '#btnUploadPhoto3'].forEach(s => { const el = $(s); if (el) el.addEventListener('click', photoUploader.open); });
  ['#btnUploadVideo', '#btnUploadVideo2', '#btnUploadVideo3'].forEach(s => { const el = $(s); if (el) el.addEventListener('click', videoUploader.open); });

  const myModal = $('#myModal');
  const myList = $('#myList');
  let myAllItems = [];
  let myFilter = 'all';

  function openMy() {
    if (requireLogin('my')) return;
    myModal.hidden = false; document.body.style.overflow = 'hidden';
    myFilter = 'all';
    document.querySelectorAll('#myTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.status === 'all'));
    myList.innerHTML = '<p class="my-empty">加载中…</p>'; loadMy();
  }
  function closeMy() { myModal.hidden = true; document.body.style.overflow = ''; }
  myModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeMy));
  ['#navMy', '#btnMy2'].forEach(s => { const el = $(s); if (el) el.addEventListener('click', openMy); });
  document.querySelectorAll('#myTabs .tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#myTabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active'); myFilter = t.dataset.status; renderMy();
    });
  });

  async function loadMy() {
    if (!currentUser) return;
    try {
      const res = await fetch('/api/my/items', { headers: { 'x-user-token': currentUser.token } });
      if (res.status === 401) { clearUser(); closeMy(); openAuth('login'); return; }
      const data = await res.json();
      myAllItems = data.items || []; renderMy();
    } catch { myList.innerHTML = '<p class="my-empty">加载失败</p>'; }
  }

  function renderMy() {
    const items = myFilter === 'all' ? myAllItems : myAllItems.filter(i => i.status === myFilter);
    if (!myAllItems.length) { myList.innerHTML = '<p class="my-empty">你还没有投稿作品。</p>'; return; }
    if (!items.length) { myList.innerHTML = `<p class="my-empty">当前筛选下没有作品。</p>`; return; }
    myList.innerHTML = '';
    items.forEach(it => {
      const row = document.createElement('div'); row.className = 'my-item';
      const statusMap = { pending: { label: '审核中', cls: 'pending' }, approved: { label: '已通过', cls: 'approved' }, rejected: { label: '已拒绝', cls: 'rejected' } };
      const s = statusMap[it.status] || { label: it.status, cls: '' };
      const cover = coverOf(it);
      const count = Array.isArray(it.images) ? it.images.length : 1;
      const thumb = it.type === 'video'
        ? `<video src="${escapeHtml(cover)}" muted playsinline preload="metadata"></video>`
        : `<img src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">`;
      const catText = renderCatLabels(it.category) || '其他';
      row.innerHTML = `
        <div class="my-thumb">${thumb}</div>
        <div class="my-info">
          <h3>${escapeHtml(it.title)}</h3>
          <p>${it.type === 'video' ? '视频' : (count > 1 ? count + ' 张图片' : '图片')} · <span class="cat-inline">${escapeHtml(catText)}</span> · v${it.revision || 1} · ${new Date(it.createdAt).toLocaleString('zh-CN')}</p>
          <span class="status-badge ${s.cls}">${s.label}</span>
          ${Array.isArray(it.tags) && it.tags.length ? `<div class="tag-list">${renderTagList(it.tags)}</div>` : ''}
          ${it.status === 'rejected' && it.rejectReason ? `<div class="reject-box"><div class="reject-title">拒绝原因</div><div class="reject-text">${escapeHtml(it.rejectReason)}</div></div>` : ''}
          ${it.status === 'rejected' ? `<button class="resubmit-btn" data-id="${escapeHtml(it.id)}">✏️ 编辑并重新提交</button>` : ''}
        </div>
      `;
      const resubmit = row.querySelector('.resubmit-btn');
      if (resubmit) {
        resubmit.addEventListener('click', () => {
          const item = myAllItems.find(x => x.id === resubmit.dataset.id);
          if (item) openEdit(item);
        });
      }
      myList.appendChild(row);
    });
  }

  const editModal = $('#editModal');
  const editForm = $('#editForm');
  const editMsg = $('#editMsg');
  const editFileInfo = $('#editFileInfo');
  const editCatInputs = editForm.querySelectorAll('.cat-picker input[type=checkbox]');
  let editingItem = null;

  function openEdit(item) {
    editingItem = item;
    editMsg.textContent = '';
    const cover = coverOf(item);
    const count = Array.isArray(item.images) ? item.images.length : 1;
    const thumb = item.type === 'video'
      ? `<video src="${escapeHtml(cover)}" muted playsinline preload="metadata"></video>`
      : `<img src="${escapeHtml(cover)}" alt="">`;
    editFileInfo.innerHTML = `${thumb}<div class="info">
      文件不可更换<br>
      ${item.type === 'video' ? '视频' : (count > 1 ? count + ' 张图片' : '图片')} · ${(item.size/1024/1024).toFixed(2)} MB<br>
      当前版本：v${item.revision || 1}
    </div>`;
    editForm.title.value = item.title || '';
    const cats = Array.isArray(item.category) ? item.category : (item.category ? [item.category] : []);
    editCatInputs.forEach(c => { c.checked = cats.includes(c.value); });
    editForm.description.value = item.description || '';
    editForm.tags.value = (item.tags || []).join(' ');
    editModal.hidden = false; document.body.style.overflow = 'hidden';
    setTimeout(() => editForm.title.focus(), 50);
  }
  function closeEdit() { editModal.hidden = true; document.body.style.overflow = ''; }
  editModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeEdit));

  editForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!editingItem) return;
    const title = editForm.title.value.trim();
    if (!title) { editMsg.textContent = '标题为必填'; return; }
    const cats = [...editCatInputs].filter(c => c.checked).map(c => c.value);
    if (!cats.length) { editMsg.textContent = '请至少选择一个分类'; return; }
    editMsg.textContent = '';
    const btn = $('#editSubmit');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const res = await fetch('/api/my/items/' + editingItem.id + '/resubmit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-token': currentUser.token },
        body: JSON.stringify({
          title,
          description: editForm.description.value.trim(),
          tags: parseTagsClient(editForm.tags.value).join(' '),
          category: cats.join(',')
        })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        closeEdit(); loadMy(); loadHotTags(); fetchItems(true);
        alert('已重新提交，等待审核');
      } else {
        editMsg.textContent = data.error || '提交失败';
      }
    } catch { editMsg.textContent = '网络错误'; }
    finally { btn.disabled = false; btn.textContent = '重新提交审核'; }
  });

  const collectedModal = $('#collectedModal');
  const collectedList = $('#collectedList');

  function openCollected() {
    if (requireLogin('collected')) return;
    collectedModal.hidden = false; document.body.style.overflow = 'hidden';
    collectedList.innerHTML = '<p class="my-empty">加载中…</p>'; loadCollected();
  }
  function closeCollected() { collectedModal.hidden = true; document.body.style.overflow = ''; }
  collectedModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeCollected));
  ['#navCollected', '#btnCollected2'].forEach(s => { const el = $(s); if (el) el.addEventListener('click', openCollected); });

  async function loadCollected() {
    if (!currentUser) return;
    try {
      const res = await fetch('/api/my/collected', { headers: { 'x-user-token': currentUser.token } });
      if (res.status === 401) { clearUser(); closeCollected(); openAuth('login'); return; }
      const data = await res.json();
      renderCollected(data.items || []);
    } catch { collectedList.innerHTML = '<p class="my-empty">加载失败</p>'; }
  }

  function renderCollected(items) {
    if (!items.length) { collectedList.innerHTML = '<p class="my-empty">你还没有收藏任何作品。<br>浏览画廊时点作品卡片右上角的 ☆ 即可收藏。</p>'; return; }
    collectedList.innerHTML = '';
    items.forEach(it => {
      const row = document.createElement('div'); row.className = 'my-item';
      const cover = coverOf(it);
      const count = Array.isArray(it.images) ? it.images.length : 1;
      const thumb = it.type === 'video'
        ? `<video src="${escapeHtml(cover)}" muted playsinline preload="metadata"></video>`
        : `<img src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">`;
      const catText = renderCatLabels(it.category);
      row.innerHTML = `
        <div class="my-thumb">${thumb}</div>
        <div class="my-info">
          <h3>${escapeHtml(it.title)}</h3>
          <p>by ${escapeHtml(it.author)}${catText ? ' · ' + escapeHtml(catText) : ''}${count > 1 ? ' · ' + count + ' 张' : ''} · 点赞 ${it.likeCount||0} · 收藏 ${it.collectCount||0}</p>
          ${Array.isArray(it.tags) && it.tags.length ? `<div class="tag-list">${renderTagList(it.tags)}</div>` : ''}
          <button class="uncollect-btn" data-id="${escapeHtml(it.id)}">取消收藏</button>
        </div>
      `;
      row.querySelector('.uncollect-btn').addEventListener('click', async () => {
        try {
          const r = await fetch('/api/collect/' + it.id, { method: 'POST', headers: { 'x-user-token': currentUser.token } });
          const d = await r.json();
          if (r.ok && d.ok && !d.collected) { loadCollected(); fetchItems(true); }
        } catch {}
      });
      collectedList.appendChild(row);
    });
  }

  const historyModal = $('#historyModal');
  const historyList = $('#historyList');

  function openHistory() {
    if (requireLogin('history')) return;
    historyModal.hidden = false; document.body.style.overflow = 'hidden';
    historyList.innerHTML = '<p class="my-empty">加载中…</p>'; loadHistory();
  }
  function closeHistory() { historyModal.hidden = true; document.body.style.overflow = ''; }
  historyModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeHistory));
  $('#navHistory').addEventListener('click', openHistory);

  async function loadHistory() {
    if (!currentUser) return;
    try {
      const res = await fetch('/api/my/history', { headers: { 'x-user-token': currentUser.token } });
      if (res.status === 401) { clearUser(); closeHistory(); openAuth('login'); return; }
      const data = await res.json();
      renderHistory(data.items || []);
    } catch { historyList.innerHTML = '<p class="my-empty">加载失败</p>'; }
  }

  function renderHistory(items) {
    if (!items.length) { historyList.innerHTML = '<p class="my-empty">你还没有浏览过任何作品。</p>'; return; }
    historyList.innerHTML = '';
    items.forEach(it => {
      const row = document.createElement('div'); row.className = 'my-item';
      const cover = coverOf(it);
      const thumb = it.type === 'video'
        ? `<video src="${escapeHtml(cover)}" muted playsinline preload="metadata"></video>`
        : `<img src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">`;
      const catText = renderCatLabels(it.category);
      row.innerHTML = `
        <div class="my-thumb">${thumb}</div>
        <div class="my-info">
          <h3>${escapeHtml(it.title)}</h3>
          <p>by ${escapeHtml(it.author)}${catText ? ' · ' + escapeHtml(catText) : ''} · 浏览于 ${new Date(it.viewedAt).toLocaleString('zh-CN')}</p>
          ${Array.isArray(it.tags) && it.tags.length ? `<div class="tag-list">${renderTagList(it.tags)}</div>` : ''}
        </div>
      `;
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => { closeHistory(); openLightbox(it); });
      historyList.appendChild(row);
    });
  }

  const notifModal = $('#notifModal');
  const notifList = $('#notifList');
  const notifBadge = $('#notifBadge');

  function updateNotifBadge(count) {
    if (count > 0) { notifBadge.hidden = false; notifBadge.textContent = count > 99 ? '99+' : count; }
    else notifBadge.hidden = true;
  }
  async function refreshUnread() {
    if (!currentUser) { updateNotifBadge(0); return; }
    try {
      const res = await fetch('/api/notifications/unread-count', { headers: { 'x-user-token': currentUser.token } });
      const data = await res.json();
      updateNotifBadge(data.count || 0);
    } catch {}
  }
  $('#btnNotif').addEventListener('click', () => {
    if (requireLogin('notif')) return;
    openNotif();
  });
  function openNotif() {
    notifModal.hidden = false; document.body.style.overflow = 'hidden';
    notifList.innerHTML = '<p class="notif-empty">加载中…</p>'; loadNotif();
  }
  function closeNotif() { notifModal.hidden = true; document.body.style.overflow = ''; }
  notifModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeNotif));

  async function loadNotif() {
    if (!currentUser) return;
    try {
      const res = await fetch('/api/notifications', { headers: { 'x-user-token': currentUser.token } });
      if (res.status === 401) { clearUser(); closeNotif(); openAuth('login'); return; }
      const data = await res.json();
      const items = data.items || [];
      if (items.some(n => !n.read)) {
        await fetch('/api/notifications/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-token': currentUser.token },
          body: JSON.stringify({})
        });
        items.forEach(n => { n.read = true; });
        updateNotifBadge(0);
      }
      renderNotif(items);
    } catch { notifList.innerHTML = '<p class="notif-empty">加载失败</p>'; }
  }

  function renderNotif(items) {
    if (!items.length) { notifList.innerHTML = '<p class="notif-empty">暂无通知。</p>'; return; }
    notifList.innerHTML = '';
    items.forEach(n => {
      const el = document.createElement('div');
      el.className = 'notif-item' + (n.read ? '' : ' unread');
      const isApprove = n.action === 'approve';
      const icon = isApprove ? '✅' : '❌';
      const actionText = isApprove ? '已通过' : '被拒绝';
      el.innerHTML = `
        <div class="notif-icon">${icon}</div>
        <div class="notif-body">
          <div class="notif-title">你的作品 <b>${escapeHtml(n.itemTitle || '')}</b> ${actionText}</div>
          <div class="notif-time">${new Date(n.at).toLocaleString('zh-CN')}</div>
          ${!isApprove && n.reason ? `<div class="notif-reason">拒绝原因：${escapeHtml(n.reason)}</div>` : ''}
        </div>
      `;
      el.addEventListener('click', () => {
        closeNotif();
        if (isApprove) fetchItems(true);
        else openMy();
      });
      notifList.appendChild(el);
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentUser) refreshUnread();
  });

  const authorModal = $('#authorModal');
  const authorNameEl = $('#authorName');
  const authorCountEl = $('#authorCount');
  const authorList = $('#authorList');
  let authorItems = [];

  function openAuthor(author) {
    authorNameEl.textContent = author;
    authorCountEl.textContent = '';
    authorList.innerHTML = '<p class="my-empty">加载中…</p>';
    authorModal.hidden = false; document.body.style.overflow = 'hidden';
    loadAuthor(author);
  }
  function closeAuthor() { authorModal.hidden = true; document.body.style.overflow = ''; authorList.innerHTML = ''; authorItems = []; }
  authorModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeAuthor));

  async function loadAuthor(author) {
    try {
      const res = await fetch('/api/author/' + encodeURIComponent(author), { headers: currentUser ? { 'x-user-token': currentUser.token } : {} });
      const data = await res.json();
      authorItems = data.items || [];
      authorCountEl.textContent = data.total ? `共 ${data.total} 件作品` : '';
      renderAuthor();
    } catch { authorList.innerHTML = '<p class="my-empty">加载失败</p>'; }
  }

  function renderAuthor() {
    if (!authorItems.length) { authorList.innerHTML = '<p class="my-empty">这位作者还没有已通过的作品。</p>'; return; }
    authorList.innerHTML = '';
    authorItems.forEach(item => {
      const row = document.createElement('div'); row.className = 'my-item author-item';
      const cover = coverOf(item);
      const count = Array.isArray(item.images) ? item.images.length : 1;
      const thumb = item.type === 'video'
        ? `<video src="${escapeHtml(cover)}" muted playsinline preload="metadata"></video>`
        : `<img src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">`;
      const catText = renderCatLabels(item.category);
      row.innerHTML = `
        <div class="my-thumb">${thumb}</div>
        <div class="my-info">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${item.type === 'video' ? '视频' : (count > 1 ? count + ' 张图片' : '图片')}${catText ? ' · ' + escapeHtml(catText) : ''} · 赞 ${item.likeCount||0} · 藏 ${item.collectCount||0}</p>
          ${Array.isArray(item.tags) && item.tags.length ? `<div class="tag-list">${renderTagList(item.tags)}</div>` : ''}
        </div>
      `;
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => { closeAuthor(); openLightbox(item); });
      authorList.appendChild(row);
    });
  }

  loadUser();
  updateAuthUI();
  updateCatChips();
  verifyUser().then(() => {
    fetchItems(true);
    loadHotTags();
    refreshUnread();
  });
})();
