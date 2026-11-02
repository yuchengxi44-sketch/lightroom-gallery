const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const exifr = require('exifr');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';

if (ADMIN_TOKEN === 'admin123') {
  console.warn('\n⚠️  安全警告：正在使用默认管理密码 "admin123"');
  console.warn('   上线前请设置环境变量 ADMIN_TOKEN=你的强密码\n');
}

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_FILE = path.join(ROOT, 'data.json');
const USERS_FILE = path.join(ROOT, 'users.json');
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');
const VIEWS_FILE = path.join(ROOT, 'view_history.json');
const NOTIF_FILE = path.join(ROOT, 'notifications.json');
const SENSITIVE_FILE = path.join(ROOT, 'sensitive_words.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

[UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
[['data.json','[]'],['users.json','[]'],['sessions.json','{}'],['view_history.json','{}'],['notifications.json','{}'],['sensitive_words.json','[]']]
  .forEach(([f, def]) => { const p = path.join(ROOT, f); if (!fs.existsSync(p)) fs.writeFileSync(p, def); });

const readJSON = (file, def) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } };
const readData = () => readJSON(DATA_FILE, []);
const readUsers = () => readJSON(USERS_FILE, []);
const readSessions = () => readJSON(SESSIONS_FILE, {});
const readViews = () => readJSON(VIEWS_FILE, {});
const readNotifs = () => readJSON(NOTIF_FILE, {});
const readSensitive = () => readJSON(SENSITIVE_FILE, []);

function checkSensitive(text) {
  const words = readSensitive();
  if (!Array.isArray(words) || !words.length) return [];
  const s = String(text || '').toLowerCase();
  return words.filter(w => {
    const kw = String(w || '').trim().toLowerCase();
    return kw && s.includes(kw);
  });
}

const writeJSON = (file, obj) => {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
};

let writeChain = Promise.resolve();
function mutateData(fn) {
  const run = writeChain.catch(() => {}).then(() => {
    const data = readData();
    const out = fn(data);
    writeJSON(DATA_FILE, data);
    return out;
  });
  writeChain = run.catch(() => {});
  return run;
}

function pushNotification(userId, notif) {
  if (!userId) return;
  const all = readNotifs();
  if (!all[userId]) all[userId] = [];
  all[userId].unshift({
    id: crypto.randomBytes(6).toString('hex'),
    at: Date.now(),
    read: false,
    ...notif
  });
  if (all[userId].length > 200) all[userId] = all[userId].slice(0, 200);
  writeJSON(NOTIF_FILE, all);
}

function addHistory(item, entry) {
  if (!Array.isArray(item.history)) item.history = [];
  item.history.push({ at: Date.now(), ...entry });
  if (!item.revision) item.revision = 1;
}

const CATEGORIES = ['landscape','portrait','street','still','animal','architecture','documentary','other'];
const CATEGORY_LABELS = {
  landscape: '风光', portrait: '人像', street: '街拍', still: '静物',
  animal: '动物', architecture: '建筑', documentary: '纪实', other: '其他'
};

function migrateData() {
  const data = readData();
  let changed = false;
  data.forEach(it => {
    if (typeof it.category === 'string') {
      it.category = it.category ? [it.category] : [];
      changed = true;
    }
    if (!Array.isArray(it.category)) { it.category = []; changed = true; }
    if (!Array.isArray(it.images)) {
      it.images = it.url ? [it.url] : [];
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(it, 'url')) { delete it.url; changed = true; }
  });
  if (changed) writeJSON(DATA_FILE, data);
  return changed;
}

function coverOf(it) {
  if (Array.isArray(it.images) && it.images.length) return it.images[0];
  return it.url || '';
}

function formatShutter(t) {
  if (!t || isNaN(t)) return '';
  if (t >= 1) return t.toFixed(1).replace(/\.0$/, '') + 's';
  return '1/' + Math.round(1 / t) + 's';
}

