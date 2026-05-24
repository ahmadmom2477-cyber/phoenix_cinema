import { Router } from "express";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import http from "http";

const router = Router();

const PEERFLIX_PATH = "/home/runner/workspace/.config/npm/node_global/bin/peerflix";
const PEERFLIX_PORT = 8889;

let peerflixProcess: ChildProcess | null = null;

function killPeerflix(): Promise<void> {
  return new Promise((resolve) => {
    if (!peerflixProcess) { resolve(); return; }
    const proc = peerflixProcess;
    peerflixProcess = null;
    try { proc.kill("SIGKILL"); } catch {}
    setTimeout(resolve, 600);
  });
}

async function waitForPeerflix(maxMs = 25000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get({ hostname: "127.0.0.1", port: PEERFLIX_PORT, path: "/", timeout: 1200 }, (res) => {
        res.destroy();
        resolve(true);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 800));
  }
  return false;
}

function buildMagnet(hash: string, webSeedUrl?: string): string {
  const h = hash.toUpperCase();
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "wss://tracker.openwebtorrent.com",
    "wss://tracker.btorrent.xyz",
  ];
  let m = `magnet:?xt=urn:btih:${h}`;
  for (const tr of trackers) m += `&tr=${encodeURIComponent(tr)}`;
  if (webSeedUrl) m += `&ws=${encodeURIComponent(webSeedUrl)}`;
  return m;
}

// ── POST /api/player5/start ───────────────────────────────────────────────────
router.post("/player5/start", async (req, res) => {
  const { magnet, hash, webSeedUrl } = (req.body ?? {}) as {
    magnet?: string;
    hash?: string;
    webSeedUrl?: string;
  };

  const source = magnet ?? (hash ? buildMagnet(hash, webSeedUrl) : null);
  if (!source) return res.status(400).json({ error: "magnet or hash required" });

  await killPeerflix();

  try {
    peerflixProcess = spawn(
      PEERFLIX_PATH,
      [source, "--port", String(PEERFLIX_PORT), "--address", "127.0.0.1", "--path", "/tmp", "--quiet"],
      { detached: false, stdio: "ignore" }
    );

    peerflixProcess.on("exit", () => { peerflixProcess = null; });
    peerflixProcess.on("error", (err) => {
      console.error("[player5] peerflix error:", err.message);
      peerflixProcess = null;
    });

    const ready = await waitForPeerflix(25000);
    if (!ready) {
      await killPeerflix();
      return res.status(503).json({ error: "timeout", message: "تعذّر بدء مشغّل peerflix" });
    }

    return res.json({ ok: true, streamUrl: "/api/player5/video" });
  } catch (err) {
    await killPeerflix();
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/player5/video ───────────────────────────────────────────────────
// Proxies peerflix HTTP stream with full Range support for seeking
router.get("/player5/video", (req, res) => {
  if (!peerflixProcess) {
    return res.status(503).json({ error: "no_stream", message: "المشغّل غير نشط" });
  }

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: PEERFLIX_PORT,
      path: "/",
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${PEERFLIX_PORT}`,
      },
    },
    (proxyRes) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (v !== undefined) headers[k] = v as string | string[];
      }
      headers["access-control-allow-origin"] = "*";
      delete headers["transfer-encoding"];

      res.writeHead(proxyRes.statusCode ?? 200, headers);
      proxyRes.pipe(res, { end: true });
      req.on("close", () => { try { proxyRes.destroy(); } catch {} });
    }
  );

  proxyReq.on("error", () => {
    if (!res.headersSent) res.status(502).end();
  });

  proxyReq.end();
});

// ── POST /api/player5/stop ────────────────────────────────────────────────────
router.post("/player5/stop", async (_, res) => {
  await killPeerflix();
  res.json({ ok: true });
});

// ── GET /api/player5/status ───────────────────────────────────────────────────
router.get("/player5/status", (_, res) => {
  res.json({ active: !!peerflixProcess });
});

export default router;
