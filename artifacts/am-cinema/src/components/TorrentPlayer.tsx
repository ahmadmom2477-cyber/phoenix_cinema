/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useRef, useEffect, useCallback } from "react";
import { Play, AlertCircle, Film, RefreshCw, Upload, Wifi, Volume2, Zap } from "lucide-react";
import { parseSrt } from "@/utils/srt";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSpeed(bps: number): string {
  if (bps < 1024)           return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024)   return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
}
function msToVtt(ms: number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1_000))}.${pad(ms % 1_000, 3)}`;
}
function srtToVtt(srt: string): string {
  return `WEBVTT\n\n${parseSrt(srt).map((c) => `${msToVtt(c.start)} --> ${msToVtt(c.end)}\n${c.text}`).join("\n\n")}`;
}

// ── YTS client-side lookup (browser bypasses Cloudflare) ─────────────────────
const YTS_MIRRORS = [
  "https://yts.mx/api/v2/list_movies.json",
  "https://yts.lt/api/v2/list_movies.json",
  "https://yts.pm/api/v2/list_movies.json",
];
const QUALITY_PREF = ["1080p", "720p", "480p", "360p"];

interface YTSTorrent { hash: string; quality: string; seeds: number; size: string }
interface YTSMovie   { title: string; torrents?: YTSTorrent[] }
interface YTSResp    { status: string; data: { movie_count: number; movies?: YTSMovie[] } }

async function fetchYTSBrowser(imdbId: string): Promise<TorrentInfo | null> {
  for (const mirror of YTS_MIRRORS) {
    try {
      const r = await fetch(`${mirror}?query_term=${imdbId}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) continue;
      const data: YTSResp = await r.json();
      if (!data?.data?.movie_count || !data.data.movies?.length) continue;

      const movie = data.data.movies[0];
      const torrents = (movie.torrents ?? []).filter(
        (t) => !["2160p", "4k"].includes(t.quality.toLowerCase())
      );
      if (!torrents.length) continue;

      const best = torrents.sort(
        (a, b) => QUALITY_PREF.indexOf(a.quality.toLowerCase()) - QUALITY_PREF.indexOf(b.quality.toLowerCase())
      )[0];

      const hash       = best.hash.toUpperCase();
      const webSeedUrl = `https://fr.yts.mx/torrent/download/${hash}`;

      return {
        source:     "yts",
        type:       "movie",
        name:       `${movie.title} [${best.quality}]`,
        hash,
        quality:    best.quality,
        seeds:      best.seeds,
        webSeedUrl,
        torrentUrl: `/api/torrent-file/${hash}`,
      };
    } catch { continue; }
  }
  return null;
}