async function extractExif(filePath) {
  try {
    const d = await exifr.parse(filePath, {
      pick: ['Make','Model','LensModel','FNumber','ExposureTime','ISO','FocalLength','DateTimeOriginal'],
      translateValues: true,
      reviveValues: true
    });
    if (!d) return null;
    const clean = v => (v == null ? '' : String(v).replace(/\0/g, '').trim());
    const exif = {
      make: clean(d.Make),
      model: clean(d.Model),
      lens: clean(d.LensModel),
      fNumber: d.FNumber || null,
      exposureTime: d.ExposureTime || null,
      iso: d.ISO || null,
      focalLength: d.FocalLength || null,
      dateTimeOriginal: d.DateTimeOriginal instanceof Date ? d.DateTimeOriginal.toISOString() : ''
    };
    if (!exif.make && !exif.model && !exif.lens && !exif.fNumber && !exif.exposureTime && !exif.iso && !exif.focalLength) return null;
    return exif;
  } catch { return null; }
}

function parseTags(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map(t => String(t).replace(/^#+/, '').trim()).filter(t => t && t.length <= 20))].slice(0, 10);
  }
  return [...new Set(String(raw || '').split(/[\s,，、]+/).map(t => t.replace(/^#+/, '').trim()).filter(t => t && t.length <= 20))].slice(0, 10);
}

function parseCategories(raw) {
  if (Array.isArray(raw)) raw = raw.join(',');
  const list = String(raw || '').split(/[,，\s]+/).filter(Boolean);
  const valid = [...new Set(list.filter(c => CATEGORIES.includes(c)))];
  return valid.slice(0, CATEGORIES.length);
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  if (h.length !== orig.length) return false;
  return crypto.timingSafeEqual(h, orig);
}

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

function createSession(userId, username) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = readSessions();
  const now = Date.now();
  for (const k of Object.keys(sessions)) if (sessions[k].expiresAt < now) delete sessions[k];
  sessions[token] = { userId, username, expiresAt: now + SESSION_TTL };
  writeJSON(SESSIONS_FILE, sessions);
  return token;
}
function getSession(req) {
  const token = req.headers['x-user-token'];
  if (!token || typeof token !== 'string') return null;
  const sessions = readSessions();
  const s = sessions[token];
  if (!s || s.expiresAt < Date.now()) return null;
  return { ...s, token };
}
function destroySession(token) {
  if (!token) return;
  const sessions = readSessions();
  if (sessions[token]) { delete sessions[token]; writeJSON(SESSIONS_FILE, sessions); }
}

function isIn(arr, id) { return Array.isArray(arr) && arr.includes(id); }

const IMAGE_EXT = ['.jpg','.jpeg','.png','.webp','.gif','.avif','.bmp','.tiff','.tif','.heic','.heif'];
const VIDEO_EXT = ['.mp4','.webm','.mov','.m4v','.mkv','.avi','.ogv','.3gp'];
const ALL_EXT = [...IMAGE_EXT, ...VIDEO_EXT];

const MAX_IMAGES = 9;
const MAX_FILE_SIZE = 300 * 1024 * 1024;
const MAX_TOTAL_SIZE = 500 * 1024 * 1024;
const MAX_STORAGE_SIZE = 30 * 1024 * 1024 * 1024;

const uploadHits = new Map();
const UPLOAD_LIMIT = 10;
const UPLOAD_WINDOW = 60_000;

function uploadRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (uploadHits.get(ip) || []).filter(t => now - t < UPLOAD_WINDOW);
  if (hits.length >= UPLOAD_LIMIT) return res.status(429).json({ error: '上传过于频繁，请稍后再试' });
  hits.push(now);
  uploadHits.set(ip, hits);
  if (uploadHits.size > 2000) {
    for (const [k, v] of uploadHits) if (!v.some(t => now - t < UPLOAD_WINDOW)) uploadHits.delete(k);
  }
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALL_EXT.includes(ext) ? ext : '.bin';
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + safeExt);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_IMAGES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALL_EXT.includes(ext)) return cb(new Error('仅支持图片/视频文件'));
    cb(null, true);
  }
});

