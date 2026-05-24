import { Router } from "express";

const router = Router();

/**
 * GET /api/torrent-file/:hash
 * Proxies the raw .torrent binary.
 * Tries the YTS French CDN first (less Cloudflare-restricted),
 * then falls back to itorrents mirrors.
 */
router.get("/torrent-file/:hash", async (req, res) => {
  const hash = (req.params["hash"] as string).replace(/\.torrent$/i, "").toUpperCase();

  const SOURCES = [
    `https://fr.yts.mx/torrent/download/${hash}`,
    `https://yts.mx/torrent/download/${hash}`,
    `https://yts.pm/torrent/download/${hash}`,
    `https://itorrents.net/torrent/${hash}.torrent`,
    `http://itorrents.org/torrent/${hash}.torrent`,
  ];

  for (const url of SOURCES) {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7_000);
      let upstream: Response;
      try {
        upstream = await fetch(url, {
          signal: ctrl.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        });
      } finally {
        clearTimeout(timer);
      }

      if (!upstream.ok) continue;
      const ct = upstream.headers.get("content-type") ?? "";
      if (ct.includes("text/html")) continue;

      const buf = await upstream.arrayBuffer();
      if (buf.byteLength < 100) continue;
      if (new Uint8Array(buf)[0] !== 0x64) continue; // bencode dict starts with 'd'

      res.set({
        "Content-Type":  "application/x-bittorrent",
        "Content-Length": String(buf.byteLength),
        "Cache-Control":  "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(Buffer.from(buf));
    } catch {
      continue;
    }
  }

  res.status(502).json({ error: "torrent_unavailable", message: "لا يمكن جلب ملف التورنت" });
});

export default router;