// ── Backend fetch ─────────────────────────────────────────────────────────────
async function fetchBackend(
  imdbId: string,
  type: string,
  season?: string,
  episode?: string,
  title?: string
): Promise<TorrentInfo> {
  const p = new URLSearchParams({ type });
  if (season)  p.set("season",  season);
  if (episode) p.set("episode", episode);
  if (title)   p.set("title",   title);
  const r = await fetch(`/api/torrent-info/${imdbId}?${p}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? "لا توجد تورنتات متاحة");
  }
  return r.json() as Promise<TorrentInfo>;
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Phase = "idle" | "fetching" | "loading" | "playing" | "error";

interface Props {
  imdbId: string;
  type?: "movie" | "series";
  season?: string;
  episode?: string;
  title?: string;
  subtitleUrl?: string | null;
}

interface TorrentInfo {
  source?: string;
  type?: string;
  hash: string;
  name?: string;
  title?: string;
  quality?: string;
  seeds?: number;
  seeders?: number;
  size?: string;
  webSeedUrl?: string;
  magnet?: string;
  torrentUrl: string;
}

interface Stats { speed: number; progress: number; peers: number }

// ── Component ─────────────────────────────────────────────────────────────────
export default function TorrentPlayer({
  imdbId, type = "movie", season, episode, title, subtitleUrl,
}: Props) {
  const videoRef      = useRef<HTMLVideoElement>(null);
  const clientRef     = useRef<any>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const trackBlobRef  = useRef<string | null>(null);
  const statsTimer    = useRef<ReturnType<typeof setInterval> | null>(null);

  const [phase,    setPhase]  = useState<Phase>("idle");
  const [status,   setStatus] = useState("");          // subtitle for loading phase
  const [errorMsg, setError]  = useState("");
  const [info,     setInfo]   = useState<TorrentInfo | null>(null);
  const [stats,    setStats]  = useState<Stats>({ speed: 0, progress: 0, peers: 0 });
  const [trackUrl, setTrack]  = useState<string | null>(null);
  const [muted,    setMuted]  = useState(false);

  useEffect(() => {
    setTrack(subtitleUrl ? subtitleUrl.replace(/\.srt$/i, ".vtt") : null);
  }, [subtitleUrl]);

  const destroyClient = useCallback(() => {
    if (statsTimer.current) { clearInterval(statsTimer.current); statsTimer.current = null; }
    if (clientRef.current)  { try { clientRef.current.destroy(); } catch {} clientRef.current = null; }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
  }, []);

  useEffect(() => () => {
    destroyClient();
    if (trackBlobRef.current) URL.revokeObjectURL(trackBlobRef.current);
  }, [destroyClient]);

  useEffect(() => {
    setPhase("idle"); setError(""); setInfo(null);
    setStats({ speed: 0, progress: 0, peers: 0 });
    destroyClient();
  }, [imdbId, season, episode, destroyClient]);

  const handleSubFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const vtt  = file.name.toLowerCase().endsWith(".srt") ? srtToVtt(text) : text;
      if (trackBlobRef.current) URL.revokeObjectURL(trackBlobRef.current);
      const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt; charset=utf-8" }));
      trackBlobRef.current = url;
      setTrack(url);
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  }, []);

  const start = useCallback(async () => {
    destroyClient();
    setPhase("fetching"); setError("");
    setStats({ speed: 0, progress: 0, peers: 0 });

    try {
      let resolved: TorrentInfo | null = null;

      if (type === "movie") {
        // ① Browser → YTS directly (bypasses Cloudflare on server)
        setStatus("جارٍ البحث في YTS…");
        resolved = await fetchYTSBrowser(imdbId);

        if (!resolved) {
          // ② Server fallback (apibay) when YTS unreachable from browser
          setStatus("جارٍ البحث في المصدر الاحتياطي…");
          resolved = await fetchBackend(imdbId, "movie", undefined, undefined, title);
        }
      } else {
        // Series always through backend (EZTV → apibay)
        setStatus("جارٍ البحث في EZTV…");
        resolved = await fetchBackend(imdbId, "series", season, episode, title);
      }

      setInfo(resolved);
      setPhase("loading");
      setStatus(resolved.webSeedUrl ? "بث HTTP مباشر عبر WebSeed…" : "جارٍ الاتصال بالـ peers…");

      // ── WebTorrent client ─────────────────────────────────────────────
      const mod        = await import("webtorrent/dist/webtorrent.min.js" as any);
      const WebTorrent = mod.default ?? mod;
      const client     = new WebTorrent({ storage: false });
      clientRef.current = client;

      client.on("error", (err: Error) => {
        setError(err?.message ?? "خطأ في مشغّل التورنت");
        setPhase("error");
        destroyClient();
      });

      // Build add options
      const addOpts: Record<string, unknown> = {
        announce: [
          "wss://tracker.openwebtorrent.com",
          "wss://tracker.btorrent.xyz",
          "wss://tracker.fastcast.nz",
        ],
      };
      // If YTS WebSeed is available, pass it so WebTorrent uses HTTP instead of P2P
      if (resolved.webSeedUrl) {
        addOpts["urlList"] = [resolved.webSeedUrl];
      }

      // Always use our local proxy — it tries fr.yts.mx CDN first, then itorrents
      client.add(resolved.torrentUrl, addOpts, (torrent: any) => {
        // Pick the largest video file
        const videoExts = /\.(mp4|mkv|webm|avi|mov)$/i;
        const vFiles: any[] = torrent.files.filter((f: any) => videoExts.test(f.name));
        const file: any = (vFiles.length ? vFiles : torrent.files)
          .reduce((a: any, b: any) => a.length > b.length ? a : b);

        const videoEl = videoRef.current;
        if (!videoEl) return;

        file.renderTo(videoEl, { autoplay: true, muted: false }, (err: Error | null) => {
          if (err) {
            // Autoplay blocked — mute and retry
            videoEl.muted = true;
            setMuted(true);
            videoEl.play().catch(() => {});
          }
        });

        setPhase("playing");

        statsTimer.current = setInterval(() => {
          setStats({
            speed:    torrent.downloadSpeed ?? 0,
            progress: torrent.progress      ?? 0,
            peers:    torrent.numPeers       ?? 0,
          });
        }, 1_000);
      });

    } catch (err: any) {
      setError(err?.message ?? "خطأ غير معروف");
      setPhase("error");
    }
  }, [imdbId, type, season, episode, title, destroyClient]);

  const toggleMute = useCallback(() => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setMuted(videoRef.current.muted);
  }, []);

  const isPlaying    = phase === "playing";
  const isWebSeed    = !!info?.webSeedUrl;
  const displaySeeds = info?.seeds ?? info?.seeders ?? 0;
  const displayName  = info?.name ?? info?.title ?? "";

  return (
    <div className="w-full flex flex-col bg-black">

      {/* ── 16:9 player frame ──────────────────────────────────────────── */}
      <div className="relative w-full" style={{ aspectRatio: "16/9" }}>

        {/* Idle */}
        {phase === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10">
            <div className="rounded-full bg-white/8 p-5 border border-white/10">
              <Film className="h-10 w-10 text-white/50" />
            </div>
            <div className="text-center px-6">
              <p className="text-white/75 text-sm font-medium mb-1">مشغّل التورنت</p>
              <p className="text-white/35 text-xs">
                {type === "movie"
                  ? "أفلام: YTS WebSeed → بث HTTP فوري · مسلسلات: EZTV"
                  : "مسلسلات: EZTV → apibay · بث P2P مباشر"}
              </p>
            </div>
            <button
              onClick={start}
              className="flex items-center gap-2.5 rounded-full bg-primary px-8 py-3 text-white font-semibold hover:opacity-90 active:scale-95 transition-all shadow-lg shadow-primary/30"
            >
              <Play className="h-5 w-5 fill-current" />
              تشغيل
            </button>
          </div>
        )}

        {/* Fetching */}
        {phase === "fetching" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
            <Wifi className="h-8 w-8 text-primary animate-pulse" />
            <div className="text-center">
              <p className="text-white/70 text-sm">جارٍ البحث…</p>
              <p className="text-white/35 text-xs mt-1">{status}</p>
            </div>
          </div>
        )}

        {/* Loading */}
        {phase === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10">
            <div className="relative">
              <div className="w-14 h-14 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
              {isWebSeed && (
                <Zap className="absolute inset-0 m-auto h-5 w-5 text-primary" />
              )}
            </div>
            <div className="text-center px-8 space-y-1.5">
              {displayName && (
                <p className="text-white/60 text-xs truncate max-w-[260px]">{displayName}</p>
              )}
              <div className="flex items-center justify-center gap-2 flex-wrap">
                {info?.quality && (
                  <span className="text-xs font-medium text-primary/80 bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                    {info.quality}
                  </span>
                )}
                <span className={`text-xs px-2 py-0.5 rounded-full border ${
                  isWebSeed
                    ? "text-green-300 bg-green-500/10 border-green-500/20"
                    : "text-blue-300 bg-blue-500/10 border-blue-500/20"
                }`}>
                  {isWebSeed ? "⚡ WebSeed HTTP" : "🔗 P2P"}
                </span>
                {displaySeeds > 0 && (
                  <span className="text-white/30 text-xs">{displaySeeds} seeds</span>
                )}
              </div>
              <p className="text-white/40 text-xs">{status}</p>
            </div>
            <button
              onClick={() => { destroyClient(); setPhase("idle"); }}
              className="text-white/25 text-xs hover:text-white/55 transition-colors"
            >
              إلغاء
            </button>
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10 text-center px-6">
            <AlertCircle className="h-10 w-10 text-red-500" />
            <p className="text-white/80 text-sm leading-relaxed max-w-xs">{errorMsg}</p>
            <button
              onClick={start}
              className="flex items-center gap-2 rounded-full border border-white/20 px-6 py-2.5 text-white/70 text-sm hover:bg-white/10 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              إعادة المحاولة
            </button>
          </div>
        )}

        {/* Video — always mounted, invisible until playing */}
        <video
          ref={videoRef}
          className={`absolute inset-0 w-full h-full object-contain ${isPlaying ? "block" : "opacity-0 pointer-events-none"}`}
          controls
          autoPlay
          playsInline
          crossOrigin="anonymous"
          onError={() => {
            if (phase === "playing") {
              setError("تعذّر تشغيل الفيديو — الـ format غير مدعوم على هذا الجهاز");
              setPhase("error");
            }
          }}
        >
          {trackUrl && <track kind="subtitles" src={trackUrl} srcLang="ar" label="العربية" default />}
        </video>
      </div>

      {/* ── Stats bar — BELOW player, never overlaps controls ───────────── */}
      {isPlaying && (
        <div className="flex items-center gap-2 px-3 py-2 bg-black border-t border-white/5 flex-wrap gap-y-1.5">

          {/* Source badge */}
          <div className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs border shrink-0 ${
            isWebSeed
              ? "bg-green-500/10 border-green-500/20 text-green-300"
              : "bg-white/5 border-white/10 text-white/50"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full animate-pulse shrink-0 ${isWebSeed ? "bg-green-400" : "bg-blue-400"}`} />
            {isWebSeed ? "WebSeed" : "P2P"}
          </div>

          {/* Quality */}
          {info?.quality && (
            <span className="text-white/45 text-xs font-medium shrink-0 bg-white/5 px-2 py-1 rounded-full border border-white/10">
              {info.quality}
            </span>
          )}

          {/* Speed */}
          <span className="text-primary/80 text-xs font-mono shrink-0 tabular-nums">
            {formatSpeed(stats.speed)}
          </span>

          {/* Progress */}
          <div className="flex-1 min-w-[50px] flex items-center gap-1.5">
            <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-1000"
                style={{
                  width: `${Math.round(stats.progress * 100)}%`,
                  background: isWebSeed ? "#4ade80" : "hsl(var(--primary))",
                  opacity: 0.7,
                }}
              />
            </div>
            <span className="text-white/30 text-xs shrink-0 tabular-nums">
              {Math.round(stats.progress * 100)}%
            </span>
          </div>

          {/* Peers (0 for WebSeed is expected and correct) */}
          <span className="text-white/20 text-xs shrink-0">{stats.peers}p</span>

          {/* Unmute button (appears only if autoplay forced mute) */}
          {muted && (
            <button
              onClick={toggleMute}
              className="flex items-center gap-1 rounded-full bg-yellow-500/15 border border-yellow-400/25 px-2.5 py-1 text-xs text-yellow-300 hover:bg-yellow-500/25 transition-colors shrink-0"
            >
              <Volume2 className="h-3 w-3" />
              رفع الصوت
            </button>
          )}

          {/* Subtitle upload */}
          <input ref={fileInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSubFile} />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-xs text-white/45 hover:text-white/75 hover:bg-white/10 transition-colors shrink-0"
          >
            <Upload className="h-3 w-3" />
            ترجمة
          </button>
        </div>
      )}
    </div>
  );
}