const cleanupFiles = files => (files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch {} });

function getUsedStorage() {
  let total = 0;
  try {
    const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(UPLOAD_DIR, e.name);
      try { if (e.isFile()) total += fs.statSync(p).size; } catch {}
    }
  } catch {}
  return total;
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use('/uploads', (req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); }, express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

app.post('/api/auth/register', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const u = username.trim();
  if (!u || !password) return res.status(400).json({ error: '用户名和密码为必填' });
  if (u.length < 2 || u.length > 20) return res.status(400).json({ error: '用户名需 2-20 个字符' });
  if (!/^[\w\u4e00-\u9fa5]+$/.test(u)) return res.status(400).json({ error: '用户名只能包含字母、数字、下划线或中文' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (password.length > 64) return res.status(400).json({ error: '密码不超过 64 位' });
  const users = readUsers();
  if (users.some(x => x.username === u)) return res.status(400).json({ error: '用户名已存在' });
  const { salt, hash } = hashPassword(password);
  const user = { id: crypto.randomBytes(8).toString('hex'), username: u, passwordHash: hash, salt, createdAt: Date.now() };
  users.push(user);
  writeJSON(USERS_FILE, users);
  const token = createSession(user.id, user.username);
  res.json({ ok: true, token, username: user.username, userId: user.id });
});

app.post('/api/auth/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  if (!username.trim() || !password) return res.status(400).json({ error: '用户名和密码为必填' });
  const user = readUsers().find(x => x.username === username.trim());
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) return res.status(400).json({ error: '用户名或密码错误' });
  const token = createSession(user.id, user.username);
  res.json({ ok: true, token, username: user.username, userId: user.id });
});

app.post('/api/auth/logout', (req, res) => { destroySession(req.headers['x-user-token']); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '未登录' });
  res.json({ username: s.username, userId: s.userId });
});

app.post('/api/upload', uploadRateLimit,
  (req, res, next) => { const s = getSession(req); if (!s) return res.status(401).json({ error: '请先登录' }); req.user = s; next(); },
  upload.array('files', MAX_IMAGES),
  async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '未收到文件' });
    const { title = '', author = '', description = '', category = '', tags = '' } = req.body || {};
    if (!title.trim() || !author.trim()) { cleanupFiles(files); return res.status(400).json({ error: '标题和作者为必填' }); }
    const hits = checkSensitive([title, author, description, tags].join('\n'));
    if (hits.length) { cleanupFiles(files); return res.status(400).json({ error: '内容包含违禁词，请修改后再提交', hits }); }
    const cats = parseCategories(category);
    if (!cats.length) { cleanupFiles(files); return res.status(400).json({ error: '请至少选择一个题材分类' }); }
    const types = files.map(f => VIDEO_EXT.includes(path.extname(f.originalname).toLowerCase()) ? 'video' : 'image');
    if (types.includes('video') && files.length > 1) { cleanupFiles(files); return res.status(400).json({ error: '视频作品只能上传 1 个文件' }); }
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    if (totalSize > MAX_TOTAL_SIZE) { cleanupFiles(files); return res.status(400).json({ error: '文件总大小超过 500MB 限制' }); }
    const used = getUsedStorage();
    if (used + totalSize > MAX_STORAGE_SIZE) {
      cleanupFiles(files);
      const usedGB = (used / (1024 * 1024 * 1024)).toFixed(2);
      return res.status(400).json({ error: `存储空间已满（已用 ${usedGB}GB / 30GB），本次上传被拒绝` });
    }
    const type = types.includes('video') ? 'video' : 'image';
    try {
      let exifData = null;
      if (type === 'image') exifData = await extractExif(files[0].path);
      const item = await mutateData(data => {
        const it = {
          id: crypto.randomBytes(8).toString('hex'),
          userId: req.user.userId, username: req.user.username,
          images: files.map(f => '/uploads/' + f.filename),
          originalnames: files.map(f => f.originalname),
          type,
          category: cats,
          tags: parseTags(tags),
          title: title.trim().slice(0, 80), author: author.trim().slice(0, 40),
          description: description.trim().slice(0, 500),
          size: totalSize,
          exif: exifData,
          status: 'pending', rejectReason: '',
          collectUsers: [], likeUsers: [],
          revision: 1,
          history: [{ action: 'submit', at: Date.now(), by: 'user' }],
          createdAt: Date.now()
        };
        data.push(it);
        return it;
      });
      res.json({ ok: true, item });
    } catch { cleanupFiles(files); res.status(500).json({ error: '保存失败' }); }
  }
);

