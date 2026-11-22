'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const S = { me: null, board: null, users: [], filter: { q: '', user: '', assignee: '', tag: '' }, dragging: false, card: null };

  // ---------- Hilfsfunktionen ----------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
    return el;
  }
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
      body: method !== 'GET' ? JSON.stringify(body || {}) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/login') {
      showAuth();
      throw new Error(data.error || 'Bitte anmelden.');
    }
    if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
    return data;
  }
  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.add('hidden'), 3500);
  }
  function avatar(name, color, cls = '') {
    const initials = (name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2);
    return h('span', { class: `avatar ${cls}`, style: `background:${color || '#94a3b8'}`, title: name || 'Gelöscht' }, initials);
  }
  function tagEl(tag) {
    return h('span', { class: 'tag', style: `background:${tag.color}` }, tag.name);
  }
  const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dtFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const sqlDate = (s) => new Date(s.replace(' ', 'T') + 'Z');
  function linkParts(url) {
    try {
      const u = new URL(url);
      return { host: u.hostname.replace(/^www\./, ''), rest: (u.pathname + u.search).replace(/\/$/, '') };
    } catch {
      return { host: url, rest: '' };
    }
  }
  const colTitle = (key) => S.board.columns.find((c) => c.key === key)?.title || key;
  const isOpenCol = (k) => k === 'wishes' || k === 'backlog';

  // ---------- Auth ----------
  async function init() {
    const st = await api('GET', '/api/state');
    if (st.setupRequired) return showSetup(st.setupTokenRequired);
    $('#menu-version').textContent = `Version ${st.version}`;
    if (!st.user) return showAuth();
    S.me = st.user;
    showApp();
  }
  function showSetup(tokenRequired) {
    $('#setup-token-wrap').classList.toggle('hidden', !tokenRequired);
    $('#setup-form').elements.setupToken.required = !!tokenRequired;
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
    $('#setup-form').classList.remove('hidden');
    $('#login-form').classList.add('hidden');
  }
  async function showAuth() {
    S.me = null;
    closeEvents();
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
    $('#setup-form').classList.add('hidden');
    $('#login-form').classList.remove('hidden');
    const f = $('#login-form').elements;
    const last = localStorageGet('dw_last_name');
    if (last && !f.name.value) f.name.value = last;
    (f.name.value ? f.pin : f.name).focus();
  }
  function localStorageGet(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  }
  function localStorageSet(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  }

  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/setup', { name: f.get('name'), pin: f.get('pin'), setupToken: (f.get('setupToken') || '').trim() });
      $('#auth-error').textContent = '';
      init();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await api('POST', '/api/login', { name: f.name.value.trim(), pin: f.pin.value });
      localStorageSet('dw_last_name', f.name.value.trim());
      f.pin.value = '';
      $('#auth-error').textContent = '';
      init();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });

  // ---------- App ----------
  function showApp() {
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    const btn = $('#btn-menu');
    btn.replaceChildren(avatar(S.me.name, S.me.color, 'lg'));
    $('#menu-name').textContent = S.me.name + (S.me.isAdmin ? ' (Admin)' : '');
    document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !S.me.isAdmin));
    loadBoard();
    openEvents();
  }

  async function loadBoard() {
    S.board = await api('GET', '/api/board');
    const me = S.board.users.find((u) => u.id === S.me.id);
    if (me) S.me = { ...S.me, name: me.name, color: me.color, isAdmin: !!me.isAdmin };
    fillFilters();
    renderBoard();
  }

  function fillFilters() {
    const fu = $('#f-user');
    const ft = $('#f-tag');
    fu.replaceChildren(h('option', { value: '' }, 'Von: alle'), ...S.board.users.map((u) => h('option', { value: u.id }, u.name)));
    ft.replaceChildren(h('option', { value: '' }, 'Tags: alle'), ...S.board.tags.map((t) => h('option', { value: t.id }, t.name)));
    const fa = $('#f-assignee');
    fa.replaceChildren(
      h('option', { value: '' }, 'Zuständig: alle'),
      h('option', { value: 'me' }, '⏳ Wartet auf mich'),
      h('option', { value: 'none' }, 'Niemand zuständig'),
      ...S.board.users.map((u) => h('option', { value: u.id }, `Zuständig: ${u.name}`))
    );
    fa.value = S.filter.assignee;
    fu.value = S.filter.user;
    ft.value = S.filter.tag;
  }

  function matches(c) {
    const f = S.filter;
    if (f.user && String(c.createdBy) !== f.user) return false;
    if (f.assignee === 'me' && c.assignedTo !== S.me.id) return false;
    if (f.assignee === 'none' && c.assignedTo) return false;
    if (f.assignee && !['me', 'none'].includes(f.assignee) && String(c.assignedTo) !== f.assignee) return false;
    if (f.tag && !c.tags.includes(Number(f.tag))) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (!(c.title + ' ' + c.description + ' ' + (c.creatorName || '') + ' ' + (c.assigneeName || '')).toLowerCase().includes(q)) return false;
    }
    return true;
  }

  const sortables = [];
  function renderBoard() {
    if (S.dragging) return;
    const board = $('#board');
    const scroll = board.scrollLeft;
    sortables.splice(0).forEach((s) => s.destroy());
    board.replaceChildren();
    const tagById = new Map(S.board.tags.map((t) => [t.id, t]));
    const today = new Date().toISOString().slice(0, 10);

    for (const col of S.board.columns) {
      const cards = S.board.cards.filter((c) => c.columnKey === col.key);
      const visible = cards.filter(matches);
      const list = h('ul', { class: 'cards', dataset: { key: col.key } });
      for (const c of visible) {
        const canDrag = S.me.isAdmin || (c.createdBy === S.me.id && isOpenCol(c.columnKey));
        const foot = h(
          'div',
          { class: 'card-foot' },
          h('span', { class: 'who' }, avatar(c.creatorName, c.creatorColor), h('span', {}, c.creatorName || 'Gelöscht')),
          c.dueDate && h('span', { class: `due ${c.dueDate < today && col.key !== 'done' ? 'over' : ''}`, title: 'Gewünscht bis' }, '📅 ' + dateFmt.format(new Date(c.dueDate))),
          c.description && h('span', { title: 'Hat Beschreibung' }, '≡'),
          c.links.length > 0 && h('span', { title: `${c.links.length} Link(s)` }, `🔗 ${c.links.length}`),
          c.commentCount > 0 && h('span', { title: 'Kommentare' }, `💬 ${c.commentCount}`),
          c.assignedTo &&
            h(
              'span',
              { class: `assignee ${c.assignedTo === S.me.id ? 'me' : ''}`, title: `Zuständig: ${c.assigneeName}` },
              c.assignedTo === S.me.id ? 'Bei dir' : '',
              avatar(c.assigneeName, c.assigneeColor)
            )
        );
        const tags = c.tags.map((id) => tagById.get(id)).filter(Boolean);
        list.append(
          h(
            'li',
            { class: `card ${canDrag ? 'can-drag' : ''} ${c.assignedTo === S.me.id && col.key !== 'done' ? 'mine' : ''}`, dataset: { id: c.id }, onclick: () => openCard(c.id) },
            tags.length > 0 && h('div', { class: 'tags' }, tags.map(tagEl)),
            h('div', { class: 'card-title' }, c.title),
            foot
          )
        );
      }
      const canAdd = S.me.isAdmin || isOpenCol(col.key);
      board.append(
        h(
          'section',
          { class: 'column', dataset: { key: col.key } },
          h('div', { class: 'column-head' }, h('span', { class: 'dot' }), col.title, h('span', { class: 'count' }, visible.length === cards.length ? cards.length : `${visible.length}/${cards.length}`)),
          list,
          canAdd && h('button', { class: 'add-inline', onclick: () => openCard(null, col.key) }, '+ Karte hinzufügen')
        )
      );
      sortables.push(
        Sortable.create(list, {
          group: 'board',
          draggable: '.can-drag',
          animation: 150,
          delay: 200,
          delayOnTouchOnly: true,
          touchStartThreshold: 6,
          // Auto-Scroll, wenn die Karte an den Rand gezogen wird (wichtig auf dem Handy)
          scroll: true,
          forceAutoScrollFallback: true,
          scrollSensitivity: 60,
          scrollSpeed: 7,
          bubbleScroll: true,
          // Familienmitglieder: nur zwischen "Wünsche" und "Zurückgestellt"
          onMove: (evt) => S.me.isAdmin || isOpenCol(evt.to.dataset.key),
          onStart: () => {
            S.dragging = true;
            board.classList.add('is-dragging'); // Einrasten der Spalten aus, sonst springt das Board zurück
            if (navigator.vibrate) navigator.vibrate(15);
          },
          onEnd: async (evt) => {
            S.dragging = false;
            board.classList.remove('is-dragging');
            if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
            const id = Number(evt.item.dataset.id);
            const order = [...evt.to.querySelectorAll('.card')].map((el) => Number(el.dataset.id));
            try {
              await api('POST', `/api/cards/${id}/move`, { columnKey: evt.to.dataset.key, order });
            } catch (err) {
              toast(err.message);
            }
            loadBoard();
          },
        })
      );
    }
    board.scrollLeft = scroll;
  }

  // Filter
  $('#f-search').addEventListener('input', (e) => { S.filter.q = e.target.value.trim(); renderBoard(); });
  $('#f-user').addEventListener('change', (e) => { S.filter.user = e.target.value; renderBoard(); });
  $('#f-assignee').addEventListener('change', (e) => { S.filter.assignee = e.target.value; renderBoard(); });
  $('#f-tag').addEventListener('change', (e) => { S.filter.tag = e.target.value; renderBoard(); });

  // Menü
  $('#btn-menu').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); });
  document.addEventListener('click', () => $('#menu').classList.add('hidden'));
  $('#menu').addEventListener('click', async (e) => {
    const a = e.target.dataset.action;
    if (a === 'logout') {
      await api('POST', '/api/logout');
      showAuth();
    } else if (a === 'pin') {
      $('#pin-form').reset();
      $('#pin-error').textContent = '';
      $('#pin-dialog').showModal();
    } else if (a === 'admin') {
      renderAdmin();
      $('#admin-dialog').showModal();
    }
  });
  $('#btn-new').addEventListener('click', () => openCard(null, 'wishes'));
  document.querySelectorAll('dialog').forEach((d) =>
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return d.close();
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    })
  );

  // ---------- Live-Updates ----------
  let es, reloadT;
  function openEvents() {
    closeEvents();
    es = new EventSource('/api/events');
    es.addEventListener('changed', () => {
      clearTimeout(reloadT);
      reloadT = setTimeout(() => {
        loadBoard().catch(() => {});
        if ($('#card-dialog').open && S.card?.id) refreshComments();
      }, 250);
    });
  }
  function closeEvents() {
    if (es) es.close();
    es = null;
  }

  // ---------- Karten-Dialog ----------
  const form = $('#card-form');
  const F = form.elements;
  async function openCard(id, columnKey = 'wishes') {
    $('#card-error').textContent = '';
    let card;
    if (id) {
      try {
        card = await api('GET', `/api/cards/${id}`);
      } catch (err) {
        return toast(err.message);
      }
    } else {
      card = { id: null, title: '', description: '', columnKey, dueDate: null, links: [], tags: [], comments: [], createdBy: S.me.id, assignedTo: null };
    }
    S.card = { ...card, links: card.links.map((l) => l.url), tags: [...card.tags] };
    const editable = !card.id || S.me.isAdmin || card.createdBy === S.me.id;
    S.card.editable = editable;

    F.title.value = card.title;
    F.description.value = card.description;
    F.dueDate.value = card.dueDate || '';

    renderStatus();
    renderAssignee();

    for (const el of [F.title, F.description, F.dueDate, $('#link-input'), $('#link-add'), $('#tag-new-name'), $('#tag-new-color'), $('#tag-add')])
      el.disabled = !editable;
    $('#card-save').classList.toggle('hidden', !editable);
    const canDelete = card.id && (S.me.isAdmin || (card.createdBy === S.me.id && isOpenCol(card.columnKey)));
    $('#card-delete').classList.toggle('hidden', !canDelete);

    // Meta
    const meta = $('#card-meta');
    meta.replaceChildren();
    if (card.id) {
      meta.append(
        avatar(card.creatorName, card.creatorColor),
        h('span', {}, `Gewünscht von `, h('b', {}, card.creatorName || 'Gelöscht'), ` am ${dtFmt.format(sqlDate(card.createdAt))}`),
        h('span', {}, `· ${colTitle(card.columnKey)} seit ${dtFmt.format(sqlDate(card.movedAt))}`)
      );
    } else meta.append(h('span', {}, 'Neuer Wunsch'));

    renderLinks();
    renderTagPicker();
    $('#comments').classList.toggle('hidden', !card.id);
    renderComments(card.comments);
    $('#card-dialog').showModal();
    if (!card.id) F.title.focus();
  }

  // ---------- Status-Knöpfe: ein Tipp verschiebt die Karte sofort ----------
  function canMoveCard(c) {
    return !c.id || S.me.isAdmin || (c.createdBy === S.me.id && isOpenCol(c.columnKey));
  }
  function renderStatus() {
    const c = S.card;
    const movable = canMoveCard(c);
    $('#card-status-hint').textContent = !movable
      ? '– ändert der Drucker-Admin'
      : c.id ? '– antippen zum Verschieben' : '';
    $('#card-status').replaceChildren(
      ...S.board.columns.map((col) => {
        const allowed = movable && (S.me.isAdmin || isOpenCol(col.key));
        const active = col.key === c.columnKey;
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': active ? 'true' : 'false',
            class: `status-btn ${active ? 'active' : ''}`,
            dataset: { key: col.key },
            disabled: !allowed && !active,
            onclick: () => allowed && !active && setStatus(col.key),
          },
          h('span', { class: 'dot' }),
          col.title
        );
      })
    );
  }
  async function setStatus(key) {
    const c = S.card;
    if (!c.id) {
      c.columnKey = key; // neue Karte: wird beim Speichern angelegt
      return renderStatus();
    }
    try {
      await api('POST', `/api/cards/${c.id}/move`, { columnKey: key });
      c.columnKey = key;
      renderStatus();
      toast(`Verschoben nach „${colTitle(key)}“`);
      loadBoard();
    } catch (err) {
      $('#card-error').textContent = err.message;
    }
  }

  // ---------- Zuständig ----------
  function canAssign(c) {
    return !c.id || S.me.isAdmin || c.createdBy === S.me.id || c.assignedTo === S.me.id;
  }
  function renderAssignee() {
    const c = S.card;
    const sel = $('#card-assignee');
    sel.replaceChildren(
      h('option', { value: '' }, '– niemand –'),
      ...S.board.users.map((u) => h('option', { value: u.id }, u.id === S.me.id ? `${u.name} (ich)` : u.name))
    );
    sel.value = c.assignedTo ? String(c.assignedTo) : '';
    sel.disabled = !canAssign(c);
    $('#card-assignee-hint').textContent = c.assignedTo === S.me.id && c.id ? '– wartet auf dich' : '';
  }
  $('#card-assignee').addEventListener('change', async (e) => {
    const c = S.card;
    const userId = e.target.value ? Number(e.target.value) : null;
    if (!c.id) return void (c.assignedTo = userId); // neue Karte: wird beim Speichern übernommen
    try {
      await api('POST', `/api/cards/${c.id}/assignee`, { userId });
      c.assignedTo = userId;
      const u = S.board.users.find((x) => x.id === userId);
      toast(u ? `Jetzt zuständig: ${u.name}` : 'Niemand mehr zuständig');
      renderAssignee();
      loadBoard();
    } catch (err) {
      $('#card-error').textContent = err.message;
      renderAssignee();
    }
  });

  function renderLinks() {
    const ul = $('#link-list');
    ul.replaceChildren(
      ...S.card.links.map((url, i) => {
        const p = linkParts(url);
        return h(
          'li',
          {},
          h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, h('b', {}, p.host), p.rest),
          S.card.editable && h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Link entfernen', onclick: () => { S.card.links.splice(i, 1); renderLinks(); } }, '✕')
        );
      })
    );
  }
  function addLink() {
    const inp = $('#link-input');
    let v = inp.value.trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      new URL(v);
    } catch {
      return toast('Das sieht nicht wie ein Link aus.');
    }
    S.card.links.push(v);
    inp.value = '';
    renderLinks();
  }
  $('#link-add').addEventListener('click', addLink);
  $('#link-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } });
  // Link direkt aus Zwischenablage einfügen → sofort übernehmen
  $('#link-input').addEventListener('paste', () => setTimeout(() => { if (/^\S+\.\S+$/.test($('#link-input').value.trim())) addLink(); }, 0));

  function renderTagPicker() {
    const box = $('#tag-picker');
    box.replaceChildren(
      ...S.board.tags.map((t) => {
        const el = tagEl(t);
        el.classList.toggle('on', S.card.tags.includes(t.id));
        if (S.card.editable)
          el.addEventListener('click', () => {
            const i = S.card.tags.indexOf(t.id);
            if (i >= 0) S.card.tags.splice(i, 1);
            else S.card.tags.push(t.id);
            renderTagPicker();
          });
        return el;
      })
    );
    if (!S.board.tags.length) box.append(h('span', { class: 'muted' }, 'Noch keine Tags.'));
  }
  async function addTag() {
    const name = $('#tag-new-name').value.trim();
    if (!name) return;
    try {
      const t = await api('POST', '/api/tags', { name, color: $('#tag-new-color').value });
      if (!S.board.tags.some((x) => x.id === t.id)) S.board.tags.push(t);
      S.board.tags.sort((a, b) => a.name.localeCompare(b.name, 'de'));
      if (!S.card.tags.includes(t.id)) S.card.tags.push(t.id);
      $('#tag-new-name').value = '';
      renderTagPicker();
    } catch (err) {
      toast(err.message);
    }
  }
  $('#tag-add').addEventListener('click', addTag);
  $('#tag-new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = S.card;
    if ($('#link-input').value.trim()) addLink();
    const payload = {
      title: F.title.value,
      description: F.description.value,
      dueDate: F.dueDate.value || null,
      links: c.links,
      tags: c.tags,
    };
    try {
      if (!c.id) await api('POST', '/api/cards', { ...payload, columnKey: c.columnKey, assignedTo: c.assignedTo || null });
      else if (c.editable) await api('PATCH', `/api/cards/${c.id}`, payload);
      $('#card-dialog').close();
      loadBoard();
    } catch (err) {
      $('#card-error').textContent = err.message;
    }
  });
  $('#card-delete').addEventListener('click', async () => {
    if (!confirm(`„${S.card.title}“ wirklich löschen?`)) return;
    try {
      await api('DELETE', `/api/cards/${S.card.id}`);
      $('#card-dialog').close();
      loadBoard();
    } catch (err) {
      $('#card-error').textContent = err.message;
    }
  });

  // Kommentare
  function renderComments(list) {
    $('#comment-list').replaceChildren(
      ...list.map((m) =>
        h(
          'li',
          {},
          avatar(m.userName, m.userColor),
          h(
            'div',
            { class: 'c-body' },
            h('div', { class: 'c-head' }, h('b', {}, m.userName || 'Gelöscht'), ' · ', dtFmt.format(sqlDate(m.createdAt))),
            h('div', { class: 'c-text' }, m.body)
          ),
          (S.me.isAdmin || m.userId === S.me.id) &&
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Kommentar löschen', onclick: async () => {
              if (!confirm('Kommentar löschen?')) return;
              await api('DELETE', `/api/comments/${m.id}`).catch((e) => toast(e.message));
              refreshComments();
            } }, '✕')
        )
      )
    );
  }
  async function refreshComments() {
    try {
      const c = await api('GET', `/api/cards/${S.card.id}`);
      renderComments(c.comments);
    } catch {}
  }
  async function addComment() {
    const inp = $('#comment-input');
    const body = inp.value.trim();
    if (!body) return;
    try {
      await api('POST', `/api/cards/${S.card.id}/comments`, { body });
      inp.value = '';
      refreshComments();
    } catch (err) {
      toast(err.message);
    }
  }
  $('#comment-add').addEventListener('click', addComment);
  $('#comment-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addComment(); });

  // ---------- PIN ändern ----------
  $('#pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/me/pin', { oldPin: e.target.elements.oldPin.value, newPin: e.target.elements.newPin.value });
      $('#pin-dialog').close();
      toast('PIN geändert.');
    } catch (err) {
      $('#pin-error').textContent = err.message;
    }
  });

  // ---------- Admin ----------
  function renderAdmin() {
    $('#admin-error').textContent = '';
    const err = (e) => ($('#admin-error').textContent = e.message);
    const after = async () => { await loadBoard(); renderAdmin(); };

    $('#user-list').replaceChildren(
      ...S.board.users.map((u) => {
        const color = h('input', { type: 'color', value: u.color, 'aria-label': 'Farbe' });
        color.addEventListener('change', () => api('PATCH', `/api/users/${u.id}`, { color: color.value }).then(after, err));
        const adm = h('input', { type: 'checkbox', checked: !!u.isAdmin, disabled: u.id === S.me.id });
        adm.addEventListener('change', () => api('PATCH', `/api/users/${u.id}`, { isAdmin: adm.checked }).then(after, err));
        return h(
          'li',
          {},
          color,
          h('span', { class: 'name' }, u.name, ' ', u.isAdmin ? h('span', { class: 'badge' }, 'Admin') : ''),
          h('label', { class: 'check' }, adm, 'Admin'),
          h('button', { class: 'btn', type: 'button', onclick: () => {
            const pin = prompt(`Neue PIN für ${u.name} (mind. 6 Zeichen):`);
            if (pin) api('PATCH', `/api/users/${u.id}`, { pin }).then(() => toast('PIN gesetzt.'), err);
          } }, 'PIN'),
          u.id !== S.me.id &&
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Löschen', onclick: () => {
              if (confirm(`${u.name} löschen? Wünsche bleiben erhalten.`)) api('DELETE', `/api/users/${u.id}`).then(after, err);
            } }, '🗑')
        );
      })
    );

    $('#tag-list').replaceChildren(
      ...S.board.tags.map((t) => {
        const color = h('input', { type: 'color', value: t.color, 'aria-label': 'Farbe' });
        const name = h('input', { type: 'text', value: t.name, maxlength: 30 });
        const save = () => api('PATCH', `/api/tags/${t.id}`, { name: name.value, color: color.value }).then(after, err);
        color.addEventListener('change', save);
        name.addEventListener('change', save);
        return h('li', {}, color, name, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Tag löschen', onclick: () => {
          if (confirm(`Tag „${t.name}“ löschen?`)) api('DELETE', `/api/tags/${t.id}`).then(after, err);
        } }, '🗑'));
      })
    );
  }
  $('#user-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await api('POST', '/api/users', { name: f.name.value, pin: f.pin.value, color: f.color.value, isAdmin: f.isAdmin.checked });
      e.target.reset();
      await loadBoard();
      renderAdmin();
    } catch (err) {
      $('#admin-error').textContent = err.message;
    }
  });

  init().catch((e) => toast(e.message));
})();
