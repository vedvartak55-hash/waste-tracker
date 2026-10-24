'use strict';
// Website + database + SMS in one Node.js app.
// Needs Node.js 18+. The only npm package is `mongodb`, and only when MONGODB_URI is set.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader (real environment variables win over the file).
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  });
} catch (e) { /* no .env file, use real environment variables */ }

const WARDS = ['Virar East', 'Virar West', 'Nalasopara East', 'Nalasopara West', 'Vasai Road', 'Naigaon', 'Agashi', 'Arnala'];
const CATS = ['Uncollected garbage', 'Overflowing community bin', 'Illegal dumping', 'Blocked drain or sanitation', 'Burning of waste', 'Dead animal removal'];
const STATUSES = ['Pending', 'Assigned', 'In progress', 'Resolved'];
const CREWS = [
  { name: 'Crew A', wards: ['Virar East', 'Virar West'] },
  { name: 'Crew B', wards: ['Nalasopara East', 'Nalasopara West'] },
  { name: 'Crew C', wards: ['Vasai Road', 'Naigaon'] },
  { name: 'Crew D', wards: ['Agashi', 'Arnala'] }
];
const CREW_NAMES = CREWS.map((c) => c.name);
const crewForWard = (w) => (CREWS.find((c) => c.wards.includes(w)) || CREWS[0]).name;

const PROVIDER = (process.env.SMS_PROVIDER || 'dryrun').toLowerCase();
const SITE_URL = (process.env.SITE_URL || '').trim();
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '*').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TWILIO_BASE = process.env.TWILIO_API_BASE || 'https://api.twilio.com';
const FAST2SMS_URL = process.env.FAST2SMS_URL || 'https://www.fast2sms.com/dev/bulkV2';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/* ------------------------------------------------------------------ */
/* Database                                                           */
/* ------------------------------------------------------------------ */
const clone = (o) => JSON.parse(JSON.stringify(o));

// Local development store: one JSON file. Data is lost if the host wipes its disk.
class FileStore {
  constructor(file) { this.file = file; this.docs = []; this.kind = 'file'; }
  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try { this.docs = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { this.docs = []; }
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.docs));
    fs.renameSync(tmp, this.file);
  }
  async count() { return this.docs.length; }
  async insert(doc) {
    const max = this.docs.reduce((a, d) => Math.max(a, parseInt(d.id.slice(3), 10) || 0), 1000);
    doc.id = 'WM-' + (max + 1);
    this.docs.push(clone(doc));
    this._save();
    return clone(doc);
  }
  async insertMany(docs) {
    let n = this.docs.reduce((a, d) => Math.max(a, parseInt(d.id.slice(3), 10) || 0), 1000);
    docs.forEach((d) => { d.id = 'WM-' + (++n); this.docs.push(clone(d)); });
    this._save();
  }
  async get(id) { const d = this.docs.find((x) => x.id === id); return d ? clone(d) : null; }
  async list() { return clone(this.docs).sort((a, b) => (a.created < b.created ? 1 : -1)); }
  // fn(doc) returns { set: {...}, push: [history entries] }
  async update(id, fn) {
    const d = this.docs.find((x) => x.id === id);
    if (!d) return null;
    const { set = {}, push = [] } = fn(clone(d));
    Object.assign(d, set);
    d.history.push(...push);
    this._save();
    return clone(d);
  }
}

