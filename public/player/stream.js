// Starts a canvas stream and returns a handle to control it. Shared by the
// player and the benchmark. Needs jsmpeg.min.js loaded first.
//
// opts: canvas, audio (an <audio> element, split mode only), src, quality,
//       mode ('muxed' | 'split'), offset (seconds), bench (id), avsync (ms,
//       overrides the server default for muxed mode), buffer (initial audio
//       cushion in seconds, default 0.25), and callbacks
//       onStatus(text, isError), onMetric(name, value), onInfo(msg),
//       onFrame(), onEnd().
//
// Call it from a click handler: muxed mode creates its AudioContext
// synchronously, and browsers only let that start from a user gesture.
window.CanvasStream = function (opts) {
  var mode = opts.mode === 'split' ? 'split' : 'muxed';
  var noop = function () {};
  var onStatus = opts.onStatus || noop, onMetric = opts.onMetric || noop;
  var onInfo = opts.onInfo || noop, onFrame = opts.onFrame || noop, onEnd = opts.onEnd || noop;
  var na = opts.audio;
  var player = null, startTimer = null, stopped = false, errored = false;
  var t0 = performance.now();
  var firstFrame = false, firstAudio = false, onPlaying = null;
  var stats = { underruns: 0, bytes: [], backlog: 0, streamKbps: 0, lateFrames: 0 };

  var qs = 'src=' + encodeURIComponent(opts.src) +
    (opts.offset ? '&offset=' + Math.floor(opts.offset) : '') +
    (opts.bench ? '&bench=' + encodeURIComponent(opts.bench) : '') +
    (opts.avsync != null && opts.avsync !== '' ? '&avsync=' + parseInt(opts.avsync) : '');
  var wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host +
    '/ws/video?' + qs + '&quality=' + (opts.quality || 480) + '&mode=' + mode;

  function since() { return Math.round(performance.now() - t0); }

  // JSMpeg's MP2 decoder outputs 44.1 kHz. In a 48 kHz context (Chrome's
  // usual default) each 26 ms buffer is resampled separately, which left an
  // audible click at roughly 1.5 joins per second; a 44.1 kHz context has
  // none. JSMpeg reuses whatever context is cached here.
  function useNativeRateContext() {
    var WA = JSMpeg.AudioOutput && JSMpeg.AudioOutput.WebAudio;
    if (!WA || (WA.CachedContext && WA.CachedContext.sampleRate === 44100)) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx({ sampleRate: 44100 });
      if (WA.CachedContext && !WA.CachedContext._connections) WA.CachedContext.close().catch(noop);
      if (!WA.CachedContext || !WA.CachedContext._connections) WA.CachedContext = ctx;
      else ctx.close();
    } catch (e) {} // older browsers: fall back to the default rate
  }

  function startVideo() {
    if (player || stopped) return;
    clearInterval(startTimer);
    onStatus('Connecting...');
    if (mode === 'muxed') useNativeRateContext();
    player = new JSMpeg.Player(wsUrl, {
      canvas: opts.canvas, audio: mode === 'muxed', streaming: true,
      maxBufferSize: 1024 * 1024, videoBufferSize: 1024 * 1024, audioBufferSize: 256 * 1024,
      pauseWhenHidden: false, preserveDrawingBuffer: true, reconnectInterval: 0,
      onVideoDecode: function () {
        if (!firstFrame) { firstFrame = true; onMetric('firstFrameMs', since()); }
        onFrame();
      },
      onAudioDecode: function () {
        if (!firstAudio) { firstAudio = true; onMetric('firstAudioDecodeMs', since()); }
      },
    });
    if (player.audioOut && player.audioOut.context) {
      var ctx = player.audioOut.context;
      if (ctx.state === 'suspended') ctx.resume().catch(noop);
      player.audioOut.unlock();
    }
    player.updateForStreaming = pacedUpdate;
    if (player.audioOut) padAudio(player.audioOut);
    // The server sends status/metrics as JSON text frames on the same socket.
    // JSMpeg would feed them to the demuxer, so intercept them and only pass
    // binary frames through. With audio enabled JSMpeg opens the socket later
    // (after its decoders load), so hook whenever start() actually runs.
    var source = player.source;
    if (source.socket) hookSocket(source.socket);
    else {
      var start = source.start;
      source.start = function () { start.apply(source, arguments); hookSocket(source.socket); };
    }
  }

  // JSMpeg's own streaming update draws each video frame the moment it
  // arrives, so uneven delivery (ffmpeg and the network deliver frames in
  // clumps) shows as uneven motion. This replacement keeps a short playout
  // buffer and draws each frame when it is due:
  //   - with audio: when the audio clock (what is audible now) reaches the
  //     frame's time, so video follows audio exactly;
  //   - without audio: on a wall clock at the stream's frame rate.
  // Called by JSMpeg once per animation frame, with `this` = the player.
  // Seconds of audio queued ahead to absorb delivery jitter. Doubles after
  // each underrun (up to MAX_PAD); the caller can carry it to the next stream.
  var PAD = Math.max(0.1, Math.min(+opts.buffer || 0.25, 2));
  var MAX_PAD = 2;
  var MAX_PER_TICK = 4;    // frames to decode in one tick when catching up
  // Audio reaches the ear this much after the clock below says it does (MP2
  // encoder delay + output latency); measured with /bench/ as ~39 ms.
  var AUDIO_DELAY = 0.035;
  var audioPrimed = false, primedAt = 0, wallStart = 0, wallFrames = 0;
  // A new stream often hiccups once while ffmpeg opens and seeks the file;
  // rebuffers this soon after the start aren't held against the connection.
  var STARTUP_GRACE = 3;
  function nowS() { return performance.now() / 1000; }

  // Whenever audio is scheduled into an empty queue (the first buffer, or
  // after an underrun), start it PAD seconds ahead instead of right now.
  function padAudio(out) {
    var play = out.play;
    out.play = function () {
      if (out.enabled && out.unlocked && out.startTime < out.context.currentTime + 0.005) {
        if (audioPrimed && nowS() - primedAt > STARTUP_GRACE) {
          // Ran dry: data isn't keeping up. Rebuffer with a bigger cushion.
          stats.underruns++;
          PAD = Math.min(PAD * 2, MAX_PAD);
          onMetric('underrun', stats.underruns);
        }
        out.startTime = out.context.currentTime + PAD;
        out.wallclockStartTime = nowS() + PAD;
      }
      if (!audioPrimed) primedAt = nowS();
      audioPrimed = true;
      return play.apply(out, arguments);
    };
  }

  function pacedUpdate() {
    var a = this.audio, out = this.audioOut, v = this.video;

    if (a && out) {
      // Decode all audio that has arrived, dropping it if the queue grows
      // far past the cushion (e.g. after a long stall).
      var more;
      do {
        if (out.enqueuedTime > PAD + 1) { out.resetEnqueuedTime(); out.enabled = false; }
        more = a.decode();
      } while (more);
      out.enabled = true;
    }

    if (!v) return;
    var n = 0;
    if (a && audioPrimed) {
      // Audio clock: media time currently coming out of the speakers.
      var clock = a.decodedTime - out.enqueuedTime - AUDIO_DELAY;
      while (n < MAX_PER_TICK && v.decodedTime <= clock && v.decode()) n++;
      // Video more than half a second behind the audio: this device can't
      // decode fast enough at this quality.
      if (clock - v.decodedTime > 0.5) stats.lateFrames++;
    } else if (!a) {
      var fps = v.frameRate || 30;
      if (!wallStart) wallStart = nowS() + PAD;
      var due = Math.floor((nowS() - wallStart) * fps) + 1;
      // Fell far behind (stall): restart the clock instead of fast-forwarding.
      if (due - wallFrames > fps) { wallStart = nowS() - wallFrames / fps; due = wallFrames + 1; }
      while (n < MAX_PER_TICK && wallFrames < due && v.decode()) { n++; wallFrames++; }
    }
  }

  function hookSocket(ws) {
    if (ws) {
      var toDecoder = ws.onmessage;
      ws.onmessage = function (e) {
        if (typeof e.data !== 'string') {
          stats.bytes.push([performance.now(), e.data.byteLength]);
          return toDecoder(e);
        }
        try {
          var m = JSON.parse(e.data);
          if (m.type === 'metric') {
            if (m.message === 'backlog') stats.backlog = m.value;
            else if (m.message === 'streamKbps') stats.streamKbps = m.value;
            onMetric(m.message, m.value);
          }
          else if (m.type === 'info') onInfo(m);
          else { if (m.type === 'error') errored = true; onStatus(m.message, m.type === 'error'); }
        } catch (err) {}
      };
      ws.addEventListener('open', function () { onMetric('wsOpenMs', since()); });
      ws.addEventListener('close', function () { if (!stopped) onEnd(errored); });
    }
  }

  if (mode === 'split' && na) {
    // Audio: plain MP3 over HTTP into a native <audio> element.
    na.preload = 'none';
    na.src = '/api/audio?' + qs + '&_=' + Date.now();
    na.load();
    onPlaying = function () {
      na.removeEventListener('playing', onPlaying);
      onMetric('firstAudioPlayingMs', since());
    };
    na.addEventListener('playing', onPlaying);
    (function tryPlay() { if (!stopped) na.play().catch(function () { setTimeout(tryPlay, 200); }); })();
    // Video: start once audio is flowing so the two pipes begin close
    // together; give up waiting after 10s and start video alone.
    onStatus('Buffering audio...');
    var waited = 0;
    startTimer = setInterval(function () {
      waited += 100;
      if ((na.readyState >= 2 && na.currentTime > 0) || waited >= 10000) startVideo();
    }, 100);
  } else {
    startVideo();
  }

  return {
    mode: mode,
    get player() { return player; },
    // The node audio passes through, for the benchmark to tap.
    audioNode: function () { return player && player.audioOut ? player.audioOut.gain : null; },
    setVolume: function (v) {
      if (mode === 'muxed') { if (player) player.volume = v; }
      else if (na) na.volume = v;
    },
    // Playback health for adaptive quality: underruns so far, audio queued
    // (s), the current cushion (s), receive rate over the last 5 s (kbit/s),
    // seconds of data stuck on the server, and ticks spent decoding behind.
    health: function () {
      var now = performance.now(), cut = now - 5000;
      while (stats.bytes.length && stats.bytes[0][0] < cut) stats.bytes.shift();
      var bytes = stats.bytes.reduce(function (t, b) { return t + b[1]; }, 0);
      var span = stats.bytes.length ? Math.max(1000, now - Math.max(cut, t0)) : 5000;
      var out = player && player.audioOut;
      return {
        underruns: stats.underruns,
        queued: out ? out.enqueuedTime : 0,
        buffer: PAD,
        kbps: Math.round(bytes * 8 / span),
        backlogS: stats.streamKbps ? stats.backlog * 8 / 1000 / stats.streamKbps : 0,
        lateFrames: stats.lateFrames,
      };
    },
    nudgeAudio: function (s) { if (mode === 'split' && na) try { na.currentTime += s; } catch (e) {} },
    stop: function () {
      stopped = true;
      clearInterval(startTimer);
      if (player) { try { player.destroy(); } catch (e) {} player = null; }
      if (na) { na.removeEventListener('playing', onPlaying); na.pause(); na.removeAttribute('src'); na.load(); }
    },
  };
};
