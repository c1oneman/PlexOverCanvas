const express = require('express');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const plex = require('./plex');

const PORT = process.env.PORT || 8742;
const HOST = process.env.HOST || '127.0.0.1';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
// Muxed mode: hold video back this long when it is sent. The client paces
// video against the audio clock, so this is normally 0; it is kept as a
// knob for clients that don't. Tune with /bench/.
const AV_SYNC_MS = parseInt(process.env.AV_SYNC_MS || '0', 10);
// Gentle compression + makeup gain + limiter. Sources measured -24 to -33
// LUFS (5.1 downmixes are quietest); this brings them to about -15 to -18
// LUFS with true peaks under -1.5 dBFS, and adds no meaningful latency.
// Set AUDIO_NORMALIZE=0 to pass audio through unchanged.
const AUDIO_FILTER = process.env.AUDIO_NORMALIZE === '0' ? '' :
  'acompressor=threshold=0.05:ratio=4:attack=5:release=300:makeup=6,' +
  'alimiter=limit=0.79:attack=5:release=50:level=disabled';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const REPORTS_DIR = path.join(__dirname, '..', 'probe-reports');
const BENCH_DIR = path.join(__dirname, '..', 'bench-reports');

// Target bitrate per preset; the encoder may burst to 1.25x on hard scenes.
const QUALITY = {
  360: { scale: '640:360', kbps: 700 },
  480: { scale: '854:480', kbps: 1200 },
  720: { scale: '1280:720', kbps: 2200 },
  1080: { scale: '1920:1080', kbps: 4000 },
};

const app = express();
// Behind cloudflared/nginx on this machine: trust X-Forwarded-Proto so the
// Plex sign-in redirect goes back to the https URL.
app.set('trust proxy', 'loopback');
app.get('/', (req, res) => res.redirect('/player/'));

// The player page links its scripts and styles with a content hash
// (app.js?v=…), so a deploy reaches every browser on its next page load even
// where a CDN or browser has cached the old files. The page itself is sent
// with no-cache. Computed once at startup; files only change on deploy.
const PLAYER_DIR = path.join(PUBLIC_DIR, 'player');
const PLAYER_ASSETS = ['app.js', 'app.css', 'stream.js', 'jsmpeg.min.js'];
const playerPage = (() => {
  var html = fs.readFileSync(path.join(PLAYER_DIR, 'index.html'), 'utf8');
  PLAYER_ASSETS.forEach((name) => {
    var hash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(PLAYER_DIR, name))).digest('hex').slice(0, 10);
    html = html.split('"' + name + '"').join('"' + name + '?v=' + hash + '"');
  });
  return html;
})();
app.get(['/player/', '/player/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(playerPage);
});
// Revalidate on every load (unchanged files answer 304), so a deploy reaches
// browsers right away instead of after their heuristic cache expires.
app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.use(express.json({ limit: '1mb' }));

// ============================================================
// Source resolution
// ============================================================
// A source is one of:
//   "test"           ffmpeg's test pattern + tone (no network needed)
//   "sync"           a flash + beep every second, for the A/V benchmark
//   "tone"           a steady 440 Hz sine, for finding audio glitches
//   "plex:<key>"     a Plex item by ratingKey (needs a signed-in session)
// Arguments are always passed to child processes as argv, never through a shell.
async function resolveSource(src, session) {
  if (src === 'test' || src === 'sync' || src === 'tone') return { generator: src };
  var m = /^plex:(\d+)$/.exec(src);
  if (!m) throw new Error('Unknown source');
  if (!session || !session.token) throw new Error('Sign in to Plex first');
  return plex.mediaUrl(session, m[1]);
}

// The "sync" source flashes one of 8 vertical bars and plays a beep whose
// pitch matches the bar (500 Hz + 100 Hz * bar) for 150 ms at the start of
// every second. The bar/pitch pair lets the benchmark match each flash to its
// beep even when audio lags by several seconds.
function syncVideoFilter(size) {
  var w = size[0] / 8;
  var f = 'color=c=black:s=' + size.join('x') + ':r=30';
  for (var i = 0; i < 8; i++) {
    f += ',drawbox=x=' + (i * w) + ':y=0:w=' + w + ':h=' + size[1] +
      ":color=white:t=fill:enable='eq(mod(floor(t),8)," + i + ")*lt(mod(t,1),0.15)'";
  }
  return f;
}
const SYNC_AUDIO = "aevalsrc='if(lt(mod(t,1),0.15),0.8*sin(2*PI*(500+100*mod(floor(t),8))*t),0)':s=44100:c=stereo";

