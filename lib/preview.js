'use strict';
// Link-Vorschau: lädt von einer Webseite das Vorschaubild (og:image / twitter:image) und den Titel
// und speichert das Bild lokal. Abgesichert gegen SSRF: Es werden ausschließlich öffentliche
// IP-Adressen angesprochen (auch nach Weiterleitungen), nur Port 80/443, mit Größen- und Zeitlimit.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');

const PREVIEW_DIR = path.join(DATA_DIR, 'previews');
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (compatible; Druckwunsch-Linkvorschau/1.0)';
const TIMEOUT_MS = 10000;
const MAX_HTML = 1.5 * 1024 * 1024;
const MAX_IMAGE = 6 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const RETRY_AFTER_H = 24;

// ---------- Nur öffentliche Adressen ----------
const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32],
]) blocked.addSubnet(a, p, 'ipv6');

function isPublicIp(ip) {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4mapped) ip = v4mapped[1];
  const family = net.isIP(ip);
  if (!family) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

// Wird beim Verbindungsaufbau aufgerufen -> schützt auch gegen DNS-Rebinding
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => isPublicIp(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(new Error(`Blockierte Adresse: ${hostname}`));
    if (options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function checkUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Nur http/https');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('Nur Standard-Ports');
  if (u.username || u.password) throw new Error('Keine Zugangsdaten in URLs');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && !isPublicIp(u.hostname.replace(/^\[|\]$/g, '')))
    throw new Error('Blockierte Adresse');
  return u;
}

function get(rawUrl, { maxBytes, accept }, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = checkUrl(rawUrl);
    } catch (e) {
      return reject(e);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      u,
      {
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': UA, Accept: accept, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'de,en;q=0.8' },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects >= 5) return reject(new Error('Zu viele Weiterleitungen'));
          return resolve(get(new URL(res.headers.location, u).toString(), { maxBytes, accept }, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            // HTML: Anfang reicht für die Meta-Tags; Bild: zu groß -> verwerfen
            if (accept.startsWith('text/html')) resolve({ url: u.toString(), type: res.headers['content-type'] || '', body: Buffer.concat(chunks) });
            else reject(new Error('Datei zu groß'));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => resolve({ url: u.toString(), type: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
        stream.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
  });
}

// ---------- HTML auswerten ----------
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function parseMeta(html) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi))
      attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = attrs.content.trim();
  }
  const link = /<link\b[^>]*rel=["']?image_src["']?[^>]*>/i.exec(html);
  if (link) {
    const href = /href=["']([^"']+)["']/i.exec(link[0]);
    if (href) meta.image_src = decodeEntities(href[1]);
  }
  const t = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html);
  return {
    image: meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || meta.image || meta.image_src || null,
    title: (meta['og:title'] || meta['twitter:title'] || (t ? decodeEntities(t[1]) : '') || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

// ---------- Abruf + Speicherung ----------
async function fetchPreview(url) {
  const page = await get(url, { maxBytes: MAX_HTML, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' });
  // Link zeigt direkt auf ein Bild
  const pageType = page.type.split(';')[0].trim().toLowerCase();
  if (IMAGE_TYPES[pageType]) return { title: '', image: page };
  if (!pageType.includes('html')) return { title: '', image: null };
  const { image, title } = parseMeta(page.body.toString('utf8'));
  if (!image) return { title, image: null };
  const img = await get(new URL(image, page.url).toString(), { maxBytes: MAX_IMAGE, accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' });
  return { title, image: img };
}

const queue = [];
let running = 0;
let onUpdate = () => {};

async function work(url) {
  try {
    const { title, image } = await fetchPreview(url);
    let hash = null;
    let type = null;
    if (image) {
      type = image.type.split(';')[0].trim().toLowerCase();
      if (!IMAGE_TYPES[type] || image.body.length < 100) throw new Error(`Kein unterstütztes Bild (${type})`);
      hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
      fs.writeFileSync(path.join(PREVIEW_DIR, hash), image.body);
    }
    db.prepare(
      `UPDATE previews SET status = ?, title = ?, image_hash = ?, image_type = ?, error = NULL, fetched_at = datetime('now') WHERE url = ?`
    ).run(hash ? 'ok' : 'none', title || null, hash, type, url);
  } catch (e) {
    db.prepare(`UPDATE previews SET status = 'error', error = ?, fetched_at = datetime('now') WHERE url = ?`).run(
      String(e.message).slice(0, 200),
      url
    );
  }
  onUpdate();
}
function pump() {
  while (running < 2 && queue.length) {
    const url = queue.shift();
    running++;
    work(url).finally(() => {
      running--;
      pump();
    });
  }
}

// Für alle Links ohne (aktuelle) Vorschau einen Abruf einplanen
function schedule(urls) {
  const sel = db.prepare('SELECT status, fetched_at FROM previews WHERE url = ?');
  const upsert = db.prepare(
    `INSERT INTO previews (url, status) VALUES (?, 'pending') ON CONFLICT(url) DO UPDATE SET status = 'pending'`
  );
  for (const url of new Set(urls)) {
    const p = sel.get(url);
    const stale =
      !p ||
      p.status === 'pending' ||
      (p.status === 'error' && Date.now() - new Date(p.fetched_at.replace(' ', 'T') + 'Z') > RETRY_AFTER_H * 3600e3);
    if (!stale || queue.includes(url)) continue;
    upsert.run(url);
    queue.push(url);
  }
  pump();
}
function refresh(url) {
  db.prepare(`DELETE FROM previews WHERE url = ?`).run(url);
  schedule([url]);
}
function init(updateCb) {
  onUpdate = updateCb;
  // Beim Start: Links ohne Vorschau (z. B. nach einem Update) nachholen
  schedule(db.prepare('SELECT DISTINCT url FROM links').all().map((r) => r.url));
}
function imagePath(hash) {
  return /^[0-9a-f]{32}$/.test(hash) ? path.join(PREVIEW_DIR, hash) : null;
}

module.exports = { init, schedule, refresh, imagePath, isPublicIp, parseMeta };