// Production store: MongoDB (for example a free MongoDB Atlas cluster).
class MongoStore {
  constructor(uri) { this.uri = uri; this.kind = 'mongodb'; }
  async init() {
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(this.uri);
    await this.client.connect();
    const db = this.client.db(process.env.MONGODB_DB || 'wastetracker');
    this.col = db.collection('complaints');
    this.counters = db.collection('counters');
    await this.col.createIndex({ id: 1 }, { unique: true });
    await this.col.createIndex({ created: -1 });
  }
  async count() { return this.col.countDocuments({}); }
  async insert(doc) {
    const r = await this.counters.findOneAndUpdate({ _id: 'complaint' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const c = r && r.value !== undefined ? r.value : r; // driver 5 returns {value}, driver 6 returns the document
    doc.id = 'WM-' + (1000 + c.seq);
    await this.col.insertOne(clone(doc));
    return clone(doc);
  }
  async insertMany(docs) {
    for (const d of docs) { await this.insert(d); }
  }
  async get(id) { return this.col.findOne({ id }, { projection: { _id: 0 } }); }
  async list() { return this.col.find({}, { projection: { _id: 0 } }).sort({ created: -1 }).limit(5000).toArray(); }
  async update(id, fn) {
    const d = await this.get(id);
    if (!d) return null;
    const { set = {}, push = [] } = fn(d);
    const op = {};
    if (Object.keys(set).length) op.$set = set;
    if (push.length) op.$push = { history: { $each: push } };
    if (Object.keys(op).length) await this.col.updateOne({ id }, op);
    return this.get(id);
  }
}

/* ------------------------------------------------------------------ */
/* Sample data (only when SEED_SAMPLE=true and the database is empty) */
/* ------------------------------------------------------------------ */
function sampleDocs() {
  const HR = 36e5, now = Date.now();
  const rows = [
    ['Virar East', 'Uncollected garbage', 'Near Viva College gate', 'Garbage not lifted for four days, stray dogs spreading it on the road.', 'Pending', 150],
    ['Virar East', 'Overflowing community bin', 'Bolinj market lane', 'Community bin overflowing since the weekend, bad smell near shops.', 'In progress', 120],
    ['Virar East', 'Illegal dumping', 'Behind D-Mart plot', 'Construction debris dumped on the empty plot overnight.', 'Assigned', 96],
    ['Virar East', 'Uncollected garbage', 'Global City, Sector 2', 'Wet and dry waste bins not emptied this week.', 'Resolved', 140],
    ['Virar West', 'Burning of waste', 'Marathi Nagar road', 'Waste burned in the open every evening, smoke enters homes.', 'Pending', 80],
    ['Virar West', 'Uncollected garbage', 'Jivdani Road, near bus stop', 'Pile of garbage at the bus stop corner.', 'Resolved', 110],
    ['Nalasopara East', 'Blocked drain or sanitation', 'Tulinj Road, near the school', 'Drain choked with plastic, water stagnating after rain.', 'In progress', 100],
    ['Nalasopara East', 'Overflowing community bin', 'Station Road lane 3', 'Bin overflowing, waste spilling onto the footpath.', 'Pending', 55],
    ['Nalasopara East', 'Dead animal removal', 'Pelhar Phata', 'Dead dog on the roadside since morning.', 'Resolved', 48],
    ['Nalasopara West', 'Uncollected garbage', 'Evershine Nagar', 'Collection vehicle skipped our lane for three days.', 'Assigned', 70],
    ['Nalasopara West', 'Illegal dumping', 'Near the creek bridge', 'Mixed waste being dumped near the creek every night.', 'Pending', 130],
    ['Nalasopara West', 'Blocked drain or sanitation', 'Achole Road', 'Sewage overflow on the road near the temple.', 'Resolved', 125],
    ['Vasai Road', 'Uncollected garbage', 'Vasai Road station east', 'Garbage pile near the foot overbridge stairs.', 'In progress', 40],
    ['Vasai Road', 'Overflowing community bin', 'Papdy village square', 'Bins have not been replaced after being damaged.', 'Pending', 28],
    ['Naigaon', 'Uncollected garbage', 'Naigaon East, Juchandra', 'Door-to-door collection missed for two days.', 'Assigned', 30],
    ['Naigaon', 'Burning of waste', 'Near the railway fence', 'Plastic waste burning along the railway boundary.', 'Resolved', 90],
    ['Agashi', 'Illegal dumping', 'Agashi Road bend', 'Dumped furniture and thermocol blocking the road edge.', 'Pending', 20],
    ['Agashi', 'Uncollected garbage', 'Near Agashi lake', 'Waste piled up beside the lake path.', 'Resolved', 60],
    ['Arnala', 'Overflowing community bin', 'Arnala beach entrance', 'Bins full after the weekend crowd, waste blowing onto the beach.', 'In progress', 16],
    ['Arnala', 'Dead animal removal', 'Arnala village road', 'Dead cattle near the bus stand, needs removal.', 'Pending', 6],
    ['Virar East', 'Blocked drain or sanitation', 'Agarwal Nagri', 'Drain cover broken and waste stuck inside.', 'Assigned', 12],
    ['Nalasopara East', 'Uncollected garbage', 'Sopara Phata', 'Waste left uncollected near the vegetable market.', 'Resolved', 34]
  ];
  const names = ['Anita Patil', 'Rahul Mhatre', 'Sana Shaikh', 'Vikas Gawde', 'Pooja Naik', 'Imran Khan', 'Meera Joshi'];
  return rows.map((r, i) => {
    const created = now - r[5] * HR, age = r[5], idx = STATUSES.indexOf(r[4]);
    const history = [{ status: 'Pending', at: new Date(created).toISOString(), note: 'Complaint received' }];
    let crew = null;
    if (idx >= 1) { crew = crewForWard(r[0]); history.push({ status: 'Assigned', at: new Date(created + age * 0.12 * HR).toISOString(), note: 'Assigned to ' + crew }); }
    if (idx >= 2) history.push({ status: 'In progress', at: new Date(created + age * 0.22 * HR).toISOString(), note: 'Crew started work' });
    if (idx >= 3) history.push({ status: 'Resolved', at: new Date(created + age * 0.38 * HR).toISOString(), note: 'Marked resolved by authority' });
    return { name: names[i % names.length], phone: '', ward: r[0], category: r[1], location: r[2], desc: r[3], photo: '', status: r[4], crew, created: new Date(created).toISOString(), history, sms: 'none', sample: true };
  }).sort((a, b) => (a.created < b.created ? -1 : 1)); // oldest first so the newest gets the highest number
}

/* ------------------------------------------------------------------ */
/* SMS                                                                */
/* ------------------------------------------------------------------ */
function clip(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}
function buildMessage(c, siteUrl = SITE_URL) {
  return 'Complaint registered successfully. ID: ' + c.id + '. Type: ' + c.category + '. Ward: ' + c.ward +
    '. Location: ' + clip(c.location, 40) + '. Status: Pending.' +
    (siteUrl ? ' Track at ' + siteUrl + '.' : ' Track it with this ID on the Waste Management Tracking System.') +
    ' -Waste Mgmt Tracking System';
}

async function sendTwilio(phone, text) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) throw new Error('Twilio settings are missing');
  const res = await fetch(TWILIO_BASE + '/2010-04-01/Accounts/' + sid + '/Messages.json', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: '+91' + phone, From: from, Body: text })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Twilio: ' + (data.message || res.status));
  return data.sid;
}
async function sendFast2sms(phone, text) {
  const key = process.env.FAST2SMS_API_KEY;
  if (!key) throw new Error('FAST2SMS_API_KEY is missing');
  const res = await fetch(FAST2SMS_URL, {
    method: 'POST',
    headers: { authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ route: 'q', message: text, language: 'english', flash: 0, numbers: phone })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.return !== true) throw new Error('Fast2SMS: ' + (Array.isArray(data.message) ? data.message.join(' ') : data.message || res.status));
  return data.request_id;
}
async function deliver(phone, text) {
  if (PROVIDER === 'twilio') return sendTwilio(phone, text);
  if (PROVIDER === 'fast2sms') return sendFast2sms(phone, text);
  console.log('[dryrun] SMS to +91' + phone + ':\n  ' + text);
  return 'dryrun';
}
// Returns 'sent' | 'dryrun' | 'failed' | 'limited'
async function sendConfirmationSms(doc, ip) {
  if (!doc.phone) return 'failed';
  if (!allow('phone:' + doc.phone, 3, 3600e3) || !allow('smsip:' + ip, 15, 3600e3)) return 'limited';
  try {
    await deliver(doc.phone, buildMessage(doc));
    return PROVIDER === 'dryrun' ? 'dryrun' : 'sent';
  } catch (err) {
    console.error('SMS failed for ' + doc.id + ':', err.message);
    return 'failed';
  }
}