// Read at native rate. ffmpeg 7+ bursts the first 0.5 s by default; JSMpeg
// has no jitter buffer and plays whatever arrives, so a burst only plays
// fast and gets audio dropped.
const PACE = ['-re', '-readrate_initial_burst', '0'];

// kind is 'video', 'audio' or 'both': each pipe only opens the input it needs.
function inputArgs(source, kind, offset) {
  if (source.generator) {
    // Generators are paced with the realtime filters: -re lets lavfi run
    // ~0.4 s ahead of the wall clock, which skews the benchmark's latency.
    var v = (source.generator === 'sync' ? syncVideoFilter([1280, 720]) : 'testsrc2=size=1280x720:rate=30') + ',realtime';
    var a = (source.generator === 'sync' ? SYNC_AUDIO
      : source.generator === 'tone' ? "aevalsrc='0.5*sin(2*PI*440*t)':s=44100:c=stereo"
      : 'sine=frequency=440:beep_factor=4') + ',arealtime';
    var args = [];
    if (kind !== 'audio') args.push('-f', 'lavfi', '-i', v);
    if (kind !== 'video') args.push('-f', 'lavfi', '-i', a);
    if (kind === 'both') args.push('-map', '0:v', '-map', '1:a');
    return args;
  }
  var out = [...PACE, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30'];
  if (offset > 0) out.push('-ss', String(offset));
  out.push('-i', source.url);
  if (kind === 'both') out.push('-map', '0:v:0', '-map', '0:a:0?');
  return out;
}

// Scale to fit the preset without stretching, letterboxing/pillarboxing the
// rest, so 4:3 or 2.39:1 sources keep their shape on the fixed-size canvas.
function fitFilter(scale) {
  var wh = scale.split(':');
  return 'scale=' + scale + ':force_original_aspect_ratio=decrease:force_divisible_by=2,' +
    'pad=' + wh[0] + ':' + wh[1] + ':(ow-iw)/2:(oh-ih)/2,setsar=1';
}

function parseOffset(v) {
  var n = parseFloat(v);
  return isFinite(n) && n > 0 ? n : 0;
}

// ============================================================
// Benchmark bookkeeping: when each ffmpeg was spawned, keyed by the
// client-chosen bench id, so the bench page can compute end-to-end latency.
// ============================================================
const benchRuns = new Map();
function benchMark(id, kind) {
  if (!id) return;
  var run = benchRuns.get(id) || { createdAt: Date.now() };
  run[kind + 'SpawnAt'] = Date.now();
  benchRuns.set(id, run);
  for (const [k, r] of benchRuns) if (Date.now() - r.createdAt > 10 * 60 * 1000) benchRuns.delete(k);
}

app.get('/api/bench/:id', (req, res) => res.json(benchRuns.get(req.params.id) || {}));

app.post('/api/bench-report', (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(BENCH_DIR, `bench-${timestamp}.json`);
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(req.body || {}, null, 2));
  console.log(`Bench report saved: ${filename}`);
  res.json({ ok: true, file: path.relative(path.join(__dirname, '..'), filename) });
});

// ============================================================
// PROBE: diagnostic report receiver
// ============================================================
app.post('/api/probe-report', (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(REPORTS_DIR, `probe-${timestamp}.json`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(req.body || {}, null, 2));
  console.log(`Probe report saved: ${filename}`);
  res.json({ ok: true });
});

// ============================================================
// PLEX: sign-in and library browsing
// ============================================================
function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    res.status(e.status === 401 || e.status === 403 ? e.status : 502).json({ error: e.message });
  });
}

function requireLogin(req, res, next) {
  var s = plex.getSession(req);
  if (!s || !s.token) return res.status(401).json({ error: 'Not signed in' });
  req.plex = s;
  next();
}

function requireServer(req, res, next) {
  if (!req.plex.serverId) return res.status(409).json({ error: 'No Plex server selected' });
  next();
}

app.post('/api/plex/pin', wrap(async (req, res) => {
  var session = plex.getOrCreateSession(req, res);
  var forward = req.protocol + '://' + req.get('host') + '/player/?signedin=1';
  res.json({ authUrl: await plex.createPin(session, forward) });
}));

app.get('/api/plex/pin', wrap(async (req, res) => {
  var s = plex.getSession(req);
  try { res.json({ done: s ? await plex.checkPin(s) : false }); }
  catch (e) { if (e.status === 403) return res.json({ done: false, error: e.message }); throw e; }
}));