app.get('/api/my/items', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '请先登录' });
  const list = readData().filter(i => i.userId === s.userId).sort((a, b) => b.createdAt - a.createdAt)
    .map(it => ({ ...it, likeCount: (it.likeUsers||[]).length, collectCount: (it.collectUsers||[]).length }));
  res.json({ items: list });
});

app.get('/api/my/collected', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '请先登录' });
  const items = readData().filter(i => i.status === 'approved' && isIn(i.collectUsers, s.userId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(it => ({ ...it, collectCount: (it.collectUsers||[]).length, likeCount: (it.likeUsers||[]).length, collected: true, liked: isIn(it.likeUsers, s.userId) }));
  res.json({ items });
});

app.post('/api/view/:id', (req, res) => {
  const s = getSession(req);
  if (!s) return res.json({ ok: true });
  const data = readData();
  const item = data.find(i => i.id === req.params.id);
  if (!item || item.status !== 'approved') return res.json({ ok: true });
  const views = readViews();
  if (!views[s.userId]) views[s.userId] = [];
  const filtered = views[s.userId].filter(v => v.itemId !== req.params.id);
  filtered.unshift({ itemId: req.params.id, at: Date.now() });
  views[s.userId] = filtered.slice(0, 200);
  writeJSON(VIEWS_FILE, views);
  res.json({ ok: true });
});

app.get('/api/my/history', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '请先登录' });
  const views = readViews();
  const list = views[s.userId] || [];
  const data = readData();
  const items = list.map(v => {
    const it = data.find(i => i.id === v.itemId);
    if (!it || it.status !== 'approved') return null;
    return { ...it, viewedAt: v.at, collectCount: (it.collectUsers||[]).length, likeCount: (it.likeUsers||[]).length, collected: isIn(it.collectUsers, s.userId), liked: isIn(it.likeUsers, s.userId) };
  }).filter(Boolean);
  res.json({ items });
});

app.get('/api/notifications', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '请先登录' });
  const all = readNotifs();
  res.json({ items: all[s.userId] || [] });
});

app.get('/api/notifications/unread-count', (req, res) => {
  const s = getSession(req);
  if (!s) return res.json({ count: 0 });
  const items = readNotifs()[s.userId] || [];
  res.json({ count: items.filter(n => !n.read).length });
});

app.post('/api/notifications/read', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '请先登录' });
  const { ids } = req.body || {};
  const all = readNotifs();
  const items = all[s.userId] || [];
  if (Array.isArray(ids) && ids.length) items.forEach(n => { if (ids.includes(n.id)) n.read = true; });
  else items.forEach(n => n.read = true);
  all[s.userId] = items;
  writeJSON(NOTIF_FILE, all);
  res.json({ ok: true });
});

app.post('/api/collect/:id', async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '请先登录' });
  try {
    const result = await mutateData(data => {
      const item = data.find(i => i.id === req.params.id);
      if (!item || item.status !== 'approved') return null;
      if (!Array.isArray(item.collectUsers)) item.collectUsers = [];
      const idx = item.collectUsers.indexOf(s.userId);
      let collected;
      if (idx >= 0) { item.collectUsers.splice(idx, 1); collected = false; }
      else { item.collectUsers.push(s.userId); collected = true; }
      return { collected, count: item.collectUsers.length };
    });
    if (!result) return res.status(404).json({ error: '作品不存在' });
    res.json({ ok: true, ...result });
  } catch { res.status(500).json({ error: '保存失败' }); }
});

