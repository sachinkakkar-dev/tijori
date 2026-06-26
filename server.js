// Tijori relay server.
// - Google OAuth identity (verifies the ID token; user = Google `sub`)
// - Families, invites, roles (creator is always maintainer; join by invite only)
// - Store-and-forward of each member's ENCRYPTED portfolio object (server never
//   sees plaintext financial data — the family master key stays on the client)
// - Everything on disk is encrypted at rest (see store.js)
// - WebSocket push for live updates
try { require('dotenv').config(); } catch (_) { /* optional; or use: node --env-file=.env server.js */ }
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { OAuth2Client } = require('google-auth-library');
const store = require('./store');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const PORT = process.env.PORT || 8090;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || true;
if (!CLIENT_ID) { console.error('Set GOOGLE_CLIENT_ID'); process.exit(1); }

const oauth = new OAuth2Client(CLIENT_ID);
let db = store.load();
const persist = () => store.save(db);

// ---- helpers ----
async function verifyToken(token) {
  const ticket = await oauth.verifyIdToken({ idToken: token, audience: CLIENT_ID });
  const p = ticket.getPayload();
  return { sub: p.sub, email: (p.email || '').toLowerCase(), name: p.name || p.email || 'Member' };
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
async function auth(req, res, next) {
  try { req.user = await verifyToken(bearer(req)); next(); }
  catch (e) { res.status(401).json({ error: 'auth' }); }
}
function famSummary(f, sub) {
  const me = f.members[sub];
  return {
    id: f.id, name: f.name, role: me ? me.role : null,
    creatorSub: f.creatorSub,
    members: Object.values(f.members).map(m => ({ sub: m.sub, name: m.name, email: m.email, role: m.role })),
    pendingInvites: Object.values(f.invitesByEmail || {}).map(i => ({ email: i.email, role: i.role }))
  };
}

// ---- HTTP API ----
const app = express();
app.use(cors({ origin: ALLOW_ORIGIN }));
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serve index.html at the same origin

app.get('/api/health', (req, res) => res.json({ ok: true }));

// who am I + my families + invites waiting for me
app.get('/api/me', auth, (req, res) => {
  const { sub, email, name } = req.user;
  const families = [], invites = [];
  for (const f of Object.values(db.families)) {
    if (f.members[sub]) families.push(famSummary(f, sub));
    else if (f.invitesByEmail && f.invitesByEmail[email]) {
      const inv = f.invitesByEmail[email];
      invites.push({ familyId: f.id, name: f.name, role: inv.role, invitedBy: inv.invitedByName });
    }
  }
  res.json({ user: { sub, email, name }, families, invites });
});

// create a family — creator is always maintainer
app.post('/api/families', auth, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name' });
  const { sub, email, name: uname } = req.user;
  const id = crypto.randomUUID();
  db.families[id] = {
    id, name, creatorSub: sub, createdAt: Date.now(),
    members: { [sub]: { sub, email, name: uname, role: 'maintainer', status: 'active', joinedAt: Date.now() } },
    invitesByEmail: {},
    roleBundles: req.body.roleBundles || {}   // opaque wrapped {Kd,Kv} bundles per tier; server can't open them
  };
  db.objects[id] = {};
  persist();
  res.json(famSummary(db.families[id], sub));
});

// invite a google email with a role (maintainer only)
app.post('/api/families/:id/invite', auth, (req, res) => {
  const f = db.families[req.params.id];
  if (!f) return res.status(404).json({ error: 'no_family' });
  const m = f.members[req.user.sub];
  if (!m || m.role !== 'maintainer') return res.status(403).json({ error: 'not_maintainer' });
  const email = (req.body.email || '').toLowerCase().trim();
  const role = ['maintainer', 'viewer', 'custodian'].includes(req.body.role) ? req.body.role : 'viewer';
  if (!email) return res.status(400).json({ error: 'email' });
  if (Object.values(f.members).some(x => x.email === email)) return res.status(409).json({ error: 'already_member' });
  f.invitesByEmail[email] = { email, role, invitedByName: req.user.name, at: Date.now() };
  persist();
  pushInviteNotice(f, email);
  res.json({ ok: true });
});