/* ------------------------------------------------------------------ */
/* Helpers: rate limit, auth, http                                    */
/* ------------------------------------------------------------------ */
const hits = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) { if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }
}, 600e3).unref();

const SECRET = crypto.createHash('sha256').update('wmts-token:' + (process.env.ADMIN_TOKEN_SECRET || ADMIN_PASSWORD)).digest();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function sign(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
}
function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const [p, sig] = token.split('.');
  if (!p || !sig) return false;
  const want = Buffer.from(crypto.createHmac('sha256', SECRET).update(p).digest('base64url'));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')).exp > Date.now(); } catch (e) { return false; }
}
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') && verifyToken(h.slice(7));
}

function reply(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
    Vary: 'Origin'
  });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 16384) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function clientIp(req) {
  // The last entry is the address the hosting proxy saw. Earlier entries can be faked by the visitor.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}
const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// What the public may see. Never the citizen's name or phone number.
function publicView(d, detail) {
  const o = { id: d.id, ward: d.ward, category: d.category, location: d.location, status: d.status, crew: d.crew || null, created: d.created, history: d.history };
  if (detail) o.desc = d.desc;
  return o;
}
function adminView(d) {
  return { id: d.id, name: d.name, phone: d.phone, ward: d.ward, category: d.category, location: d.location, desc: d.desc, photo: d.photo || '', status: d.status, crew: d.crew || null, created: d.created, history: d.history, sms: d.sms || 'none' };
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */
let store;

async function createComplaint(req, res) {
  let b;
  try { b = await readJson(req); } catch (e) { return reply(res, 400, { ok: false, error: 'Send valid JSON.' }); }
  b = b && typeof b === 'object' ? b : {};
  const d = {
    name: text(b.name, 80), phone: String(b.phone || '').replace(/\s/g, ''), ward: String(b.ward || ''),
    category: String(b.category || ''), location: text(b.location, 120), desc: text(b.desc, 1000), photo: text(b.photo, 100)
  };
  const errors = [];
  if (!d.name) errors.push('Enter your name.');
  if (!/^[6-9]\d{9}$/.test(d.phone)) errors.push('Enter a 10-digit Indian mobile number.');
  if (!WARDS.includes(d.ward)) errors.push('Choose a ward.');
  if (!CATS.includes(d.category)) errors.push('Choose the type of problem.');
  if (!d.location) errors.push('Enter the street or a landmark.');
  if (d.desc.length < 10) errors.push('Describe the problem in at least 10 characters.');
  if (errors.length) return reply(res, 400, { ok: false, errors });

  const ip = clientIp(req);
  if (!allow('new:' + ip, 20, 3600e3)) return reply(res, 429, { ok: false, error: 'Too many complaints from this connection. Try again later.' });

  const now = new Date().toISOString();
  let doc = await store.insert({ ...d, status: 'Pending', crew: null, created: now, history: [{ status: 'Pending', at: now, note: 'Complaint received' }], sms: 'pending' });
  const sms = await sendConfirmationSms(doc, ip);
  doc = (await store.update(doc.id, () => ({ set: { sms } }))) || doc;
  reply(res, 201, { ok: true, complaint: publicView(doc, true), sms: { status: sms, message: buildMessage(doc) } });
}

async function resendSms(req, res, id) {
  const doc = await store.get(id);
  if (!doc || !doc.phone) return reply(res, 404, { ok: false, error: 'Complaint not found.' });
  const ip = clientIp(req);
  if (!allow('resend:' + id, 3, 3600e3)) return reply(res, 429, { ok: false, error: 'Too many attempts. Try again later.' });
  const sms = await sendConfirmationSms(doc, ip);
  await store.update(id, () => ({ set: { sms } }));
  reply(res, 200, { ok: true, sms: { status: sms, message: buildMessage(doc) } });
}

async function adminLogin(req, res) {
  if (!ADMIN_PASSWORD) return reply(res, 503, { ok: false, error: 'Admin login is not set up. The person running the server must set ADMIN_PASSWORD.' });
  if (!allow('login:' + clientIp(req), 10, 3600e3)) return reply(res, 429, { ok: false, error: 'Too many sign-in attempts. Try again in an hour.' });
  let b;
  try { b = await readJson(req); } catch (e) { return reply(res, 400, { ok: false, error: 'Send valid JSON.' }); }
  if (!b || !crypto.timingSafeEqual(sha(b.password || ''), sha(ADMIN_PASSWORD))) return reply(res, 401, { ok: false, error: 'Wrong password.' });
  reply(res, 200, { ok: true, token: sign({ exp: Date.now() + 8 * 3600e3 }) });
}

function applyAdminChange(c, crew, status) {
  const now = new Date().toISOString(), set = {}, push = [];
  let curStatus = c.status, curCrew = c.crew || null;
  if (crew !== undefined) {
    curCrew = crew || null;
    set.crew = curCrew;
    if (crew) {
      if (curStatus === 'Pending') { curStatus = 'Assigned'; set.status = curStatus; push.push({ status: 'Assigned', at: now, note: 'Assigned to ' + crew }); }
      else push.push({ status: curStatus, at: now, note: 'Reassigned to ' + crew });
    }
  }
  if (status !== undefined && status !== curStatus) {
    if (status !== 'Pending' && !curCrew) {
      curCrew = crewForWard(c.ward); set.crew = curCrew;
      push.push({ status: curStatus === 'Pending' ? 'Assigned' : curStatus, at: now, note: 'Assigned to ' + curCrew });
    }
    set.status = status;
    push.push({ status, at: now, note: status === 'Resolved' ? 'Marked resolved by authority' : status === 'In progress' ? 'Crew started work' : status === 'Assigned' ? 'Status set to assigned' : 'Status set back to pending' });
  }
  return { set, push };
}

async function adminUpdate(req, res, id) {
  let b;
  try { b = await readJson(req); } catch (e) { return reply(res, 400, { ok: false, error: 'Send valid JSON.' }); }
  b = b && typeof b === 'object' ? b : {};
  if (b.crew !== undefined && b.crew !== '' && !CREW_NAMES.includes(b.crew)) return reply(res, 400, { ok: false, error: 'Unknown crew.' });
  if (b.status !== undefined && !STATUSES.includes(b.status)) return reply(res, 400, { ok: false, error: 'Unknown status.' });
  const updated = await store.update(id, (c) => applyAdminChange(c, b.crew, b.status));
  if (!updated) return reply(res, 404, { ok: false, error: 'Complaint not found.' });
  reply(res, 200, { ok: true, complaint: adminView(updated) });
}

function serveStatic(res, url) {
  let rel;
  try { rel = decodeURIComponent(url); } catch (e) { return reply(res, 400, { ok: false, error: 'Bad URL' }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return reply(res, 403, { ok: false, error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return reply(res, 404, { ok: false, error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function route(req, res) {
  const url = req.url.split('?')[0];
  const m = req.method;
  if (m === 'OPTIONS') return reply(res, 204, {});
  if (m === 'GET' && url === '/health') return reply(res, 200, { ok: true, database: store.kind, sms: PROVIDER, adminLogin: !!ADMIN_PASSWORD });

  if (m === 'POST' && url === '/api/complaints') return createComplaint(req, res);
  if (m === 'GET' && url === '/api/public/complaints') {
    return reply(res, 200, { ok: true, complaints: (await store.list()).map((d) => publicView(d, false)) });
  }
  let r;
  if (m === 'GET' && (r = url.match(/^\/api\/complaints\/(WM-\d{1,8})$/))) {
    const d = await store.get(r[1]);
    return d ? reply(res, 200, { ok: true, complaint: publicView(d, true) }) : reply(res, 404, { ok: false, error: 'Complaint not found.' });
  }
  if (m === 'POST' && (r = url.match(/^\/api\/complaints\/(WM-\d{1,8})\/resend-sms$/))) return resendSms(req, res, r[1]);

  if (m === 'POST' && url === '/api/admin/login') return adminLogin(req, res);
  if (url.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return reply(res, 401, { ok: false, error: 'Sign in again.' });
    if (m === 'GET' && url === '/api/admin/complaints') return reply(res, 200, { ok: true, complaints: (await store.list()).map(adminView) });
    if (m === 'PATCH' && (r = url.match(/^\/api\/admin\/complaints\/(WM-\d{1,8})$/))) return adminUpdate(req, res, r[1]);
  }
  if (url.startsWith('/api/')) return reply(res, 404, { ok: false, error: 'Not found' });
  if (m === 'GET' || m === 'HEAD') return serveStatic(res, url);
  reply(res, 404, { ok: false, error: 'Not found' });
}

async function main() {
  store = process.env.MONGODB_URI
    ? new MongoStore(process.env.MONGODB_URI)
    : new FileStore(process.env.DATA_FILE || path.join(__dirname, 'data', 'complaints.json'));
  await store.init();
  if (process.env.SEED_SAMPLE === 'true' && (await store.count()) === 0) {
    await store.insertMany(sampleDocs());
    console.log('Added sample complaints (SEED_SAMPLE=true).');
  }
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => { console.error(err); if (!res.headersSent) reply(res, 500, { ok: false, error: 'Server error' }); });
  });
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log('Website + database + SMS on port ' + port);
    console.log('  database : ' + (store.kind === 'mongodb' ? 'MongoDB' : 'local file (data is lost if the host resets its disk; set MONGODB_URI for permanent storage)'));
    console.log('  sms      : ' + (PROVIDER === 'dryrun' ? 'NOT CONFIGURED, no real SMS will be sent (set SMS_PROVIDER)' : PROVIDER));
    console.log('  dashboard: ' + (ADMIN_PASSWORD ? 'password login on' : 'LOCKED, set ADMIN_PASSWORD to enable the authority login'));
  });
}
main().catch((err) => { console.error('Could not start:', err.message); process.exit(1); });
