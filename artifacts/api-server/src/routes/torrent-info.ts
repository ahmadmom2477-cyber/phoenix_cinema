import { Router } from "express";

const router = Router();

const WSS_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.fastcast.nz",
  "wss://tracker.files.fm:7073/announce",
  "wss://tracker.novage.com.ua",
];

function buildMagnet(hash: string, title: string): string {
  const tr = WSS_TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`).join("&");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&${tr}`;
}

interface ApibayTorrent {
  name: string;
  info_hash: string;
  seeders: string;
  leechers: string;
  size: string;
  category: string;
}

function qualityFromName(name: string): string {
  const m = name.match(/\b(2160p|4K|1080p|720p|480p|360p)\b/i);
  if (!m) return "SD";
  return m[1].replace(/^4k$/i, "2160p").toLowerCase();
}

const QUALITY_ORDER = ["1080p", "720p", "480p", "360p", "sd"];

async function fetchApibay(query: string, cat: string): Promise<ApibayTorrent[] | null> {
  try {
    const resp = await fetch(
      `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=${cat}`,
      {
        signal: AbortSignal.timeout(8_000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
      }
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
      const [hdResults, allResults] = await Promise.all([
        fetchApibay(imdbId, "207"),
        fetchApibay(imdbId, "200"),
      ]);

      const candidates = [...(hdResults ?? []), ...(allResults ?? [])];
      if (!candidates.length) {
        return res.status(404).json({
          error: "no_torrents",
          message: "لا توجد تورنتات للفيلم في هذه اللحظة",
        });
      }

      const seen = new Set<string>();
      const unique = candidates.filter((t) => {
        const q = qualityFromName(t.name);
        if (q === "2160p") return false;
        if (seen.has(t.info_hash)) return false;
        seen.add(t.info_hash);
        return true;
      });

      const ranked = unique.sort((a, b) => {
        const ai = QUALITY_ORDER.indexOf(qualityFromName(a.name));
        const bi = QUALITY_ORDER.indexOf(qualityFromName(b.name));
        if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        return parseInt(b.seeders, 10) - parseInt(a.seeders, 10);
      });

      const best  = ranked[0];
      const hash  = best.info_hash.toUpperCase();

      return res.json({
        hash,
        magnet:   buildMagnet(hash, title || best.name),
        quality:  qualityFromName(best.name),
        seeds:    parseInt(best.seeders, 10),
        name:     best.name,
      });
    }

    // ── Series ──────────────────────────────────────────────────────────
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
      return res.status(404).json({
        error: "no_torrents",
        message: "لا توجد تورنتات للحلقة في هذه اللحظة",
      });
    }

    const hash = best.info_hash.toUpperCase();
    return res.json({
      hash,
      magnet:  buildMagnet(hash, title || best.name),
      quality: qualityFromName(best.name),
      seeds:   parseInt(best.seeders, 10),
      name:    best.name,
    });

  } catch (err) {
    res.status(500).json({ error: "server_error", message: String(err) });
  }
});

export default router;