// accept / decline an invite addressed to my email
app.post('/api/families/:id/accept', auth, (req, res) => {
  const f = db.families[req.params.id];
  if (!f) return res.status(404).json({ error: 'no_family' });
  const inv = f.invitesByEmail && f.invitesByEmail[req.user.email];
  if (!inv) return res.status(403).json({ error: 'no_invite' });
  f.members[req.user.sub] = { sub: req.user.sub, email: req.user.email, name: req.user.name, role: inv.role, status: 'active', joinedAt: Date.now() };
  delete f.invitesByEmail[req.user.email];
  persist();
  pushRoster(f.id);
  res.json(famSummary(f, req.user.sub));
});
app.post('/api/families/:id/decline', auth, (req, res) => {
  const f = db.families[req.params.id];
  if (f && f.invitesByEmail) { delete f.invitesByEmail[req.user.email]; persist(); }
  res.json({ ok: true });
});

// fetch the family's roster + every member's latest encrypted object (members only)
app.get('/api/families/:id/objects', auth, (req, res) => {
  const f = db.families[req.params.id];
  if (!f) return res.status(404).json({ error: 'no_family' });
  if (!f.members[req.user.sub]) return res.status(403).json({ error: 'not_member' });
  res.json({
    family: famSummary(f, req.user.sub),
    roleBundles: f.roleBundles || {},
    objects: db.objects[f.id] || {}
  });
});

// publish MY encrypted object (maintainer only) — version-checked
app.put('/api/families/:id/object', auth, (req, res) => {
  const f = db.families[req.params.id];
  if (!f) return res.status(404).json({ error: 'no_family' });
  const m = f.members[req.user.sub];
  if (!m) return res.status(403).json({ error: 'not_member' });
  if (m.role !== 'maintainer') return res.status(403).json({ error: 'read_only' });
  const v = Number(req.body.v);
  const ciphertext = req.body.ciphertext; // {iv, ct} — opaque to the server
  if (!Number.isFinite(v) || !ciphertext) return res.status(400).json({ error: 'bad_object' });
  if (!db.objects[f.id]) db.objects[f.id] = {};
  const cur = db.objects[f.id][req.user.sub];
  if (cur && v <= cur.v) return res.status(409).json({ error: 'stale', current: cur.v }); // VERSION CHECK
  db.objects[f.id][req.user.sub] = { v, ciphertext, name: m.name, email: m.email, role: m.role, updatedAt: Date.now() };
  persist();
  pushObject(f.id, req.user.sub, db.objects[f.id][req.user.sub]);
  res.json({ ok: true, v });
});

// ---- WebSocket live push ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map(); // ws -> { sub, email, families:Set }

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'auth') {
      try {
        const u = await verifyToken(msg.token);
        const fams = new Set(Object.values(db.families).filter(f => f.members[u.sub]).map(f => f.id));
        clients.set(ws, { sub: u.sub, email: u.email, families: fams });
        ws.send(JSON.stringify({ type: 'ready' }));
      } catch (e) {
        try { ws.send(JSON.stringify({ type: 'auth_error' })); ws.close(); } catch {}
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});

function pushObject(fid, ownerSub, obj) {
  for (const [ws, info] of clients) {
    if (info.families.has(fid)) {
      try { ws.send(JSON.stringify({ type: 'object', familyId: fid, ownerSub, v: obj.v, ciphertext: obj.ciphertext, name: obj.name, email: obj.email, role: obj.role })); } catch {}
    }
  }
}
function pushRoster(fid) {
  const f = db.families[fid]; if (!f) return;
  const roster = Object.values(f.members).map(m => ({ sub: m.sub, name: m.name, email: m.email, role: m.role }));
  for (const [ws, info] of clients) {
    if (f.members[info.sub]) { info.families.add(fid); try { ws.send(JSON.stringify({ type: 'roster', familyId: fid, members: roster })); } catch {} }
  }
}
function pushInviteNotice(f, email) {
  for (const [ws, info] of clients) {
    if (info.email === email) { try { ws.send(JSON.stringify({ type: 'invite', familyId: f.id, name: f.name })); } catch {} }
  }
}

server.listen(PORT, () => console.log('Tijori server on :' + PORT));