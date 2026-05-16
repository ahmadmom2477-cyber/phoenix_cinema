import { Router } from "express";

const router = Router();

// ── Trackers injected into every magnet ──────────────────────────────────────
const TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.fastcast.nz",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.coppersurfer.tk:6969/announce",
  "udp://tracker.leechers-paradise.org:6969/announce",
  "udp://open.demonii.com:1337/announce",
];

function buildMagnet(hash: string, name: string, webSeedUrl?: string): string {
  let m = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
  for (const tr of TRACKERS) m += `&tr=${encodeURIComponent(tr)}`;
  if (webSeedUrl) m += `&ws=${encodeURIComponent(webSeedUrl)}`;
  return m;
}

// ── Quality helpers ──────────────────────────────────────────────────────────
const QUALITY_ORDER = ["1080p", "720p", "480p", "360p", "sd"];

function rankQuality(q: string): number {
  const idx = QUALITY_ORDER.indexOf((q ?? "sd").toLowerCase());
  return idx === -1 ? 99 : idx;
}
function qualityFromName(name: string): string {
  const m = (name ?? "").match(/\b(2160p|4K|1080p|720p|480p|360p)\b/i);
  if (!m) return "SD";
  return m[1].replace(/^4k$/i, "2160p").toLowerCase();
}
function is4K(q: string) { return ["2160p", "4k"].includes(q.toLowerCase()); }

// ── apibay ───────────────────────────────────────────────────────────────────
interface ApibayTorrent { name: string; info_hash: string; seeders: string; leechers: string }

async function apibay(query: string, cat: string): Promise<ApibayTorrent[] | null> {
  try {
    const r = await fetch(
      `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=${cat}`,
      { signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!r.ok) return null;
    const txt = await r.text();
    if (!txt || txt.trim() === "..." || txt.includes("<!DOCTYPE")) return null;
    const arr = JSON.parse(txt) as ApibayTorrent[];
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr
      .filter((t) => parseInt(t.seeders ?? "0", 10) > 0)
      .sort((a, b) => parseInt(b.seeders, 10) - parseInt(a.seeders, 10));
  } catch { return null; }
}

// ── EZTV ─────────────────────────────────────────────────────────────────────
interface EztvTorrent {
  hash: string; filename: string;
  episode: string; season: string; seeds: number;
}
interface EztvResp { torrents_count: number; torrents?: EztvTorrent[] }

async function eztv(
  imdbId: string, season?: string, episode?: string
): Promise<{ hash: string; quality: string; seeds: number; name: string } | null> {
  try {
    const numId = imdbId.replace(/^tt0*/i, "");
    const r = await fetch(
      `https://eztvx.to/api/get-torrents?imdb_id=${numId}&limit=100`,
      { signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!r.ok) return null;
    const data: EztvResp = await r.json();
    let list = data?.torrents ?? [];
    if (!list.length) return null;

    // Filter to exact episode when requested
    if (season && episode) {
      const s = String(parseInt(season, 10));
      const e = String(parseInt(episode, 10));
      const ep = list.filter(
        (t) =>
          String(parseInt(t.season ?? "0", 10)) === s &&
          String(parseInt(t.episode ?? "0", 10)) === e
      );
      if (ep.length) list = ep;
    }

    const best = list
      .filter((t) => !is4K(qualityFromName(t.filename)))
      .sort((a, b) => {
        const qd = rankQuality(qualityFromName(a.filename)) - rankQuality(qualityFromName(b.filename));
        return qd !== 0 ? qd : (b.seeds ?? 0) - (a.seeds ?? 0);
      })[0];

    if (!best) return null;
    return {
      hash:    best.hash.toUpperCase(),
      quality: qualityFromName(best.filename),
      seeds:   best.seeds ?? 0,
      name:    best.filename,
    };
  } catch { return null; }
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.get("/torrent-info/:imdbId", async (req, res) => {
  const imdbId  = req.params["imdbId"] as string;
  const type    = (req.query["type"]    as string) || "movie";
  const season  = req.query["season"]  as string | undefined;
  const episode = req.query["episode"] as string | undefined;
  const title   = (req.query["title"]  as string) || imdbId;

  try {
    // ── MOVIES ───────────────────────────────────────────────────────────
    // NOTE: YTS is Cloudflare-protected and unreachable from cloud servers.
    // Movie lookup via YTS is done CLIENT-SIDE in the browser (TorrentPlayer.tsx).
    // This endpoint handles the server-side fallback for movies (apibay)
    // and the primary path for series (EZTV → apibay).
    if (type === "movie") {
      const [hd, all] = await Promise.all([
        apibay(imdbId, "207"),
        apibay(imdbId, "200"),
      ]);
      const candidates = [...(hd ?? []), ...(all ?? [])];
      if (!candidates.length) {
        return res.status(404).json({
          error: "no_torrents",
          message: "لا توجد تورنتات للفيلم — حاول مصدراً آخر",
        });
      }
      const seen = new Set<string>();
      const ranked = candidates
        .filter((t) => {
          const q = qualityFromName(t.name);
          if (is4K(q)) return false;
          if (seen.has(t.info_hash)) return false;
          seen.add(t.info_hash);
          return true;
        })
        .sort((a, b) => {
          const qd = rankQuality(qualityFromName(a.name)) - rankQuality(qualityFromName(b.name));
          return qd !== 0 ? qd : parseInt(b.seeders, 10) - parseInt(a.seeders, 10);
        });

      if (!ranked.length) {
        return res.status(404).json({ error: "no_torrents", message: "لا توجد تورنتات للفيلم" });
      }
      const best = ranked[0];
      const hash = best.info_hash.toUpperCase();
      return res.json({
        source:     "apibay",
        type:       "movie",
        name:       best.name,
        hash,
        quality:    qualityFromName(best.name),
        seeders:    parseInt(best.seeders, 10),
        magnet:     buildMagnet(hash, title || best.name),
        torrentUrl: `/api/torrent-file/${hash}`,
      });
    }

    // ── SERIES: EZTV → apibay ────────────────────────────────────────────
    const eztvResult = await eztv(imdbId, season, episode);
    if (eztvResult) {
      return res.json({
        source:     "eztv",
        type:       "show",
        name:       eztvResult.name,
        hash:       eztvResult.hash,
        quality:    eztvResult.quality,
        seeders:    eztvResult.seeds,
        magnet:     buildMagnet(eztvResult.hash, title || eztvResult.name),
        torrentUrl: `/api/torrent-file/${eztvResult.hash}`,
      });
    }

    // apibay fallback for series
    const queries: string[] = [];
    if (season && episode) {
      const ep = episode.padStart(2, "0");
      const s  = season.padStart(2, "0");
      queries.push(`${imdbId} S${s}E${ep}`, `${title} S${s}E${ep}`);
    }
    queries.push(`${title} Season ${season ?? "1"}`, imdbId);

    for (const q of queries) {
      const results = await apibay(q, "205,208");
      if (results?.length) {
        const best = results[0];
        const hash = best.info_hash.toUpperCase();
        return res.json({
          source:     "apibay",
          type:       "show",
          name:       best.name,
          hash,
          quality:    qualityFromName(best.name),
          seeders:    parseInt(best.seeders, 10),
          magnet:     buildMagnet(hash, title || best.name),
          torrentUrl: `/api/torrent-file/${hash}`,
        });
      }
    }

    return res.status(404).json({
      error:   "no_torrents",
      message: "لا توجد تورنتات للحلقة في هذه اللحظة",
    });

  } catch (err) {
    res.status(500).json({ error: "server_error", message: String(err) });
  }
});

export default router;
