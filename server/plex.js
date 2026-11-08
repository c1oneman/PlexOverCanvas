// Plex integration: PIN sign-in against plex.tv, server discovery, and the
// handful of library endpoints the player needs. Plex tokens never leave the
// server; the browser only holds an opaque session cookie.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRODUCT = 'Canvas Stream PoC';
const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
// Optional: skip server discovery and talk to this server directly
// (e.g. http://192.168.1.10:32400).
const PLEX_URL = (process.env.PLEX_URL || '').replace(/\/+$/, '');
// Optional: comma-separated Plex usernames or emails allowed to sign in.
// Unset = any Plex account (fine on localhost, not on a public URL).
const ALLOWED_USERS = (process.env.ALLOWED_PLEX_USERS || '')
  .split(',').map(function (u) { return u.trim().toLowerCase(); }).filter(Boolean);

// ============================================================
// Persistent state: client identifier + sessions
// ============================================================
var state = { clientId: '', sessions: {} };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) {}
if (!state.clientId) state.clientId = crypto.randomUUID();
// Drop sessions for accounts that are no longer on the allowlist.
Object.keys(state.sessions).forEach(function (sid) {
  var u = state.sessions[sid].user;
  if (u && !isAllowed(u)) delete state.sessions[sid];
});
saveState();

