import { Router } from "express";
import type { IncomingMessage } from "http";
import { checkSubscriptionToken, getTrialInfo } from "../lib/session-store.js";

const TRIAL_COOKIE = "pc_trial";

function canAccessContent(req: Parameters<Parameters<typeof Router.prototype.get>[1]>[0]): boolean {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const sub = checkSubscriptionToken(token);
    if (sub.valid) return true;
  }
  const trialId = (req.cookies as Record<string, string>)?.[TRIAL_COOKIE];
  const trial = getTrialInfo(trialId);
  return trial.freePlaysRemaining > 0;
}

const router = Router();

const ALL_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "https://opentracker.i2p.rocks:443/announce",
];

const YTS_MIRRORS = [
  "https://yts.mx",
  "https://yts.pm",
  "https://yts.torrent.wtf",
  "https://api.yts.nz",
];

const EZTV_MIRRORS = [
  "https://eztvx.to",
  "https://eztv.re",
  "https://eztv.tf",
];

const QUALITY_ORDER = ["1080p", "720p", "480p", "360p", "sd"];
const MIN_SEEDS = 5;

function is4K(text: string): boolean {
  return /\b(2160p|4[Kk]|UHD)\b/i.test(text);
}

function rankQuality(raw: string): number {
  const q = raw.toLowerCase();
  for (let i = 0; i < QUALITY_ORDER.length; i++) {
    if (q.includes(QUALITY_ORDER[i])) return i;
  }
  return 99;
}

function hybridSort(
  a: { seeds: number; quality: string },
  b: { seeds: number; quality: string },
): number {
  const qd = rankQuality(a.quality) - rankQuality(b.quality);
  if (qd !== 0) return qd;
  return b.seeds - a.seeds;
}

function buildMagnet(hash: string, name: string): string {
  const trackers = ALL_TRACKERS.map(encodeURIComponent).join("&tr=");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}&tr=${trackers}`;
}

function addWebTrackers(magnet: string): string {
  const extra = ALL_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return magnet + extra;
}

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json",
};

interface TorrentResult {
  magnet: string;
  label: string;
  seeds: number;
  quality: string;
}

interface TDBStream {
  infoHash?: string; name?: string; title?: string;
  seeders?: number; seeds?: number; quality?: string;
  behaviorHints?: { filename?: string };
}

async function fetchTorrentsDB(imdbId: string): Promise<TorrentResult | null> {
  try {
    const resp = await fetch(`https://torrentsdb.com/stream/movie/${imdbId}.json`, {
      signal: AbortSignal.timeout(10000), headers: FETCH_HEADERS,
    });
    if (!resp.ok) return null;
    const json = await resp.json() as { streams?: TDBStream[] };
    const streams = (json?.streams ?? []).filter((s) => !!s.infoHash);
    if (!streams.length) return null;

    const enriched = streams
      .map((s) => {
        const seeds = s.seeders ?? s.seeds ?? 0;
        const rawText = [s.quality ?? "", s.name ?? "", s.title ?? ""].join(" ");
        const qm = rawText.match(/\b(2160p|4K|1080p|720p|480p|360p)\b/i);
        const quality = qm ? qm[1] : "SD";
        const isMp4 = /\.mp4$/i.test(s.behaviorHints?.filename ?? s.name ?? "");
        return { stream: s, seeds, quality, isMp4 };
      })
      .filter((x) => !is4K(x.quality))
      .filter((x) => x.seeds >= MIN_SEEDS);

    if (!enriched.length) return null;
    enriched.sort(hybridSort);

    const best = enriched[0];
    return {
      magnet: buildMagnet(best.stream.infoHash!, best.stream.name ?? "Movie"),
      label: `${best.quality} · ${best.seeds} Seeds`,
      seeds: best.seeds,
      quality: best.quality,
    };
  } catch { return null; }
}

async function fetchYTS(imdbId: string, title: string): Promise<TorrentResult | null> {
  for (const mirror of YTS_MIRRORS) {
    try {
      const resp = await fetch(`${mirror}/api/v2/movie_details.json?imdb_id=${imdbId}`, {
        signal: AbortSignal.timeout(8000), headers: FETCH_HEADERS,
      });
      if (!resp.ok) continue;
      const json = await resp.json() as {
        data?: { movie?: { torrents?: { quality: string; hash: string; seeds: number }[] } };
      };
      const torrents = (json?.data?.movie?.torrents ?? [])
        .filter((t) => !is4K(t.quality))
        .filter((t) => t.seeds >= MIN_SEEDS);

      if (!torrents.length) continue;
      torrents.sort(hybridSort);

      const best = torrents[0];
      return {
        magnet: buildMagnet(best.hash, title || imdbId),
        label: `${best.quality} · ${best.seeds} Seeds`,
        seeds: best.seeds,
        quality: best.quality,
      };
    } catch { /* try next */ }
  }
  return null;
}

