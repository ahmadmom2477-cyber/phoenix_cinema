import { Router } from "express";

const router = Router();

const WSS_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.fastcast.nz",
  "wss://tracker.files.fm:7073/announce",
  "wss://tracker.novage.com.ua",
];

const TIER1_TRACKERS = [
  ...WSS_TRACKERS,
  "udp://tracker.coppersurfer.tk:6969/announce",
  "udp://tracker.leechers-paradise.org:6969/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];

function buildMagnet(hash: string, title: string, trackers: string[]): string {
  const tr = trackers.map((t) => `tr=${encodeURIComponent(t)}`).join("&");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&${tr}`;
}

const QUALITY_ORDER = ["1080p", "720p", "480p", "360p", "sd"];

function rankQuality(q: string): number {
  const idx = QUALITY_ORDER.indexOf(q.toLowerCase());
  return idx === -1 ? 99 : idx;
}

function qualityFromName(name: string): string {
  const m = name.match(/\b(2160p|4K|1080p|720p|480p|360p)\b/i);
  if (!m) return "SD";
  return m[1].replace(/^4k$/i, "2160p").toLowerCase();
}

interface YTSTorrent {
  hash: string;
  quality: string;
  seeds: number;
  peers: number;
  url: string;
}

interface YTSMovie {
  title: string;
  torrents?: YTSTorrent[];
}

interface YTSResponse {
  status: string;
  data: { movie_count: number; movies?: YTSMovie[] };
}

async function fetchYTS(imdbId: string): Promise<{ hash: string; quality: string; seeds: number; name: string } | null> {
  try {
    const resp = await fetch(
      `https://yts.mx/api/v2/list_movies.json?query_term=${imdbId}`,
      { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!resp.ok) return null;
    const data = await resp.json() as YTSResponse;
    const movies = data?.data?.movies;
    if (!movies?.length) return null;

    const movie = movies[0];
    const torrents = movie.torrents ?? [];
    if (!torrents.length) return null;

    const sorted = [...torrents].sort((a, b) => rankQuality(a.quality) - rankQuality(b.quality));
    const best = sorted[0];

    return {
      hash: best.hash.toUpperCase(),
      quality: best.quality,
      seeds: best.seeds,
      name: `${movie.title} [${best.quality}]`,
    };
  } catch {
    return null;
  }
}

interface ApibayTorrent {
  name: string;
  info_hash: string;
  seeders: string;
  leechers: string;
}

async function fetchApibay(query: string, cat: string): Promise<ApibayTorrent[] | null> {
  try {
    const resp = await fetch(
      `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=${cat}`,
      { signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text || text.trim() === "..." || text.includes("<!DOCTYPE")) return null;
    const json = JSON.parse(text) as ApibayTorrent[];
    if (!Array.isArray(json) || !json.length) return null;
    return json.filter((t) => parseInt(t.seeders ?? "0", 10) > 0);
  } catch {
    return null;
  }
}

router.get("/torrent-info/:imdbId", async (req, res) => {
  const imdbId  = req.params["imdbId"] as string;
  const type    = (req.query["type"] as string) || "movie";
  const season  = req.query["season"]  as string | undefined;
  const episode = req.query["episode"] as string | undefined;
  const title   = (req.query["title"]  as string) || imdbId;

  try {
    if (type !== "series") {
      const yts = await fetchYTS(imdbId);
      if (!yts) {
        return res.status(404).json({ error: "no_torrents", message: "لا توجد تورنتات للفيلم في هذه اللحظة" });
      }
      return res.json({
        hash: yts.hash,
        magnet: buildMagnet(yts.hash, title, WSS_TRACKERS),
        quality: yts.quality,
        seeds: yts.seeds,
        name: yts.name,
        torrentUrl: `/api/torrent-file/${yts.hash}`,
      });
    }

    const queries: string[] = [];
    if (season && episode) {
      const ep = episode.padStart(2, "0");
      const s  = season.padStart(2, "0");
      queries.push(`${imdbId} S${s}E${ep}`);
      queries.push(`${title} S${s}E${ep}`);
    }
    queries.push(`${imdbId} Season ${season ?? "1"}`);

    let best: ApibayTorrent | null = null;
    for (const q of queries) {
      const results = await fetchApibay(q, "205,208");
      if (results?.length) {
        best = results.sort((a, b) => parseInt(b.seeders, 10) - parseInt(a.seeders, 10))[0];
        break;
      }
    }

    if (!best) {
      return res.status(404).json({ error: "no_torrents", message: "لا توجد تورنتات للحلقة في هذه اللحظة" });
    }

    const hash = best.info_hash.toUpperCase();
    return res.json({
      hash,
      magnet: buildMagnet(hash, title || best.name, TIER1_TRACKERS),
      quality: qualityFromName(best.name),
      seeds: parseInt(best.seeders, 10),
      name: best.name,
      torrentUrl: `/api/torrent-file/${hash}`,
    });

  } catch (err) {
    res.status(500).json({ error: "server_error", message: String(err) });
  }
});

export default router;
