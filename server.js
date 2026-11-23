'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, tx } = require('./lib/db');
const preview = require('./lib/preview');
const fs = require('node:fs');
const { DATA_DIR } = require('./lib/db');
const COVER_DIR = path.join(DATA_DIR, 'covers');
fs.mkdirSync(COVER_DIR, { recursive: true });
// Bildtyp anhand der ersten Bytes prüfen – dem Content-Type des Browsers wird nicht vertraut
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}
function removeCoverFile(file) {
  if (file && /^[0-9a-f]{32}$/.test(file)) fs.rm(path.join(COVER_DIR, file), { force: true }, () => {});
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const COOKIE = 'dw_session';
const VERSION = require('./package.json').version;
// Einmal-Code für die Ersteinrichtung (wird vom Installer gesetzt). Ohne Code: Setup offen (nur für lokale Entwicklung).
const SETUP_TOKEN = process.env.SETUP_TOKEN || '';
// Welchen Proxys wir X-Forwarded-For/-Proto glauben. Standard: lokale/private Netze (z. B. Nginx Proxy Manager im LAN).
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal';

const COLUMNS = [
  { key: 'backlog', title: 'Zurückgestellt' },
  { key: 'wishes', title: 'Wünsche' },
  { key: 'progress', title: 'In Bearbeitung' },
  { key: 'done', title: 'Fertig' },
];
const COLUMN_KEYS = new Set(COLUMNS.map((c) => c.key));
const USER_COLORS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#22c55e', '#ef4444', '#8b5cf6', '#0ea5e9'];

// ---------- Helpers ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
const DUMMY_HASH = hashPin(crypto.randomBytes(8).toString('hex'));
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
const PIN_HINT = 'PIN/Passwort muss mindestens 6 Zeichen haben.';
function validPin(pin) {
  return typeof pin === 'string' && pin.length >= 6 && pin.length <= 64;
}
function validColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
}
function normalizeUrl(u) {
  const s = str(u, 2000);
  if (!s) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
function validDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}
const fail = (status, msg) => {
  throw new HttpError(status, msg);
};

// ---------- Live-Updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(type = 'changed') {
  for (const res of clients) res.write(`event: ${type}\ndata: {}\n\n`);
}
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000).unref();