app.post('/api/like/:id', async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '请先登录' });
  try {
    const result = await mutateData(data => {
      const item = data.find(i => i.id === req.params.id);
      if (!item || item.status !== 'approved') return null;
      if (!Array.isArray(item.likeUsers)) item.likeUsers = [];
      const idx = item.likeUsers.indexOf(s.userId);
      let liked;
      if (idx >= 0) { item.likeUsers.splice(idx, 1); liked = false; }
      else { item.likeUsers.push(s.userId); liked = true; }
      return { liked, count: item.likeUsers.length };
    });
    if (!result) return res.status(404).json({ error: '作品不存在' });
    res.json({ ok: true, ...result });
  } catch { res.status(500).json({ error: '保存失败' }); }
});

app.post('/api/my/items/:id/resubmit', async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '请先登录' });
  const { title = '', description = '', tags = '', category = '' } = req.body || {};
  if (!title.trim()) return res.status(400).json({ error: '标题为必填' });
  const hits = checkSensitive([title, description, tags].join('\n'));
  if (hits.length) return res.status(400).json({ error: '内容包含违禁词，请修改后再提交', hits });
  const cats = parseCategories(category);
  if (!cats.length) return res.status(400).json({ error: '请至少选择一个分类' });
  try {
    const result = await mutateData(data => {
      const item = data.find(i => i.id === req.params.id);
      if (!item) return { error: '作品不存在' };
      if (item.userId !== s.userId) return { error: '无权修改' };
      if (item.status !== 'rejected') return { error: '只有被拒绝的作品可以重新提交' };
      item.title = title.trim().slice(0, 80);
      item.description = description.trim().slice(0, 500);
      item.tags = parseTags(tags);
      item.category = cats;
      item.revision = (item.revision || 1) + 1;
      item.status = 'pending';
      item.rejectReason = '';
      item.reviewedAt = null;
      addHistory(item, { action: 'resubmit', by: 'user' });
      return { ok: true, item };
    });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch { res.status(500).json({ error: '保存失败' }); }
});

app.get('/api/tags/hot', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 15, 30);
  const counter = {};
  readData().filter(i => i.status === 'approved').forEach(it => {
    (it.tags || []).forEach(t => { counter[t] = (counter[t] || 0) + 1; });
  });
  const list = Object.entries(counter)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
  res.json({ tags: list });
});

app.get('/api/items', (req, res) => {
  const { type, category, categories, q, page = 1, limit = 12, sort = 'new' } = req.query;
  const session = getSession(req);
  const userId = session ? session.userId : null;
  let list = readData().filter(i => i.status === 'approved');
  if (type === 'image' || type === 'video') list = list.filter(i => i.type === type);
  if (category && category !== 'all') {
    list = list.filter(i => Array.isArray(i.category) && i.category.includes(category));
  }
  if (categories) {
    const cs = String(categories).split(',').map(s => s.trim()).filter(c => CATEGORIES.includes(c));
    if (cs.length) {
      list = list.filter(i => Array.isArray(i.category) && cs.every(c => i.category.includes(c)));
    }
  }
  if (q && q.trim()) {
    const keywords = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter(item => {
      const catLabels = Array.isArray(item.category) ? item.category.map(c => CATEGORY_LABELS[c] || '').join(' ') : '';
      const tagsText = Array.isArray(item.tags) ? item.tags.join(' ') : '';
      const haystack = [item.title || '', item.description || '', item.author || '', catLabels, tagsText].join(' ').toLowerCase();
      return keywords.every(kw => haystack.includes(kw));
    });
  }
  if (sort === 'hot') {
    list.sort((a, b) => {
      const la = (a.likeUsers||[]).length + (a.collectUsers||[]).length;
      const lb = (b.likeUsers||[]).length + (b.collectUsers||[]).length;
      return lb - la || b.createdAt - a.createdAt;
    });
  } else if (sort === 'random') {
    const daySeed = Math.floor(Date.now() / 86400000);
    const h = (s) => { let x = daySeed >>> 0; for (let i = 0; i < s.length; i++) x = ((x * 31) + s.charCodeAt(i)) >>> 0; return x; };
    list.sort((a, b) => h(a.id) - h(b.id));
  } else {
    list.sort((a, b) => b.createdAt - a.createdAt);
  }
  const total = list.length;
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.max(1, Math.min(50, parseInt(limit) || 12));
  const items = list.slice((p - 1) * l, p * l).map(it => ({
    ...it,
    cover: coverOf(it),
    collectCount: (it.collectUsers||[]).length,
    likeCount: (it.likeUsers||[]).length,
    collected: userId ? isIn(it.collectUsers, userId) : false,
    liked: userId ? isIn(it.likeUsers, userId) : false
  }));
  res.json({ total, page: p, limit: l, items, hasMore: p * l < total });
});