function isAllowed(user) {
  if (!ALLOWED_USERS.length) return true;
  return [user.username, user.email].some(function (v) { return v && ALLOWED_USERS.indexOf(v.toLowerCase()) !== -1; });
}

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function parseCookies(header) {
  var out = {};
  String(header || '').split(';').forEach(function (part) {
    var i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// Returns the session for a request (Express req or raw upgrade req), or null.
function getSession(req) {
  var sid = parseCookies(req.headers.cookie).sid;
  return sid && state.sessions[sid] ? state.sessions[sid] : null;
}

function getOrCreateSession(req, res) {
  var sid = parseCookies(req.headers.cookie).sid;
  if (!sid || !state.sessions[sid]) {
    sid = crypto.randomBytes(24).toString('hex');
    state.sessions[sid] = { id: sid, createdAt: Date.now() };
    res.setHeader('Set-Cookie', 'sid=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000');
  }
  return state.sessions[sid];
}

// ============================================================
// HTTP helpers
// ============================================================
function plexHeaders(token) {
  var h = {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Client-Identifier': state.clientId,
    'X-Plex-Device-Name': PRODUCT,
    'X-Plex-Platform': 'Web',
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

async function plexFetch(url, opts) {
  opts = opts || {};
  var res = await fetch(url, {
    method: opts.method || 'GET',
    headers: Object.assign(plexHeaders(opts.token), opts.headers || {}),
    signal: AbortSignal.timeout(opts.timeout || 10000),
  });
  if (!res.ok) {
    var err = new Error('Plex request failed (' + res.status + ')');
    err.status = res.status;
    throw err;
  }
  return opts.raw ? res : res.json();
}

// ============================================================
// Sign-in (PIN flow)
// ============================================================
async function createPin(session, forwardUrl) {
  var pin = await plexFetch('https://plex.tv/api/v2/pins?strong=true', { method: 'POST' });
  session.pin = { id: pin.id, code: pin.code };
  saveState();
  var params = new URLSearchParams({
    clientID: state.clientId,
    code: pin.code,
    'context[device][product]': PRODUCT,
  });
  if (forwardUrl) params.set('forwardUrl', forwardUrl);
  return 'https://app.plex.tv/auth#?' + params.toString();
}

// Resolves true once the user has approved the PIN. Throws (status 403) if
// the account isn't on the allowlist; its token is discarded.
async function checkPin(session) {
  if (session.token) return true;
  if (!session.pin) return false;
  var pin = await plexFetch('https://plex.tv/api/v2/pins/' + session.pin.id);
  if (!pin.authToken) return false;
  delete session.pin;
  var user = await plexFetch('https://plex.tv/api/v2/user', { token: pin.authToken });
  var info = { username: user.username || user.title, email: user.email, thumb: user.thumb };
  if (!isAllowed(info)) {
    saveState();
    console.log('Rejected Plex sign-in from ' + info.username);
    var err = new Error('The Plex account "' + info.username + '" is not allowed on this server.');
    err.status = 403;
    throw err;
  }
  session.token = pin.authToken;
  session.user = info;
  saveState();
  return true;
}

function logout(session) {
  delete state.sessions[session.id];
  saveState();
}

// ============================================================
// Servers
// ============================================================
// baseUrl cache: "<sessionId>:<serverId>" -> { url, token }
var connCache = new Map();

async function listServers(session) {
  if (PLEX_URL) {
    var root = await plexFetch(PLEX_URL + '/', { token: session.token });
    var mc = root.MediaContainer || {};
    return [{ id: mc.machineIdentifier, name: mc.friendlyName || 'Plex', owned: true, connections: [{ uri: PLEX_URL }], accessToken: session.token }];
  }
  var resources = await plexFetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', { token: session.token });
  return resources
    .filter(function (r) { return String(r.provides || '').split(',').indexOf('server') !== -1; })
    .map(function (r) {
      return {
        id: r.clientIdentifier,
        name: r.name,
        owned: !!r.owned,
        online: r.presence,
        accessToken: r.accessToken || session.token,
        connections: r.connections || [],
      };
    });
}

// Probes every advertised connection at once and picks the best one that
// answers: local direct, then remote direct, then relay.
async function connect(session) {
  if (!session.serverId) throw new Error('No Plex server selected');
  var key = session.id + ':' + session.serverId;
  if (connCache.has(key)) return connCache.get(key);

  var servers = await listServers(session);
  var server = servers.find(function (s) { return s.id === session.serverId; });
  if (!server) throw new Error('Selected Plex server is not available');

  function rank(c) { return c.relay ? 2 : c.local ? 0 : 1; }
  var candidates = server.connections.slice().sort(function (a, b) { return rank(a) - rank(b); });
  var results = await Promise.all(candidates.map(function (c) {
    return plexFetch(c.uri + '/identity', { token: server.accessToken, timeout: 4000 })
      .then(function () { return c; }, function () { return null; });
  }));
  var ok = results.find(Boolean);
  if (!ok) throw new Error('Could not reach Plex server "' + server.name + '"');
  var conn = { url: ok.uri.replace(/\/+$/, ''), token: server.accessToken, name: server.name };
  connCache.set(key, conn);
  return conn;
}

function selectServer(session, serverId) {
  session.serverId = serverId;
  saveState();
}

// ============================================================
// Library
// ============================================================
async function serverGet(session, pathAndQuery) {
  var conn = await connect(session);
  return plexFetch(conn.url + pathAndQuery, { token: conn.token });
}

function summarize(m) {
  var media = m.Media && m.Media[0];
  return {
    key: m.ratingKey,
    parentKey: m.parentRatingKey,
    grandparentKey: m.grandparentRatingKey,
    type: m.type,
    title: m.title,
    parentTitle: m.parentTitle,
    grandparentTitle: m.grandparentTitle,
    index: m.index,
    parentIndex: m.parentIndex,
    year: m.year,
    summary: m.summary,
    thumb: m.thumb || m.parentThumb || m.grandparentThumb,
    grandparentThumb: m.grandparentThumb || m.parentThumb,
    art: m.art || m.grandparentArt,
    contentRating: m.contentRating,
    rating: m.audienceRating || m.rating,
    studio: m.studio,
    tagline: m.tagline,
    genres: (m.Genre || []).map(function (g) { return g.tag; }).slice(0, 3),
    resolution: media && media.videoResolution,
    childCount: m.childCount,
    duration: m.duration,
    viewOffset: m.viewOffset,
    leafCount: m.leafCount,
    viewedLeafCount: m.viewedLeafCount,
    viewCount: m.viewCount,
    playable: m.type === 'movie' || m.type === 'episode' || m.type === 'clip',
  };
}

async function libraries(session) {
  var data = await serverGet(session, '/library/sections');
  return (data.MediaContainer.Directory || [])
    .filter(function (d) { return d.type === 'movie' || d.type === 'show'; })
    .map(function (d) { return { key: d.key, title: d.title, type: d.type }; });
}

async function libraryItems(session, sectionKey, opts) {
  var q = new URLSearchParams({
    'X-Plex-Container-Start': String(opts.start || 0),
    'X-Plex-Container-Size': String(opts.size || 60),
    sort: opts.sort || 'titleSort',
  });
  if (opts.title) q.set('title', opts.title);
  var data = await serverGet(session, '/library/sections/' + sectionKey + '/all?' + q);
  var mc = data.MediaContainer;
  return { total: mc.totalSize != null ? mc.totalSize : mc.size, items: (mc.Metadata || []).map(summarize) };
}

async function onDeck(session) {
  var data = await serverGet(session, '/library/onDeck?X-Plex-Container-Size=20');
  return (data.MediaContainer.Metadata || []).map(summarize);
}

async function recentlyAdded(session) {
  var data = await serverGet(session, '/library/recentlyAdded?X-Plex-Container-Size=24');
  return (data.MediaContainer.Metadata || []).map(summarize);
}

async function search(session, query) {
  var q = new URLSearchParams({ query: query, limit: '12' });
  var data = await serverGet(session, '/hubs/search?' + q);
  var out = [];
  (data.MediaContainer.Hub || []).forEach(function (hub) {
    if (['movie', 'show', 'episode'].indexOf(hub.type) === -1) return;
    (hub.Metadata || []).forEach(function (m) { out.push(summarize(m)); });
  });
  return out;
}

// Reports playback position so Plex keeps On Deck and resume points current,
// and marks the item watched near the end.
async function timeline(session, opts) {
  var conn = await connect(session);
  var q = new URLSearchParams({
    ratingKey: opts.key,
    key: '/library/metadata/' + opts.key,
    state: opts.state,
    time: String(Math.round(opts.time)),
    duration: String(Math.round(opts.duration || 0)),
  });
  await plexFetch(conn.url + '/:/timeline?' + q, { token: conn.token, raw: true });
}

async function item(session, ratingKey) {
  var data = await serverGet(session, '/library/metadata/' + ratingKey);
  var m = (data.MediaContainer.Metadata || [])[0];
  if (!m) throw new Error('Item not found');
  var out = summarize(m);
  if (!out.playable) {
    var kids = await serverGet(session, '/library/metadata/' + ratingKey + '/children');
    out.children = (kids.MediaContainer.Metadata || []).map(summarize);
  }
  return out;
}

// Resolves a ratingKey to a direct file URL ffmpeg can read. The URL carries
// the token, so it must only ever be handed to child processes.
async function mediaUrl(session, ratingKey) {
  var conn = await connect(session);
  var data = await plexFetch(conn.url + '/library/metadata/' + ratingKey, { token: conn.token });
  var m = (data.MediaContainer.Metadata || [])[0];
  var part = m && m.Media && m.Media[0] && m.Media[0].Part && m.Media[0].Part[0];
  if (!part) throw new Error('No playable media for this item');
  return {
    url: conn.url + part.key + (part.key.indexOf('?') === -1 ? '?' : '&') + 'X-Plex-Token=' + encodeURIComponent(conn.token),
    duration: m.duration,
    title: m.grandparentTitle ? m.grandparentTitle + ' - ' + m.title : m.title,
  };
}

// Streams a resized poster through the server so the token stays private.
async function thumb(session, thumbPath, w, h) {
  var conn = await connect(session);
  var q = new URLSearchParams({ width: String(w), height: String(h), minSize: '1', upscale: '1', url: thumbPath, 'X-Plex-Token': conn.token });
  return plexFetch(conn.url + '/photo/:/transcode?' + q, { token: conn.token, raw: true, headers: { Accept: 'image/*' } });
}

module.exports = {
  getSession, getOrCreateSession, createPin, checkPin, logout,
  listServers, selectServer, connect,
  libraries, libraryItems, onDeck, recentlyAdded, search, timeline, item, mediaUrl, thumb,
};