// ---------- Brute-Force-Schutz fürs Login ----------
// Zwei Zähler: pro IP (gegen Durchprobieren vieler Namen) und pro Benutzer
// (gegen verteilte Angriffe von vielen IPs auf eine Person).
const LOCK_MS = 15 * 60 * 1000;
const ipFails = new Map();
const userFails = new Map();
function isLocked(map, key, max) {
  const a = map.get(key);
  if (!a) return false;
  if (Date.now() - a.t > LOCK_MS) {
    map.delete(key);
    return false;
  }
  return a.n >= max;
}
function addFail(map, key) {
  const a = map.get(key);
  if (!a || Date.now() - a.t > LOCK_MS) map.set(key, { n: 1, t: Date.now() });
  else a.n++;
}
setInterval(() => {
  const now = Date.now();
  for (const m of [ipFails, userFails]) for (const [k, a] of m) if (now - a.t > LOCK_MS) m.delete(k);
}, LOCK_MS).unref();

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY.split(',').map((x) => x.trim()));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
  );
  next();
});
// CSRF-Schutz: Schreibende API-Aufrufe nur als JSON (erzwingt bei fremden Seiten einen CORS-Preflight, den wir nie erlauben)
app.use('/api', (req, res, next) => {
  // Bilder (image/*) lösen bei fremden Seiten ebenfalls einen Preflight aus und sind daher genauso sicher
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json') && !req.is('image/*'))
    return res.status(415).json({ error: 'Nur JSON erlaubt.' });
  next();
});
app.use(express.json({ limit: '200kb' }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/vendor/Sortable.min.js', (req, res) =>
  res.sendFile(require.resolve('sortablejs/Sortable.min.js'))
);

// Session laden
app.use('/api', (req, res, next) => {
  const token = parseCookies(req)[COOKIE];
  req.user = null;
  if (token) {
    req.user =
      db
        .prepare(
          `SELECT u.id, u.name, u.is_admin AS isAdmin, u.color FROM sessions s
           JOIN users u ON u.id = s.user_id WHERE s.token = ?`
        )
        .get(token) || null;
    if (req.user) req.user.isAdmin = !!req.user.isAdmin;
  }
  next();
});

const wrap = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res);
    if (r !== undefined) res.json(r);
  } catch (e) {
    next(e);
  }
};
const auth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Bitte anmelden.')));
const admin = (req, res, next) =>
  req.user?.isAdmin ? next() : next(new HttpError(403, 'Nur für Admins.'));

function cookieFlags(req) {
  return `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;
}
function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  // alte Sitzungen nach 180 Tagen aufräumen
  db.prepare(`DELETE FROM sessions WHERE created_at < datetime('now', '-180 days')`).run();
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieFlags(req)}; Max-Age=${60 * 60 * 24 * 180}`);
}

// --- Status / Setup / Login ---
app.get(
  '/api/state',
  wrap((req) => {
    const setupRequired = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    // Versionsnummer und Namen nur für angemeldete Personen – nichts über die Familie nach außen geben
    return {
      setupRequired,
      setupTokenRequired: setupRequired && !!SETUP_TOKEN,
      user: req.user,
      version: req.user ? VERSION : undefined,
    };
  })
);

app.post(
  '/api/setup',
  wrap((req, res) => {
    const name = str(req.body.name, 40);
    const pin = req.body.pin;
    if (!name) fail(400, 'Name fehlt.');
    if (!validPin(pin)) fail(400, PIN_HINT);
    if (SETUP_TOKEN) {
      const given = Buffer.from(String(req.body.setupToken || ''));
      const want = Buffer.from(SETUP_TOKEN);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        addFail(ipFails, req.ip);
        fail(403, 'Einrichtungs-Code falsch. Er wurde bei der Installation angezeigt.');
      }
    }
    const id = tx(() => {
      if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) fail(409, 'Setup bereits erledigt.');
      return db
        .prepare('INSERT INTO users (name, pin_hash, is_admin, color) VALUES (?, ?, 1, ?)')
        .run(name, hashPin(pin), USER_COLORS[0]).lastInsertRowid;
    });
    createSession(req, res, id);
    return { ok: true };
  })
);

app.post(
  '/api/login',
  wrap((req, res) => {
    const name = str(req.body.name, 40);
    const userKey = name.toLowerCase();
    if (isLocked(ipFails, req.ip, 20) || isLocked(userFails, userKey, 5))
      fail(429, 'Zu viele Fehlversuche. Bitte 15 Minuten warten.');
    const u = db.prepare('SELECT id, pin_hash FROM users WHERE name = ?').get(name);
    // Bei unbekanntem Namen trotzdem rechnen, damit die Antwortzeit nichts verrät
    const ok = verifyPin(typeof req.body.pin === 'string' ? req.body.pin : '', u ? u.pin_hash : DUMMY_HASH);
    if (!u || !ok) {
      addFail(ipFails, req.ip);
      addFail(userFails, userKey);
      fail(401, 'Name oder PIN falsch.');
    }
    userFails.delete(userKey);
    createSession(req, res, u.id);
    return { ok: true };
  })
);

app.post(
  '/api/logout',
  wrap((req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags(req)}; Max-Age=0`);
    return { ok: true };
  })
);

app.post(
  '/api/me/pin',
  auth,
  wrap((req) => {
    const u = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPin(String(req.body.oldPin || ''), u.pin_hash)) fail(400, 'Alte PIN falsch.');
    if (!validPin(req.body.newPin)) fail(400, PIN_HINT);
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(req.body.newPin), req.user.id);
    return { ok: true };
  })
);

// --- Live-Events ---
app.get('/api/events', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// --- Board ---
// Private Karten: lesen dürfen Admins, Ersteller*in und die zuständige Person
function canSee(user, row) {
  return !row.is_private || user.isAdmin || row.created_by === user.id || row.assigned_to === user.id;
}
function redact(c) {
  return {
    id: c.id,
    columnKey: c.columnKey,
    position: c.position,
    isPrivate: true,
    redacted: true,
    title: 'Privat',
    description: '',
    tags: [],
    links: [],
    commentCount: 0,
  };
}
function loadCards(user, where = '', params = []) {
  const cards = db
    .prepare(
      `SELECT c.id, c.title, c.description, c.column_key AS columnKey, c.position, c.due_date AS dueDate,
              c.is_private AS isPrivate, c.cover_file AS coverFile,
              c.created_at AS createdAt, c.updated_at AS updatedAt, c.moved_at AS movedAt,
              c.created_by AS createdBy, u.name AS creatorName, u.color AS creatorColor,
              c.assigned_to AS assignedTo, a.name AS assigneeName, a.color AS assigneeColor,
              (SELECT COUNT(*) FROM comments m WHERE m.card_id = c.id) AS commentCount
       FROM cards c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN users a ON a.id = c.assigned_to ${where}
       ORDER BY c.position, c.id`
    )
    .all(...params);
  if (!cards.length) return cards;
  const byId = new Map(cards.map((c) => [c.id, Object.assign(c, { tags: [], links: [], isPrivate: !!c.isPrivate })]));
  for (const t of db.prepare('SELECT card_id, tag_id FROM card_tags').all())
    byId.get(t.card_id)?.tags.push(t.tag_id);
  const links = db
    .prepare(
      `SELECT l.id, l.card_id, l.url, p.status, p.title, p.image_hash AS imageHash
       FROM links l LEFT JOIN previews p ON p.url = l.url ORDER BY l.position, l.id`
    )
    .all();
  for (const l of links)
    byId.get(l.card_id)?.links.push({
      id: l.id,
      url: l.url,
      title: l.title || null,
      image: l.imageHash ? `/api/previews/${l.imageHash}` : null,
      pending: l.status === 'pending',
    });
  return cards.map((c) => {
    if (!canSee(user, { is_private: c.isPrivate, created_by: c.createdBy, assigned_to: c.assignedTo })) return redact(c);
    // Titelbild: erstes Vorschaubild der Links
    // eigenes Titelbild hat Vorrang vor der Link-Vorschau
    c.ownCover = c.coverFile ? `/api/covers/${c.id}?v=${c.coverFile.slice(0, 8)}` : null;
    c.cover = c.ownCover || c.links.find((l) => l.image)?.image || null;
    delete c.coverFile;
    return c;
  });
}

app.get(
  '/api/board',
  auth,
  wrap((req) => ({
    columns: COLUMNS,
    cards: loadCards(req.user),
    tags: db.prepare('SELECT id, name, color FROM tags ORDER BY name').all(),
    users: db.prepare('SELECT id, name, color, is_admin AS isAdmin FROM users ORDER BY name').all(),
  }))
);

function getCard(id, user) {
  const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(id));
  // Private Karten verhalten sich für Unbefugte so, als gäbe es sie nicht
  if (!c || (user && !canSee(user, c))) fail(404, 'Karte nicht gefunden.');
  return c;
}
function validAssignee(v) {
  if (v === null || v === undefined || v === '' || v === 0) return null;
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(v));
  if (!u) fail(400, 'Unbekannte Person.');
  return u.id;
}
function canEdit(user, card) {
  return user.isAdmin || card.created_by === user.id;
}
function setLinks(cardId, links) {
  if (!Array.isArray(links)) return;
  db.prepare('DELETE FROM links WHERE card_id = ?').run(cardId);
  const ins = db.prepare('INSERT INTO links (card_id, url, position) VALUES (?, ?, ?)');
  links
    .slice(0, 20)
    .map(normalizeUrl)
    .filter(Boolean)
    .forEach((u, i) => ins.run(cardId, u, i));
  setImmediate(() => preview.schedule(db.prepare('SELECT url FROM links WHERE card_id = ?').all(cardId).map((r) => r.url)));
}
function setTags(cardId, tags) {
  if (!Array.isArray(tags)) return;
  db.prepare('DELETE FROM card_tags WHERE card_id = ?').run(cardId);
  const ins = db.prepare('INSERT OR IGNORE INTO card_tags (card_id, tag_id) SELECT ?, id FROM tags WHERE id = ?');
  for (const t of tags.slice(0, 30)) ins.run(cardId, Number(t));
}

app.get(
  '/api/cards/:id',
  auth,
  wrap((req) => {
    const card = loadCards(req.user, 'WHERE c.id = ?', [Number(req.params.id)])[0];
    if (!card || card.redacted) fail(404, 'Karte nicht gefunden.');
    card.comments = db
      .prepare(
        `SELECT m.id, m.body, m.created_at AS createdAt, m.user_id AS userId, u.name AS userName, u.color AS userColor
         FROM comments m LEFT JOIN users u ON u.id = m.user_id WHERE m.card_id = ? ORDER BY m.id`
      )
      .all(card.id);
    return card;
  })
);

app.post(
  '/api/cards',
  auth,
  wrap((req) => {
    const title = str(req.body.title, 200);
    if (!title) fail(400, 'Titel fehlt.');
    let column = req.body.columnKey;
    if (!COLUMN_KEYS.has(column) || (!req.user.isAdmin && column !== 'wishes' && column !== 'backlog'))
      column = 'wishes';
    const id = tx(() => {
      const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM cards WHERE column_key = ?').get(column).m;
      const id = db
        .prepare(
          'INSERT INTO cards (title, description, column_key, position, due_date, created_by, assigned_to, is_private) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          title,
          str(req.body.description, 10000),
          column,
          max + 1,
          validDate(req.body.dueDate),
          req.user.id,
          validAssignee(req.body.assignedTo),
          req.user.isAdmin && req.body.isPrivate ? 1 : 0
        )
        .lastInsertRowid;
      setLinks(id, req.body.links);
      setTags(id, req.body.tags);
      return id;
    });
    broadcast();
    return { id: Number(id) };
  })
);

app.patch(
  '/api/cards/:id',
  auth,
  wrap((req) => {
    const card = getCard(req.params.id, req.user);
    if (!canEdit(req.user, card)) fail(403, 'Nur die Person, die den Wunsch erstellt hat, darf ihn bearbeiten.');
    const b = req.body;
    tx(() => {
      const title = b.title !== undefined ? str(b.title, 200) : card.title;
      if (!title) fail(400, 'Titel fehlt.');
      db.prepare(
        `UPDATE cards SET title = ?, description = ?, due_date = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(
        title,
        b.description !== undefined ? str(b.description, 10000) : card.description,
        b.dueDate !== undefined ? validDate(b.dueDate) : card.due_date,
        card.id
      );
      setLinks(card.id, b.links);
      setTags(card.id, b.tags);
    });
    broadcast();
    return { ok: true };
  })
);

app.post(
  '/api/cards/:id/move',
  auth,
  wrap((req) => {
    const card = getCard(req.params.id, req.user);
    const column = req.body.columnKey;
    if (!COLUMN_KEYS.has(column)) fail(400, 'Unbekannte Spalte.');
    // Familienmitglieder dürfen ihre eigenen Wünsche nur zwischen "Wünsche" und "Zurückgestellt" schieben.
    const own = card.created_by === req.user.id;
    const familyCols = new Set(['wishes', 'backlog']);
    if (!req.user.isAdmin && !(own && familyCols.has(card.column_key) && familyCols.has(column)))
      fail(403, 'Status ändern darf nur der Drucker-Admin.');
    tx(() => {
      if (column !== card.column_key)
        db.prepare(`UPDATE cards SET column_key = ?, moved_at = datetime('now') WHERE id = ?`).run(column, card.id);
      // Reihenfolge: nur Admins dürfen priorisieren; sonst ans Ende der Spalte
      let order = Array.isArray(req.body.order) ? req.body.order.map(Number) : null;
      if (!req.user.isAdmin || !order) {
        const ids = db
          .prepare('SELECT id FROM cards WHERE column_key = ? AND id != ? ORDER BY position, id')
          .all(column, card.id)
          .map((r) => r.id);
        order = [...ids, card.id];
      }
      const upd = db.prepare('UPDATE cards SET position = ? WHERE id = ? AND column_key = ?');
      order.forEach((id, i) => upd.run(i + 1, id, column));
    });
    broadcast();
    return { ok: true };
  })
);

// Zuständig setzen: Admin, Ersteller*in und die aktuell zuständige Person dürfen den Ball weiterspielen
app.post(
  '/api/cards/:id/assignee',
  auth,
  wrap((req) => {
    const card = getCard(req.params.id, req.user);
    if (!req.user.isAdmin && card.created_by !== req.user.id && card.assigned_to !== req.user.id)
      fail(403, 'Zuständigkeit ändern dürfen Admin, Ersteller*in und die zuständige Person.');
    const assignee = validAssignee(req.body.userId);
    db.prepare(`UPDATE cards SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?`).run(assignee, card.id);
    broadcast();
    return { ok: true };
  })
);

// Privat schalten (nur Admins)
app.post(
  '/api/cards/:id/private',
  auth,
  admin,
  wrap((req) => {
    const card = getCard(req.params.id, req.user);
    db.prepare(`UPDATE cards SET is_private = ?, updated_at = datetime('now') WHERE id = ?`).run(req.body.isPrivate ? 1 : 0, card.id);
    broadcast();
    return { ok: true };
  })
);

// Eigenes Titelbild (Foto/Screenshot) hochladen, ersetzen oder entfernen
app.put(
  '/api/cards/:id/cover',
  auth,
  express.raw({ type: 'image/*', limit: '8mb' }),
  wrap((req) => {
    const card = getCard(req.params.id, req.user);
    if (!canEdit(req.user, card)) fail(403, 'Nur Admin und Ersteller*in dürfen das Bild ändern.');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const type = sniffImage(buf);
    if (!type) fail(400, 'Bitte ein JPG-, PNG-, WebP- oder GIF-Bild verwenden.');
    const file = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(COVER_DIR, file), buf);
    db.prepare(`UPDATE cards SET cover_file = ?, cover_type = ?, updated_at = datetime('now') WHERE id = ?`).run(file, type, card.id);
    removeCoverFile(card.cover_file);
    broadcast();
    return { ok: true };
  })
);
app.delete(
  '/api/cards/:id/cover',
  auth,
  wrap((req) => {
    const card = getCard(req.params.id, req.user);
    if (!canEdit(req.user, card)) fail(403, 'Nur Admin und Ersteller*in dürfen das Bild ändern.');
    db.prepare(`UPDATE cards SET cover_file = NULL, cover_type = NULL WHERE id = ?`).run(card.id);
    removeCoverFile(card.cover_file);
    broadcast();
    return { ok: true };
  })
);
app.get('/api/covers/:id', auth, (req, res, next) => {
  try {
    const card = getCard(req.params.id, req.user);
    if (!card.cover_file) fail(404, 'Kein Bild.');
    res.setHeader('Content-Type', card.cover_type);
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.sendFile(path.join(COVER_DIR, card.cover_file));
  } catch (e) {
    next(e);
  }
});

// Vorschau eines Links neu laden
app.post(
  '/api/cards/:id/previews/refresh',
  auth,
  wrap((req) => {
    const card = getCard(req.params.id, req.user);
    if (!canEdit(req.user, card)) fail(403, 'Nicht erlaubt.');
    for (const r of db.prepare('SELECT url FROM links WHERE card_id = ?').all(card.id)) preview.refresh(r.url);
    broadcast();
    return { ok: true };
  })
);

// Vorschaubilder ausliefern – nur angemeldet und nur, wenn eine sichtbare Karte den Link enthält
app.get('/api/previews/:hash', auth, (req, res, next) => {
  try {
    const p = db.prepare(`SELECT url, image_type FROM previews WHERE image_hash = ? AND status = 'ok'`).get(req.params.hash);
    const file = p && preview.imagePath(req.params.hash);
    if (!file) fail(404, 'Nicht gefunden.');
    const cards = db
      .prepare('SELECT c.* FROM cards c JOIN links l ON l.card_id = c.id WHERE l.url = ?')
      .all(p.url);
    if (!cards.some((c) => canSee(req.user, c))) fail(404, 'Nicht gefunden.');
    res.setHeader('Content-Type', p.image_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.sendFile(file);
  } catch (e) {
    next(e);
  }
});

app.delete(
  '/api/cards/:id',
  auth,
  wrap((req) => {
    const card = getCard(req.params.id, req.user);
    const ownOpen = card.created_by === req.user.id && (card.column_key === 'wishes' || card.column_key === 'backlog');
    if (!req.user.isAdmin && !ownOpen) fail(403, 'Löschen nicht erlaubt.');
    db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
    removeCoverFile(card.cover_file);
    broadcast();
    return { ok: true };
  })
);

// --- Kommentare ---
app.post(
  '/api/cards/:id/comments',
  auth,
  wrap((req) => {
    const card = getCard(req.params.id, req.user);
    const body = str(req.body.body, 4000);
    if (!body) fail(400, 'Kommentar ist leer.');
    db.prepare('INSERT INTO comments (card_id, user_id, body) VALUES (?, ?, ?)').run(card.id, req.user.id, body);
    broadcast();
    return { ok: true };
  })
);
app.delete(
  '/api/comments/:id',
  auth,
  wrap((req) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(req.params.id));
    if (!c) fail(404, 'Kommentar nicht gefunden.');
    if (!req.user.isAdmin && c.user_id !== req.user.id) fail(403, 'Nicht erlaubt.');
    db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
    broadcast();
    return { ok: true };
  })
);

// --- Tags ---
app.post(
  '/api/tags',
  auth,
  wrap((req) => {
    const name = str(req.body.name, 30);
    if (!name) fail(400, 'Name fehlt.');
    const color = validColor(req.body.color) ? req.body.color : '#64748b';
    const existing = db.prepare('SELECT id, name, color FROM tags WHERE name = ?').get(name);
    if (existing) return existing;
    const id = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color).lastInsertRowid;
    broadcast();
    return { id: Number(id), name, color };
  })
);
app.patch(
  '/api/tags/:id',
  auth,
  admin,
  wrap((req) => {
    const name = str(req.body.name, 30);
    if (!name) fail(400, 'Name fehlt.');
    const color = validColor(req.body.color) ? req.body.color : '#64748b';
    try {
      db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, Number(req.params.id));
    } catch {
      fail(409, 'Tag existiert bereits.');
    }
    broadcast();
    return { ok: true };
  })
);
app.delete(
  '/api/tags/:id',
  auth,
  admin,
  wrap((req) => {
    db.prepare('DELETE FROM tags WHERE id = ?').run(Number(req.params.id));
    broadcast();
    return { ok: true };
  })
);

// --- Benutzerverwaltung (Admin) ---
app.post(
  '/api/users',
  auth,
  admin,
  wrap((req) => {
    const name = str(req.body.name, 40);
    if (!name) fail(400, 'Name fehlt.');
    if (!validPin(req.body.pin)) fail(400, PIN_HINT);
    const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    try {
      db.prepare('INSERT INTO users (name, pin_hash, is_admin, color) VALUES (?, ?, ?, ?)').run(
        name,
        hashPin(req.body.pin),
        req.body.isAdmin ? 1 : 0,
        validColor(req.body.color) ? req.body.color : USER_COLORS[n % USER_COLORS.length]
      );
    } catch {
      fail(409, 'Name ist schon vergeben.');
    }
    broadcast();
    return { ok: true };
  })
);
app.patch(
  '/api/users/:id',
  auth,
  admin,
  wrap((req) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) fail(404, 'Benutzer nicht gefunden.');
    tx(() => {
      if (req.body.name !== undefined) {
        const name = str(req.body.name, 40);
        if (!name) fail(400, 'Name fehlt.');
        try {
          db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
        } catch {
          fail(409, 'Name ist schon vergeben.');
        }
      }
      if (req.body.color !== undefined && validColor(req.body.color))
        db.prepare('UPDATE users SET color = ? WHERE id = ?').run(req.body.color, id);
      if (req.body.pin !== undefined && req.body.pin !== '') {
        if (!validPin(req.body.pin)) fail(400, PIN_HINT);
        db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(req.body.pin), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(id, req.user.id);
      }
      if (req.body.isAdmin !== undefined) {
        if (id === req.user.id && !req.body.isAdmin) fail(400, 'Du kannst dir die Admin-Rechte nicht selbst entziehen.');
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.isAdmin ? 1 : 0, id);
      }
    });
    broadcast();
    return { ok: true };
  })
);
app.delete(
  '/api/users/:id',
  auth,
  admin,
  wrap((req) => {
    const id = Number(req.params.id);
    if (id === req.user.id) fail(400, 'Du kannst dich nicht selbst löschen.');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    broadcast();
    return { ok: true };
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err instanceof HttpError ? err.message : 'Interner Fehler.' });
});

preview.init(() => broadcast());

app.listen(PORT, HOST, () => {
  console.log(`Druckwunsch v${VERSION} läuft auf http://${HOST}:${PORT}`);
  if (!SETUP_TOKEN && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0)
    console.warn('WARNUNG: Kein SETUP_TOKEN gesetzt – jeder, der die Seite zuerst aufruft, kann Admin werden.');
});