app.get('/api/plex/me', wrap(async (req, res) => {
  var s = plex.getSession(req);
  // Finishes a pending PIN when sign-in came back via redirect, not the popup.
  var error;
  if (s && !s.token && s.pin) await plex.checkPin(s).catch((e) => { if (e.status === 403) error = e.message; });
  if (!s || !s.token) return res.json({ signedIn: false, error });
  res.json({ signedIn: true, user: s.user, serverId: s.serverId || null });
}));

app.post('/api/plex/logout', (req, res) => {
  var s = plex.getSession(req);
  if (s) plex.logout(s);
  res.json({ ok: true });
});

app.get('/api/plex/servers', requireLogin, wrap(async (req, res) => {
  var servers = await plex.listServers(req.plex);
  res.json(servers.map((s) => ({ id: s.id, name: s.name, owned: s.owned, online: s.online })));
}));

app.post('/api/plex/server', requireLogin, wrap(async (req, res) => {
  plex.selectServer(req.plex, String(req.body.id || ''));
  var conn = await plex.connect(req.plex);
  res.json({ ok: true, name: conn.name });
}));

app.get('/api/plex/libraries', requireLogin, requireServer, wrap(async (req, res) => {
  res.json(await plex.libraries(req.plex));
}));

app.get('/api/plex/library/:key', requireLogin, requireServer, wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.key)) return res.status(400).json({ error: 'Bad key' });
  res.json(await plex.libraryItems(req.plex, req.params.key, {
    start: parseInt(req.query.start) || 0,
    title: req.query.title ? String(req.query.title) : '',
  }));
}));

app.get('/api/plex/ondeck', requireLogin, requireServer, wrap(async (req, res) => {
  res.json(await plex.onDeck(req.plex));
}));

app.get('/api/plex/home', requireLogin, requireServer, wrap(async (req, res) => {
  var both = await Promise.all([plex.onDeck(req.plex), plex.recentlyAdded(req.plex)]);
  res.json({ onDeck: both[0], recent: both[1] });
}));

// Incompressible bytes for the client's bandwidth estimate.
const SPEEDTEST_BLOCK = require('crypto').randomBytes(64 * 1024);
app.get('/api/speedtest', requireLogin, (req, res) => {
  var kb = Math.max(16, Math.min(4096, parseInt(req.query.kb) || 256));
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': kb * 1024, 'Cache-Control': 'no-store' });
  for (var i = 0; i < kb / 64; i++) res.write(SPEEDTEST_BLOCK.subarray(0, Math.min(64, kb - i * 64) * 1024));
  res.end();
});

app.get('/api/plex/search', requireLogin, requireServer, wrap(async (req, res) => {
  var q = String(req.query.q || '').trim().slice(0, 100);
  res.json(q ? await plex.search(req.plex, q) : []);
}));

app.post('/api/plex/timeline', requireLogin, requireServer, wrap(async (req, res) => {
  var b = req.body || {};
  if (!/^\d+$/.test(String(b.key)) || ['playing', 'paused', 'stopped'].indexOf(b.state) === -1) {
    return res.status(400).json({ error: 'Bad timeline update' });
  }
  await plex.timeline(req.plex, { key: String(b.key), state: b.state, time: +b.time || 0, duration: +b.duration || 0 });
  res.json({ ok: true });
}));

app.get('/api/plex/item/:key', requireLogin, requireServer, wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.key)) return res.status(400).json({ error: 'Bad key' });
  res.json(await plex.item(req.plex, req.params.key));
}));

app.get('/api/plex/thumb', requireLogin, requireServer, wrap(async (req, res) => {
  var p = String(req.query.path || '');
  if (!/^\/library\/[\w/.-]+$/.test(p)) return res.status(400).end();
  var w = Math.min(parseInt(req.query.w) || 200, 800);
  var h = Math.min(parseInt(req.query.h) || 300, 1200);
  var upstream = await plex.thumb(req.plex, p, w, h);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  Readable.fromWeb(upstream.body).pipe(res);
}));

// ============================================================
// AUDIO (split mode): low-bitrate MP3 over plain HTTP
// ============================================================
app.get('/api/audio', async (req, res) => {
  var source;
  try { source = await resolveSource(String(req.query.src || ''), plex.getSession(req)); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
  });
  var args = inputArgs(source, 'audio', parseOffset(req.query.offset));
  args.push(
    '-vn', '-fflags', 'nobuffer', '-flags', 'low_delay',
    ...(AUDIO_FILTER && !source.generator ? ['-af', AUDIO_FILTER] : []),
    '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '22050', '-ac', '1',
    '-f', 'mp3', '-'
  );
  benchMark(req.query.bench, 'audio');
  const ffmpeg = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  ffmpeg.stdout.pipe(res);
  ffmpeg.on('error', () => { try { res.end(); } catch (e) {} });
  ffmpeg.on('exit', () => { try { res.end(); } catch (e) {} });
  req.on('close', () => ffmpeg.kill('SIGKILL'));
});