async function fetchAPIBay(imdbId: string, title: string): Promise<TorrentResult | null> {
  try {
    const resp = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(imdbId)}&cat=200,207,208`, {
      signal: AbortSignal.timeout(8000), headers: FETCH_HEADERS,
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text || text.trim() === "...") return null;
    const list = JSON.parse(text) as { name: string; info_hash: string; seeders: string }[];

    const candidates = list
      .filter((t) => !is4K(t.name))
      .filter((t) => parseInt(t.seeders) >= MIN_SEEDS);

    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const qd = rankQuality(a.name) - rankQuality(b.name);
      if (qd !== 0) return qd;
      return parseInt(b.seeders) - parseInt(a.seeders);
    });

    const best = candidates[0];
    const qm = best.name.match(/\b(1080p|720p|480p)\b/i);
    const quality = qm?.[1] ?? "HD";
    return {
      magnet: buildMagnet(best.info_hash, title || best.name),
      label: `${best.name.slice(0, 50)} · ${quality} · ${best.seeders} Seeds`,
      seeds: parseInt(best.seeders),
      quality,
    };
  } catch { return null; }
}

async function fetchEZTV(numericId: string, season?: string, episode?: string): Promise<TorrentResult | null> {
  for (const mirror of EZTV_MIRRORS) {
    try {
      const resp = await fetch(`${mirror}/api/get-torrents?imdb_id=${numericId}&limit=100`, {
        signal: AbortSignal.timeout(10000), headers: FETCH_HEADERS,
      });
      if (!resp.ok) continue;
      const json = await resp.json() as {
        torrents?: { filename: string; magnet_url: string; seeds: number; season: string; episode: string }[];
      };
      let torrents = json?.torrents ?? [];
      if (!torrents.length) continue;

      if (season && episode) {
        const ep = torrents.filter((t) => String(t.season) === season && String(t.episode) === episode);
        if (ep.length > 0) torrents = ep;
      }

      const candidates = torrents
        .filter((t) => !is4K(t.filename))
        .filter((t) => (t.seeds ?? 0) >= MIN_SEEDS);

      if (!candidates.length) continue;
      candidates.sort((a, b) => {
        const qd = rankQuality(a.filename) - rankQuality(b.filename);
        if (qd !== 0) return qd;
        return (b.seeds ?? 0) - (a.seeds ?? 0);
      });

      const best = candidates[0];
      const qm = best.filename.match(/\b(1080p|720p|480p)\b/i);
      const quality = qm?.[1] ?? "HD";
      return {
        magnet: addWebTrackers(best.magnet_url),
        label: `S${season ?? "?"}E${episode ?? "?"} · ${quality} · ${best.seeds ?? 0} Seeds`,
        seeds: best.seeds ?? 0,
        quality,
      };
    } catch { /* try next */ }
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════════════════
   ENGINE POOL  (torrent-stream — pure TCP/UDP, no WebRTC)
   ════════════════════════════════════════════════════════════════════════════ */
interface EngineEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  engine: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  file: any;
  label: string;
  lastUsed: number;
  /** true once the engine "ready" event has fired and a video file is selected */
  ready: boolean;
  /** "warming" → connecting to peers/downloading metadata; "ready" → streaming OK; "error" */
  state: "warming" | "ready" | "error";
  errorMessage: string;
  readyCallbacks: Array<() => void>;
  errorCallbacks: Array<(e: Error) => void>;
}

const enginePool = new Map<string, EngineEntry>();
const MAX_POOL_SIZE = 4;
const POOL_TTL_MS = 20 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of enginePool.entries()) {
    if (now - entry.lastUsed > POOL_TTL_MS) {
      try { entry.engine?.destroy(); } catch {}
      enginePool.delete(key);
      console.log(`[torrent-stream] pool evicted: ${key}`);
    }
  }
}, 5 * 60_000);

async function getOrCreateEngine(streamKey: string, magnet: string, label: string): Promise<EngineEntry> {
  const existing = enginePool.get(streamKey);
  if (existing) { existing.lastUsed = Date.now(); return existing; }

  if (enginePool.size >= MAX_POOL_SIZE) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, v] of enginePool.entries()) {
      if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; }
    }
    if (oldestKey) {
      const old = enginePool.get(oldestKey)!;
      try { old.engine?.destroy(); } catch {}
      enginePool.delete(oldestKey);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const torrentStreamMod = await import("torrent-stream") as any;
  const torrentStream = torrentStreamMod.default ?? torrentStreamMod;

  const engine = torrentStream(magnet, {
    trackers: ALL_TRACKERS,
    tmp: "/tmp/torrent-stream-cache",
  });

  const entry: EngineEntry = {
    engine, file: null, label,
    lastUsed: Date.now(),
    ready: false, state: "warming",
    errorMessage: "",
    readyCallbacks: [], errorCallbacks: [],
  };
  enginePool.set(streamKey, entry);
  console.log(`[torrent-stream] engine warming: ${streamKey}`);

  engine.on("ready", () => {
    const files = engine.files as Array<{
      name: string; length: number;
      deselect(): void; select(): void;
      createReadStream(opts?: { start?: number; end?: number }): NodeJS.ReadableStream;
    }>;
    const videoFiles = files.filter((f) => /\.(mp4|mkv|webm|avi|mov)$/i.test(f.name));
    const videoFile = videoFiles.length > 0
      ? videoFiles.reduce((a, b) => a.length > b.length ? a : b)
      : files.reduce((a, b) => a.length > b.length ? a : b);

    if (!videoFile) {
      const err = new Error("No video file in torrent");
      entry.state = "error";
      entry.errorMessage = err.message;
      entry.errorCallbacks.forEach((cb) => cb(err));
      entry.errorCallbacks = [];
      engine.destroy();
      enginePool.delete(streamKey);
      return;
    }

    files.forEach((f) => f.deselect());
    videoFile.select();

    console.log(`[torrent-stream] ready: ${videoFile.name} (${(videoFile.length / 1024 / 1024).toFixed(1)} MB)`);
    entry.file = videoFile;
    entry.ready = true;
    entry.state = "ready";
    entry.readyCallbacks.forEach((cb) => cb());
    entry.readyCallbacks = [];
  });

  engine.on("error", (err: Error) => {
    console.error("[torrent-stream] engine error:", err.message);
    entry.state = "error";
    entry.errorMessage = err.message;
    entry.errorCallbacks.forEach((cb) => cb(err));
    entry.errorCallbacks = [];
    enginePool.delete(streamKey);
  });

  return entry;
}

function waitForEngine(entry: EngineEntry): Promise<void> {
  if (entry.ready) return Promise.resolve();
  if (entry.state === "error") return Promise.reject(new Error(entry.errorMessage));
  return new Promise((resolve, reject) => {
    entry.readyCallbacks.push(resolve);
    entry.errorCallbacks.push(reject);
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   ROUTE: GET /api/torrent-stream/:imdbId
   Returns torrent metadata AND immediately kicks off engine pre-warming.
   The browser gets a fast response; the engine heats up in the background.
   ════════════════════════════════════════════════════════════════════════════ */
router.get("/torrent-stream/:imdbId", async (req, res) => {
  if (!canAccessContent(req)) {
    res.status(403).json({ error: "subscription_required", message: "يجب الاشتراك أو استخدام إحدى المشاهدات المجانية أولاً" }); return;
  }

  const imdbId = req.params["imdbId"] ?? "";
  const type   = (req.query["type"] as string) ?? "movie";
  const season  = req.query["season"] as string | undefined;
  const episode = req.query["episode"] as string | undefined;
  const title   = (req.query["title"] as string) ?? imdbId;

  if (!imdbId.match(/^tt\d+$/)) {
    res.status(400).json({ error: "invalid_imdb_id" }); return;
  }

  let result: TorrentResult | null = null;
  if (type === "series") {
    result = await fetchEZTV(imdbId.replace(/^tt/, ""), season, episode);
  } else {
    result = await fetchTorrentsDB(imdbId);
    if (!result) result = await fetchYTS(imdbId, title);
    if (!result) result = await fetchAPIBay(imdbId, title);
  }

  if (!result) {
    res.status(404).json({
      error: "no_source",
      message: "عذراً، لا توجد مصادر تورنت نشطة حالياً (جميع النسخ إما 4K أو بذور أقل من 5)",
    }); return;
  }

  /* ── PRE-WARM: start engine immediately, don't block the response ── */
  const streamKey = type === "series"
    ? `${imdbId}-s${season ?? "?"}-e${episode ?? "?"}`
    : imdbId;

  if (!enginePool.has(streamKey)) {
    // Fire-and-forget — engine warms in background while frontend shows the status UI
    getOrCreateEngine(streamKey, result.magnet, title).catch((e) => {
      console.error("[torrent-stream] pre-warm error:", e?.message);
    });
  }

  res.json(result);
});

/* ════════════════════════════════════════════════════════════════════════════
   ROUTE: GET /api/torrent-stream/:imdbId/status
   Polled by the frontend every 2 s to know when the engine is ready.
   Returns immediately — no blocking, no waiting.
   ════════════════════════════════════════════════════════════════════════════ */
router.get("/torrent-stream/:imdbId/status", (req, res) => {
  const imdbId  = req.params["imdbId"] ?? "";
  const type    = (req.query["type"] as string) ?? "movie";
  const season  = req.query["season"] as string | undefined;
  const episode = req.query["episode"] as string | undefined;

  const streamKey = type === "series"
    ? `${imdbId}-s${season ?? "?"}-e${episode ?? "?"}`
    : imdbId;

  const entry = enginePool.get(streamKey);

  if (!entry) {
    res.json({ state: "not_started", ready: false }); return;
  }

  res.json({
    state: entry.state,         // "warming" | "ready" | "error"
    ready: entry.ready,
    errorMessage: entry.errorMessage || null,
    fileName: entry.ready ? (entry.file?.name as string | undefined) ?? null : null,
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   ROUTE: GET /api/torrent-stream/:imdbId/play
   Now called ONLY after the frontend confirms state === "ready".
   The engine is already warm → responds instantly with bytes.
   ════════════════════════════════════════════════════════════════════════════ */
router.get("/torrent-stream/:imdbId/play", async (req, res) => {
  if (!canAccessContent(req)) {
    res.status(403).send("Subscription required"); return;
  }

  const imdbId  = req.params["imdbId"] ?? "";
  const type    = (req.query["type"] as string) ?? "movie";
  const season  = req.query["season"] as string | undefined;
  const episode = req.query["episode"] as string | undefined;
  const title   = (req.query["title"] as string) ?? imdbId;

  if (!imdbId.match(/^tt\d+$/)) {
    res.status(400).send("Invalid IMDB ID"); return;
  }

  const streamKey = type === "series"
    ? `${imdbId}-s${season ?? "?"}-e${episode ?? "?"}`
    : imdbId;

  console.log(`[torrent-stream/play] ${streamKey}`);

  /* ── If engine is not in pool yet (direct /play call), start it now ── */
  if (!enginePool.has(streamKey)) {
    let result: TorrentResult | null = null;
    if (type === "series") {
      result = await fetchEZTV(imdbId.replace(/^tt/, ""), season, episode);
    } else {
      result = await fetchTorrentsDB(imdbId);
      if (!result) result = await fetchYTS(imdbId, title);
      if (!result) result = await fetchAPIBay(imdbId, title);
    }
    if (!result) { res.status(404).send("No active torrent source"); return; }
    await getOrCreateEngine(streamKey, result.magnet, title).catch(() => null);
  }

  const entry = enginePool.get(streamKey);
  if (!entry) { res.status(503).send("Engine not available"); return; }

  /* ── If already ready (normal path after polling), skip wait ── */
  if (!entry.ready) {
    const METADATA_TIMEOUT_MS = 90_000;
    try {
      await Promise.race([
        waitForEngine(entry),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Metadata timeout")), METADATA_TIMEOUT_MS)
        ),
      ]);
    } catch (e) {
      console.error("[torrent-stream/play] timeout:", e);
      enginePool.delete(streamKey);
      try { entry.engine?.destroy(); } catch {}
      res.status(504).send("Torrent timeout"); return;
    }
  }

  const file     = entry.file;
  const fileSize = file.length as number;
  entry.lastUsed = Date.now();

  const mime = /\.mkv$/i.test(file.name as string)
    ? "video/x-matroska"
    : /\.webm$/i.test(file.name as string)
      ? "video/webm"
      : "video/mp4";

  const rangeHeader = req.headers["range"];
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0]!, 10);
    const end   = parts[1] ? Math.min(parseInt(parts[1], 10), fileSize - 1) : fileSize - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": mime,
      "Cache-Control": "no-cache",
    });
    const stream = file.createReadStream({ start, end });
    stream.pipe(res as unknown as NodeJS.WritableStream);
    (req as IncomingMessage).on("close", () => { try { (stream as NodeJS.ReadableStream).destroy?.(); } catch {} });
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    const stream = file.createReadStream();
    stream.pipe(res as unknown as NodeJS.WritableStream);
    (req as IncomingMessage).on("close", () => { try { (stream as NodeJS.ReadableStream).destroy?.(); } catch {} });
  }
});

export default router;
