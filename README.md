# Canvas Stream PoC

A proof of concept for playing your **Plex** library in a browser **without a
`<video>` element**. Video is transcoded server-side to MPEG1, pushed over a
WebSocket and decoded in JavaScript by [JSMpeg](https://github.com/phoboslab/jsmpeg)
onto a `<canvas>`. Audio travels as MP2 in the same stream and plays through
WebAudio.

Use it where the native media pipeline is missing, restricted or unreliable:
embedded WebViews and kiosk browsers with few codecs, browsers without MSE or
WebCodecs, or places where you need control over every frame drawn.

It also includes a **probe** page that reports which media APIs, codecs and
rendering paths a browser exposes, and a **benchmark** page that measures
start-up time, A/V sync and latency.

## Architecture

```
                 ┌──────────────────────────────────┐
                 │             Browser              │
                 │                                  │
                 │  JSMpeg ─► MPEG1 ─► <canvas>     │
                 │         └► MP2  ─► WebAudio      │
                 └───────────────▲──────────────────┘
                                 │ WS (binary MPEG-TS)
                 ┌───────────────┴──────────────────┐
                 │        Node.js (Express)         │
                 │                                  │
                 │  Plex file ─► ffmpeg ─► MPEG-TS  │  (/ws/video)
                 │  sign-in, browse, posters        │  (/api/plex/*)
                 └───────────────▲──────────────────┘
                                 │ HTTP(S) + X-Plex-Token
                          Plex Media Server
```

Each viewer gets **one ffmpeg process** that reads the original file from Plex
(direct play, no Plex transcoder), and writes MPEG1 video and MP2 audio into one
MPEG-TS. It is killed when the client disconnects.

### Plex sign-in

Sign-in uses Plex's PIN flow, the same one third-party Plex apps use: the
server asks plex.tv for a PIN, the browser opens `app.plex.tv/auth` in a popup,
and the server polls until the user approves it. The resulting token is kept
**on the server** in `data/state.json` (mode 600, git-ignored); the browser only
gets an opaque `sid` cookie. Posters are proxied through the server for the
same reason.

Servers are discovered through `plex.tv/api/v2/resources`. Every advertised
connection is probed at once, and the first one that answers is used, in order
of preference: local, then remote, then relay. Set `PLEX_URL` to skip discovery
and use one server directly.

### Project layout

```
server/server.js        Express app: static files, streaming, Plex API routes, bench endpoints
server/plex.js          Plex sign-in, server discovery, library queries
public/index.html       Landing page
public/player/          Plex browser + canvas player
public/player/stream.js Shared client: starts a stream, reports status and metrics
public/bench/           A/V sync and latency benchmark
public/probe/           Browser capability probe
public/player/jsmpeg.min.js   @cycjimmy/jsmpeg-player v6.1.2 (MIT)
```

## Requirements

- Node.js 20.12+
- ffmpeg built with `mpeg1video`, `mp2` and `libmp3lame` (7.0+ for `-readrate_initial_burst`)
- A Plex account with access to at least one Plex Media Server

```bash
# macOS
brew install ffmpeg
# Debian/Ubuntu
sudo apt install ffmpeg
```

## Running

```bash
npm install
cp .env.example .env   # optional
npm start
```

Open `http://127.0.0.1:8742/player/`, click **Sign in with Plex**, and approve
the request in the popup. Pick a library, then a movie or episode.

The **Test pattern** and **A/V sync pattern** buttons play ffmpeg-generated
sources, with no Plex or network needed, to check the pipeline.

## Configuration

| Variable     | Default     | Description |
|--------------|-------------|-------------|
| `PORT`       | `8742`      | HTTP/WebSocket port |
| `HOST`       | `127.0.0.1` | Bind address. Set `0.0.0.0` to reach it from another device on your network |
| `FFMPEG`     | `ffmpeg`    | ffmpeg binary |
| `PLEX_URL`   | *(unset)*   | Use this Plex server directly (e.g. `http://192.168.1.10:32400`) instead of discovering servers via plex.tv |
| `ALLOWED_PLEX_USERS` | *(unset)* | Comma-separated Plex usernames or emails allowed to sign in. Unset allows any Plex account; **set it on anything public** |
| `AV_SYNC_MS` | `0`         | Muxed mode: delay video on the server by this much. Not needed with the bundled client, which syncs to the audio clock |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `WS`   | `/ws/video?src=<src>&quality=360\|480\|720\|1080&mode=muxed\|split&offset=<s>` | MPEG-TS as binary frames; status, info and metrics as JSON text frames |
| `GET`  | `/api/audio?src=<src>&offset=<s>` | Split mode only: MP3 audio stream (48 kbps, 22.05 kHz, mono) |
| `POST` | `/api/plex/pin`, `GET /api/plex/pin` | Start / poll Plex sign-in |
| `GET`  | `/api/plex/me` | Sign-in state |
| `POST` | `/api/plex/logout` | Forget this session's token |
| `GET`  | `/api/plex/servers`, `POST /api/plex/server` | List servers / select one |
| `GET`  | `/api/plex/libraries`, `/api/plex/library/:key`, `/api/plex/ondeck`, `/api/plex/item/:key` | Browse |
| `GET`  | `/api/plex/thumb?path=&w=&h=` | Resized poster, proxied |
| `GET`  | `/api/bench/:id` | When the ffmpeg processes for a bench run started |
| `POST` | `/api/bench-report` | Saves a bench report (JSON) under `bench-reports/` |
| `POST` | `/api/probe-report` | Saves a probe report (JSON) under `probe-reports/` |

`src` is `test`, `sync` or `plex:<ratingKey>`. Plex sources need a signed-in
session, and the media URL (which carries the token) is only ever handed to
ffmpeg as argv, never through a shell or to the browser.

`offset` starts playback that many seconds in. The player uses it for resume and
seeking: seeking restarts the stream at the new position.

Quality presets:

| Preset | Fits inside | Video bitrate (max) |
|--------|-------------|---------------------|
| 360    | 640×360     | 700k (875k)   |
| 480    | 854×480     | 1200k (1500k) |
| 720    | 1280×720    | 2200k (2750k) |
| 1080   | 1920×1080   | 4000k (5000k) |

Sources are scaled to fit without stretching and letter/pillarboxed, and keep
their own frame rate up to 30 fps (23.976 fps film stays 23.976).

## How it works

**Muxed mode (default).** ffmpeg reads the source at native rate, scales to the
preset, caps the frame rate at 30 fps and encodes MPEG1 with no B-frames (`-bf 0`) so every
frame can be decoded as soon as it arrives. Audio is encoded as 128 kbps MP2.
Both go into one MPEG-TS written to the WebSocket. JSMpeg demuxes and decodes in
JS, draws with WebGL (falling back to Canvas 2D), and plays the audio through
WebAudio.

In streaming mode JSMpeg does **not** pace or sync anything: it draws each
video frame the moment it arrives and queues audio to play right away. Frames
arrive in clumps (ffmpeg and the network both batch), so motion was uneven:
frame gaps had a median of 10 ms and a p95 of 84 ms at 24 fps.
`public/player/stream.js` replaces JSMpeg's streaming update with a playout
clock:

- Audio is scheduled **200 ms ahead** (`PAD`), and again after any underrun,
  which absorbs delivery jitter.
- Video frames are drawn when the **audio clock** (what is audible right now)
  reaches them, minus a measured 35 ms for MP2 encoder delay and output
  latency. Without audio, frames are paced on a wall clock at the stream's
  frame rate.

- The audio cushion adapts: it starts at 0.25 s, doubles after each underrun
  (up to 2 s), and is halved for the next stream after a calm minute.
  Underruns in the first 3 s of a stream (ffmpeg opening and seeking the file)
  aren't counted.
- JSMpeg's audio context runs at 44.1 kHz, the MP2 rate. In Chrome's default
  48 kHz context each 26 ms buffer was resampled separately, which measured as
  ~1.5 clicks per second on a pure tone; at 44.1 kHz there are none.

With that, frame gaps are 41.7 ms ± 1.4 ms at 23.976 fps (p95 43 ms, none over
52 ms), and the sync benchmark measures a 1 ms A/V offset. On the server side:

- `-pes_payload_size 0`: by default the TS muxer batches ~2.9 KB of audio per
  packet (~180 ms at 128 kbps). This sends each 26 ms MP2 frame as it is
  encoded.
- `-readrate_initial_burst 0`: ffmpeg 7+ reads the first 0.5 s as fast as it
  can. JSMpeg has no jitter buffer, so a burst just plays fast and gets audio
  dropped.
- Real rate control (`-b:v`/`-maxrate`/`-bufsize`, no fixed `-q:v`): a fixed
  quantizer let grainy sources reach 5 Mbit/s at 480p.
- `AV_SYNC_MS` (default 0) can still delay video on the server, for clients
  that don't pace against audio.

**Split mode (legacy).** The original design: video-only TS over the WebSocket,
and a second ffmpeg sending MP3 over HTTP into an `<audio>` element. The
browser buffers that stream for ~5 s before playing, and the two pipes have no
shared clock, so they drift apart. It is kept for comparison and for browsers
without WebAudio.

### Adaptive quality

The player's default quality is **Auto**:

- On sign-in it downloads 512 KB from `/api/speedtest` and caches the rate for
  10 minutes. Playback starts at the highest rung with 50% headroom
  (360p ≈ 1.1, 480p ≈ 1.8, 720p ≈ 3.2 Mbit/s worst case), up to 720p.
- Every 2 s it checks the stream's health. It steps **down** one rung after 2
  audio underruns within 30 s, when the server reports more than 2 s of
  unsent data (`backlog`), or when the device decodes video more than 0.5 s
  behind the audio.
- It steps **up** after 60 s without trouble (at most every 2 minutes) if a
  speed test run alongside the stream shows enough spare bandwidth.
- A switch restarts the stream at the current position at the new quality.

Picking a fixed quality in the player's settings turns Auto off.

### Loudness

Plex sources measured −24 to −33 LUFS (5.1 downmixes quietest), well under
the −14 to −16 streaming services use. The server runs audio through gentle
compression with makeup gain and a limiter, which brings them to about −15
to −18 LUFS with true peaks under −1.5 dBFS. `AUDIO_NORMALIZE=0` turns it off.

### Benchmark results

From `/bench/` with the `sync` source at 480p, Chrome on a Mac, server on the
same machine, 20 s runs:

| | Muxed, paced (current) | Muxed, unpaced | Split (legacy) |
|---|---:|---:|---:|
| First video frame | ~115 ms | ~120 ms | ~5.7 s |
| Audio latency | ~390 ms | ~210 ms | ~5.8 s |
| A/V offset, median (+ = audio late) | **1 ms** | +104 ms | swings ±1 s |
| A/V jitter (sd) | 0 ms | ~1 ms | ~490 ms |
| A/V drift | 2 ms/min | 13 ms/min | ~4 s/min |

The extra latency of the paced mode is the 200 ms jitter cushion, which doesn't
matter for on-demand video. Re-run the bench on your target device; if its
median isn't near zero, adjust `AUDIO_DELAY` in `stream.js`.

### Why MPEG1?

JSMpeg's decoder is small and fast because MPEG1 is simple. Compared with
sending individual JPEG/WebP frames, MPEG1 has inter-frame compression
(P-frames), so it needs much less bandwidth for the same frame rate:

| | JPEG frames | MPEG1 + JSMpeg |
|---|:---:|:---:|
| Inter-frame compression | No | Yes |
| GPU-assisted drawing | No | WebGL |
| Rough bandwidth at 480p30 | ~1.4 Mbps | ~0.8 Mbps |

## The benchmark (`/bench/`)

Plays a source in one or both modes and reports:

- **Start-up:** source resolve, ffmpeg first byte, WebSocket open, first video
  frame, first audio.
- **A/V offset, jitter and drift:** with the `sync` source, which flashes one
  of eight bars and plays a beep at a matching pitch (500–1200 Hz) at the start
  of every second. The page reads the canvas after each decoded frame, and an
  AudioWorklet runs Goertzel filters on the audio actually being played, timed
  with `getOutputTimestamp()` so output latency is included. The bar/pitch pair
  matches each flash to its beep even when audio is seconds late. The first two
  seconds are left out of the offset stats.
- **End-to-end latency:** against when the server started ffmpeg. Only
  meaningful when the server is on the same machine or the clocks are synced.

Other sources (`test`, `plex:<key>`) report start-up and FPS only. **Save
report** writes the raw runs, including each per-second pair, to
`bench-reports/`.

## The probe (`/probe/`)

Reports user agent and engine, hardware hints, API availability (WebSocket,
WebGL, MSE, WebCodecs, WebRTC, `requestVideoFrameCallback`, ...), codec support
via `canPlayType` and `MediaSource.isTypeSupported`, and the GPU renderer
string. Two interactive tests:

- **`<video>` playback**: records a short clip from an animated canvas, plays it
  in a `<video>` element and checks that `currentTime` advances. This catches
  browsers that block, pause or freeze native video.
- **Microphone**: calls `getUserMedia` and reports the result.

Nothing is sent to the server unless you press **Send report to server**.

## Limitations

- **Seeking restarts the stream.** There is no pause; seeking or resuming
  starts a new ffmpeg at that position, which takes a moment.
- **No watch-state sync.** Playback doesn't report progress back to Plex, so
  On Deck and resume points don't update.
- **First audio and video stream only.** No track or subtitle selection.
- **MPEG1 quality.** Expect visible blockiness at a given bitrate compared with
  H.264/VP9. Above 720p the bitrate and client CPU cost climb quickly.
- **Client CPU.** Decoding happens in JavaScript on the main thread. 720p30 is
  fine on a laptop; weak embedded hardware may drop frames at 480p.
- **Server CPU.** One ffmpeg transcode per viewer, with no sharing between
  viewers watching the same item. This is a PoC, not a broadcast server.
- **WebAudio needed for muxed mode.** Browsers without it get video only; use
  split mode there.
- **No access control beyond Plex sign-in.** It binds to `127.0.0.1` by default
  for a reason: anyone who can reach the server can sign in with their own Plex
  account and use your CPU. Put it behind a reverse proxy with TLS before
  exposing it.
- **HTTPS pages need WSS.** If you serve the page over HTTPS, the proxy must
  forward WebSocket upgrades (see below).
- **Autoplay policies.** Browsers only let audio start from a user gesture.
  Clicking a Play button counts.

## Hosting (Docker + Cloudflare Tunnel)

`deploy/docker-compose.yml` runs Canvas with host networking, bound to
`127.0.0.1`, and a `cloudflared` container that publishes it through a
Cloudflare Tunnel, so no ports are opened on the router. The image is Debian
trixie (Node 24, ffmpeg 7.1).

Host networking needs Docker on **Linux**. By default the app expects Plex on
the same machine (`http://127.0.0.1:32400`). If Plex is elsewhere, set
`PLEX_URL` in `deploy/.env`. **Set `ALLOWED_PLEX_USERS`**: left empty, any Plex
account can sign in.

Prepare the folders first. The app runs as user ID 1000 and `cloudflared` as
65532, so each needs write access:

```bash
cd deploy
cp .env.example .env      # set ALLOWED_PLEX_USERS
mkdir -p cloudflared data bench-reports
sudo chown 1000:1000 data bench-reports
chmod 777 cloudflared     # tightened again below
```

**LAN only, without Cloudflare:** set `HOST=0.0.0.0` in `.env`, start just the
app, and open `http://<server-ip>:8742/`. The only lock is then the Plex
allowlist, so keep this on a network you trust.

```bash
docker compose up -d --build canvas
```

**Public, through a Cloudflare Tunnel** (needs a domain on Cloudflare):

```bash
CF="docker run --rm -v $PWD/cloudflared:/home/nonroot/.cloudflared cloudflare/cloudflared:latest"
$CF tunnel login                          # opens a link to authorize your domain
$CF tunnel create my-tunnel
$CF tunnel route dns my-tunnel watch.example.com
cp cloudflared.example.yml cloudflared/config.yml   # fill in the tunnel id and hostname
chmod 755 cloudflared
docker compose up -d --build
```

To update after code changes: copy the project over and run
`docker compose up -d --build` again in `deploy/`.

Put a **Cloudflare Access** application in front of the hostname (Zero Trust →
Access → Applications → Self-hosted, policy: allow your email) so nobody else
can even load the page. The Plex allowlist is the second lock behind it.

## Reverse proxy (optional)

Apache:

```
ProxyPass / http://127.0.0.1:8742/
RewriteEngine On
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteCond %{HTTP:Connection} =upgrade [NC]
RewriteRule /(.*) ws://127.0.0.1:8742/$1 [P,L]
ProxyTimeout 300
```

nginx:

```
location / {
  proxy_pass http://127.0.0.1:8742;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 300s;
  proxy_buffering off;
}
```

## Credits

- Original two-pipe canvas streaming implementation by madpowah (MIT).
- [JSMpeg](https://github.com/phoboslab/jsmpeg) by Dominic Szablewski, packaged
  as [@cycjimmy/jsmpeg-player](https://github.com/cycjimmy/jsmpeg-player) (MIT).

## License

MIT