// ============================================================
// VIDEO: MPEG1-TS over WebSocket, decoded client-side by JSMpeg.
// mode=muxed (default) also carries MP2 audio in the same TS, which JSMpeg
// plays through WebAudio on the same clock as the video.
// mode=split sends video only; audio comes from /api/audio.
// ============================================================
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

const server = app.listen(PORT, HOST, () => {
  console.log(`Canvas stream PoC on http://${HOST}:${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  if (url.parse(req.url).pathname === '/ws/video') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

function send(ws, type, message, extra) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ type, message }, extra))); } catch (e) {}
}

wss.on('connection', async (ws, req) => {
  const q = url.parse(req.url, true).query;
  const preset = QUALITY[parseInt(q.quality)] || QUALITY[720];
  const muxed = q.mode !== 'split';
  const avSync = muxed ? Math.max(0, Math.min(2000, q.avsync != null && q.avsync !== '' ? parseInt(q.avsync) || 0 : AV_SYNC_MS)) : 0;
  const t0 = Date.now();

  send(ws, 'status', 'Resolving source...');
  var source;
  try { source = await resolveSource(String(q.src || ''), plex.getSession(req)); }
  catch (err) { send(ws, 'error', err.message); return ws.close(); }
  if (ws.readyState !== 1) return;
  send(ws, 'metric', 'resolveMs', { value: Date.now() - t0 });
  send(ws, 'metric', 'avSyncMs', { value: avSync });
  if (source.duration) send(ws, 'info', source.title, { duration: source.duration });

  send(ws, 'status', 'Starting stream...');
  var args = inputArgs(source, muxed ? 'both' : 'video', parseOffset(q.offset));
  // Delaying video timestamps makes the TS muxer (which interleaves by
  // timestamp) send each frame avSync ms after its audio.
  // Real rate control (a fixed -q:v let grainy sources hit 5 Mbit/s at
  // 480p). Keep the source frame rate up to 30 fps: forcing 30 duplicated
  // every 4th frame of 23.976 fps film, which judders.
  var maxKbps = Math.round(preset.kbps * 1.25);
  args.push('-c:v', 'mpeg1video', '-b:v', preset.kbps + 'k', '-maxrate', maxKbps + 'k',
    '-bufsize', maxKbps + 'k', '-qmin', '2', '-bf', '0',
    '-vf', (avSync ? 'setpts=PTS+' + avSync / 1000 + '/TB,' : '') + "fps='min(source_fps,30)'," + fitFilter(preset.scale));
  // JSMpeg queues audio for playback as it arrives, so A/V sync depends on
  // audio arriving with its video. The TS muxer normally batches ~2.9 KB of
  // audio per PES packet (~180 ms at 128k), which made audio lag by that much;
  // -pes_payload_size 0 sends each MP2 frame (~26 ms) as soon as it's encoded.
  if (muxed) {
    if (AUDIO_FILTER && !source.generator) args.push('-af', AUDIO_FILTER);
    args.push('-c:a', 'mp2', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-pes_payload_size', '0');
  }
  else args.push('-an');
  args.push('-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-');

  // Total stream bitrate ceiling, so the client can turn backlog bytes into seconds.
  send(ws, 'metric', 'streamKbps', { value: maxKbps + (muxed ? 128 : 0) });

  benchMark(q.bench, 'video');
  const spawnAt = Date.now();
  // Bytes queued here because the client or network can't keep up; the
  // client uses it to step quality down.
  const backlogTimer = setInterval(() => send(ws, 'metric', 'backlog', { value: ws.bufferedAmount }), 1000);
  const ffmpeg = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  var first = true;

  ffmpeg.stdout.on('data', (chunk) => {
    if (first) { first = false; send(ws, 'metric', 'ffmpegFirstByteMs', { value: Date.now() - spawnAt }); }
    if (ws.readyState === 1) ws.send(chunk);
  });
  ffmpeg.on('error', (e) => { send(ws, 'error', e.message.slice(0, 100)); ws.close(); });
  ffmpeg.on('close', (code) => {
    if (code) send(ws, 'status', 'Stream ended (code ' + code + ')');
    try { ws.close(); } catch (e) {}
  });
  ws.on('close', () => { clearInterval(backlogTimer); try { ffmpeg.kill('SIGKILL'); } catch (e) {} });
});