app.get('/api/author/:username', (req, res) => {
  const author = decodeURIComponent(String(req.params.username || '').trim());
  if (!author) return res.status(400).json({ error: '缺少作者名' });
  const session = getSession(req);
  const userId = session ? session.userId : null;
  const list = readData()
    .filter(i => i.status === 'approved' && i.author === author)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(it => ({
      ...it,
      cover: coverOf(it),
      collectCount: (it.collectUsers||[]).length,
      likeCount: (it.likeUsers||[]).length,
      collected: userId ? isIn(it.collectUsers, userId) : false,
      liked: userId ? isIn(it.likeUsers, userId) : false
    }));
  res.json({ author, total: list.length, items: list });
});

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !safeEqual(token, ADMIN_TOKEN)) return res.status(401).json({ error: '未授权' });
  next();
}

app.get('/api/admin/items', adminAuth, (req, res) => {
  const { status } = req.query;
  const all = readData();
  let list = status ? all.filter(i => i.status === status) : all;
  list = [...list].sort((a, b) => b.createdAt - a.createdAt)
    .map(it => ({ ...it, cover: coverOf(it), likeCount: (it.likeUsers||[]).length, collectCount: (it.collectUsers||[]).length }));
  res.json({ items: list, counts: {
    pending: all.filter(i => i.status === 'pending').length,
    approved: all.filter(i => i.status === 'approved').length,
    rejected: all.filter(i => i.status === 'rejected').length
  }});
});

app.post('/api/admin/review', adminAuth, async (req, res) => {
  const { id, action, rejectReason = '' } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: '无效操作' });
  if (action === 'reject' && !rejectReason.trim()) return res.status(400).json({ error: '拒绝时必须填写原因' });
  try {
    const item = await mutateData(data => {
      const target = data.find(i => i.id === id);
      if (!target) return null;
      target.status = action === 'approve' ? 'approved' : 'rejected';
      target.reviewedAt = Date.now();
      target.rejectReason = action === 'reject' ? rejectReason.trim().slice(0, 300) : '';
      addHistory(target, { action, reason: target.rejectReason, by: 'admin' });
      return target;
    });
    if (!item) return res.status(404).json({ error: '未找到作品' });
    pushNotification(item.userId, {
      type: 'review', itemId: item.id, itemTitle: item.title,
      action, reason: item.rejectReason || ''
    });
    res.json({ ok: true, item });
  } catch { res.status(500).json({ error: '保存失败' }); }
});

app.post('/api/admin/batch-review', adminAuth, async (req, res) => {
  const { ids = [], action, rejectReason = '' } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '请选择作品' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: '无效操作' });
  if (action === 'reject' && !rejectReason.trim()) return res.status(400).json({ error: '拒绝时必须填写原因' });
  try {
    const affected = await mutateData(data => {
      const list = [];
      ids.forEach(id => {
        const t = data.find(i => i.id === id);
        if (t) {
          t.status = action === 'approve' ? 'approved' : 'rejected';
          t.reviewedAt = Date.now();
          t.rejectReason = action === 'reject' ? rejectReason.trim().slice(0, 300) : '';
          addHistory(t, { action, reason: t.rejectReason, by: 'admin' });
          list.push({ userId: t.userId, itemId: t.id, itemTitle: t.title, rejectReason: t.rejectReason });
        }
      });
      return list;
    });
    affected.forEach(a => pushNotification(a.userId, {
      type: 'review', itemId: a.itemId, itemTitle: a.itemTitle,
      action, reason: a.rejectReason || ''
    }));
    res.json({ ok: true, count: affected.length });
  } catch { res.status(500).json({ error: '保存失败' }); }
});

