/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useRef, useEffect, useCallback } from "react";
import { Play, AlertCircle, Film, RefreshCw, Upload, Wifi, Volume2 } from "lucide-react";
import { parseSrt } from "@/utils/srt";

function formatSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
}

function msToVtt(ms: number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1_000))}.${pad(ms % 1_000, 3)}`;
}
function srtToVtt(srt: string): string {
  return `WEBVTT\n\n${parseSrt(srt).map((c) => `${msToVtt(c.start)} --> ${msToVtt(c.end)}\n${c.text}`).join("\n\n")}`;
}

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
  hash: string;
  quality: string;
  seeds: number;
  name: string;
  torrentUrl: string;
}

interface Stats {
  speed: number;
  progress: number;
  peers: number;
}

export default function TorrentPlayer({ imdbId, type = "movie", season, episode, title, subtitleUrl }: Props) {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const clientRef    = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trackBlobRef = useRef<string | null>(null);
  const statsTimer   = useRef<ReturnType<typeof setInterval> | null>(null);

  const [phase,    setPhase]  = useState<Phase>("idle");
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
    if (clientRef.current) {
      try { clientRef.current.destroy(); } catch {}
      clientRef.current = null;
    }
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
    setPhase("idle");
    setError("");
    setInfo(null);
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

  const buildQuery = useCallback(() => {
    const p = new URLSearchParams({ type });
    if (season)  p.set("season",  season);
    if (episode) p.set("episode", episode);
    if (title)   p.set("title",   title);
    return p.toString();
  }, [type, season, episode, title]);

  const start = useCallback(async () => {
    destroyClient();
    setPhase("fetching");
    setError("");
    setStats({ speed: 0, progress: 0, peers: 0 });

    try {
      const qs   = buildQuery();
      const resp = await fetch(`/api/torrent-info/${imdbId}?${qs}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? "لا توجد تورنتات متاحة");
      }
      const torrentInfo = await resp.json() as TorrentInfo;
      setInfo(torrentInfo);
      setPhase("loading");

      const mod = await import("webtorrent/dist/webtorrent.min.js" as any);
      const WebTorrent = mod.default ?? mod;
      const client = new WebTorrent({ storage: false });
      clientRef.current = client;

      client.on("error", (err: Error) => {
        setError(err?.message ?? "خطأ في المشغل");
        setPhase("error");
        destroyClient();
      });

      client.add(
        torrentInfo.torrentUrl,
        {
          announce: [
            "wss://tracker.openwebtorrent.com",
            "wss://tracker.btorrent.xyz",
            "wss://tracker.fastcast.nz",
          ],
        },
        (torrent: any) => {
          const videoExts = /\.(mp4|mkv|webm|avi|mov)$/i;
          const candidates: any[] = torrent.files.filter((f: any) => videoExts.test(f.name));
          const file: any = candidates.length
            ? candidates.reduce((a: any, b: any) => a.length > b.length ? a : b)
            : torrent.files.reduce((a: any, b: any) => a.length > b.length ? a : b);

          const videoEl = videoRef.current;
          if (!videoEl) return;

          file.renderTo(videoEl, { autoplay: true, muted: false }, (err: Error | null) => {
            if (err) {
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
        }
      );

    } catch (err: any) {
      setError(err?.message ?? "خطأ غير معروف");
      setPhase("error");
    }
  }, [imdbId, buildQuery, destroyClient]);

  const toggleMute = useCallback(() => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setMuted(videoRef.current.muted);
  }, []);

  const isPlaying = phase === "playing";

  return (
    <div className="w-full flex flex-col bg-black">

      {/* ── Video frame (16:9) ──────────────────────────────────────────── */}
      <div className="relative w-full" style={{ aspectRatio: "16/9" }}>

        {phase === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10">
            <div className="rounded-full bg-white/8 p-5 border border-white/10">
              <Film className="h-10 w-10 text-white/50" />
            </div>
            <div className="text-center px-6">
              <p className="text-white/75 text-sm font-medium mb-1">مشغّل التورنت</p>
              <p className="text-white/35 text-xs">بث مباشر عبر WebSeeds · يعمل بدون peers</p>
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

        {phase === "fetching" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
            <Wifi className="h-8 w-8 text-primary animate-pulse" />
            <p className="text-white/70 text-sm">جارٍ البحث عن أفضل تورنت…</p>
          </div>
        )}

        {phase === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10">
            <div className="w-12 h-12 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            <div className="text-center px-8">
              <p className="text-white/80 text-sm">جارٍ تحميل ملف التورنت…</p>
              {info && (
                <p className="text-primary/70 text-xs mt-1">{info.quality} · {info.seeds} seeds</p>
              )}
              <p className="text-white/25 text-xs mt-2">سيبدأ البث فور اكتشاف WebSeed</p>
            </div>
            <button
              onClick={() => { destroyClient(); setPhase("idle"); }}
              className="text-white/30 text-xs hover:text-white/60 transition-colors"
            >
              إلغاء
            </button>
          </div>
        )}

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

        {/* Video — always in DOM, hidden until playing */}
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
          {trackUrl && (
            <track kind="subtitles" src={trackUrl} srcLang="ar" label="العربية" default />
          )}
        </video>
      </div>

      {/* ── Stats bar — completely BELOW player, never blocks controls ──── */}
      {isPlaying && (
        <div className="flex items-center gap-2 px-3 py-2 bg-black border-t border-white/5 flex-wrap gap-y-1.5">

          <div className="flex items-center gap-1.5 rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-xs shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            <span className="text-white/55">WebTorrent</span>
          </div>

          {info && (
            <span className="text-white/50 text-xs font-medium shrink-0 bg-white/5 px-2 py-1 rounded-full border border-white/10">
              {info.quality}
            </span>
          )}

          <span className="text-primary/80 text-xs font-mono shrink-0">
            {formatSpeed(stats.speed)}
          </span>

          <div className="flex-1 min-w-[50px] flex items-center gap-1.5">
            <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary/70 rounded-full transition-all duration-1000"
                style={{ width: `${Math.round(stats.progress * 100)}%` }}
              />
            </div>
            <span className="text-white/30 text-xs shrink-0">
              {Math.round(stats.progress * 100)}%
            </span>
          </div>

          <span className="text-white/25 text-xs shrink-0">{stats.peers}p</span>

          {muted && (
            <button
              onClick={toggleMute}
              className="flex items-center gap-1 rounded-full bg-yellow-500/20 border border-yellow-400/30 px-2.5 py-1 text-xs text-yellow-300 hover:bg-yellow-500/30 transition-colors shrink-0"
            >
              <Volume2 className="h-3 w-3" />
              رفع الصوت
            </button>
          )}

          <input ref={fileInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSubFile} />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-xs text-white/50 hover:text-white/80 hover:bg-white/10 transition-colors shrink-0"
          >
            <Upload className="h-3 w-3" />
            ترجمة
          </button>
        </div>
      )}
    </div>
  );
}