app.post('/api/admin/delete', adminAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: '缺少作品 ID' });
  try {
    let removed = null;
    await mutateData(data => {
      const idx = data.findIndex(i => i.id === id);
      if (idx === -1) return null;
      removed = data[idx];
      data.splice(idx, 1);
      return removed;
    });
    if (!removed) return res.status(404).json({ error: '未找到作品' });
    (removed.images || []).forEach(img => {
      const file = path.join(UPLOAD_DIR, path.basename(img));
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    });
    try {
      const vf = path.join(ROOT, 'view_history.json');
      if (fs.existsSync(vf)) {
        const vh = JSON.parse(fs.readFileSync(vf, 'utf8'));
        for (const uid of Object.keys(vh)) {
          const before = vh[uid].length;
          vh[uid] = vh[uid].filter(h => h.itemId !== id);
          if (vh[uid].length !== before) fs.writeFileSync(vf, JSON.stringify(vh));
        }
      }
    } catch {}
    res.json({ ok: true, deleted: id });
  } catch { res.status(500).json({ error: '删除失败' }); }
});

app.get('/api/admin/export.csv', adminAuth, (req, res) => {
  const all = readData().sort((a, b) => b.createdAt - a.createdAt);
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const statusLabel = { pending: '待审核', approved: '已通过', rejected: '已拒绝' };
  const header = ['ID','标题','作者','上传者','类型','文件数','分类','话题','文案','状态','拒绝原因','版本','上传时间','审核时间','收藏数','点赞数'].map(esc).join(',');
  const rows = all.map(it => {
    const cats = (Array.isArray(it.category) ? it.category : []).map(c => CATEGORY_LABELS[c] || '其他').join(' / ');
    const fileCount = Array.isArray(it.images) ? it.images.length : (it.url ? 1 : 0);
    return [
      it.id, it.title, it.author, it.username || '',
      it.type === 'video' ? '视频' : '图片',
      fileCount,
      cats,
      Array.isArray(it.tags) ? it.tags.join(' ') : '',
      it.description || '', statusLabel[it.status] || it.status, it.rejectReason || '',
      it.revision || 1,
      new Date(it.createdAt).toLocaleString('zh-CN'),
      it.reviewedAt ? new Date(it.reviewedAt).toLocaleString('zh-CN') : '',
      (it.collectUsers||[]).length, (it.likeUsers||[]).length
    ].map(esc).join(',');
  });
  const csv = '\uFEFF' + [header, ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gallery-export-${Date.now()}.csv"`);
  res.send(csv);
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const failed = req.files
      ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat())
      : [];
    cleanupFiles(failed);
    const map = {
      LIMIT_FILE_SIZE: '单个文件超过 300MB 限制',
      LIMIT_FILE_COUNT: '一次最多上传 9 个文件',
      LIMIT_UNEXPECTED_FILE: '文件数量或字段名不正确'
    };
    return res.status(400).json({ error: map[err.code] || err.message });
  }
  if (err && err.message && /仅支持|文件格式/.test(err.message)) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: '服务器错误' });
});

try {
  const migrated = migrateData();
  if (migrated) console.log('📦 数据已自动迁移');
} catch (e) {
  console.error('❌ 数据迁移失败：', e);
}

app.listen(PORT, () => {
  console.log(`\n✅ 光影集已启动: http://localhost:${PORT}`);
  console.log(`   管理后台:    http://localhost:${PORT}/admin`);
  if (ADMIN_TOKEN === 'admin123') console.log('   ⚠️  当前使用默认密码 admin123\n');
});
