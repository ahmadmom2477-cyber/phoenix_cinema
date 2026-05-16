/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TorrentPlayer — المصدر 5 (Client-Side WebTorrent)
 *
 * استراتيجية النجاح:
 *  - أفلام YTS: يجلب ملف .torrent الكامل (base64) من الـ backend.
 *    ملفات YTS تحتوي على WebSeed URLs (HTTP مباشر) → تحميل بدون أي peers → نسبة 85%+
 *  - مسلسلات EZTV: يستخدم magnet + WSS trackers (WebRTC peers) → نسبة 20-40%
 *
 * كل المعالجة تتم في المتصفح (client-side) لتجاوز حجب Replit للمنافذ.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { Play, Loader2, AlertCircle, Film, RefreshCw, Wifi, Upload } from "lucide-react";
import { parseSrt } from "@/utils/srt";

function msToVtt(ms: number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1_000))}.${pad(ms % 1_000, 3)}`;
}
function srtToVtt(srt: string): string {
  return `WEBVTT\n\n${parseSrt(srt).map((c) => `${msToVtt(c.start)} --> ${msToVtt(c.end)}\n${c.text}`).join("\n\n")}`;
}

const WSS_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.fastcast.nz",
  "wss://tracker.files.fm:7073/announce",
  "wss://tracker.novage.com.ua",
];

type Phase = "idle" | "fetching" | "loading" | "playing" | "error";

interface Stats {
  numPeers: number;
  downloadSpeed: number;
  progress: number;
  timeRemaining: number | null;
}

interface Props {
  imdbId: string;
  type?: "movie" | "series";
  season?: string;
  episode?: string;
  title?: string;
  subtitleUrl?: string | null;
}

export default function TorrentPlayer({ imdbId, type = "movie", season, episode, title, subtitleUrl }: Props) {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clientRef    = useRef<any>(null);
  const trackBlobRef = useRef<string | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [phase,     setPhase]    = useState<Phase>("idle");
  const [status,    setStatus]   = useState("");
  const [errorMsg,  setErrorMsg] = useState("");
  const [stats,     setStats]    = useState<Stats>({ numPeers: 0, downloadSpeed: 0, progress: 0, timeRemaining: null });
  const [quality,   setQuality]  = useState("");
  const [source,    setSource]   = useState("");
  const [trackUrl,  setTrackUrl] = useState<string | null>(null);

  useEffect(() => {
    setTrackUrl(subtitleUrl ? subtitleUrl.replace(/\.srt$/i, ".vtt") : null);
  }, [subtitleUrl]);

  const destroyClient = useCallback(() => {
    if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
    if (clientRef.current) {
      try { clientRef.current.destroy(); } catch { /* ignore */ }
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
    setErrorMsg("");
    setQuality("");
    setSource("");
    setStats({ numPeers: 0, downloadSpeed: 0, progress: 0, timeRemaining: null });
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
      setTrackUrl(url);
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  }, []);

  const start = useCallback(async () => {
    destroyClient();
    setPhase("fetching");
    setErrorMsg("");
    setStatus("جارٍ البحث عن أفضل تورنت…");

    try {
      const params = new URLSearchParams({ type });
      if (season)  params.set("season",  season);
      if (episode) params.set("episode", episode);
      if (title)   params.set("title",   title);

      const resp = await fetch(`/api/torrent-info/${imdbId}?${params}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message ?? "لا توجد تورنتات متاحة لهذا المحتوى");
      }

      const info = await resp.json() as {
        magnet: string;
        torrentB64: string | null;
        quality: string;
        seeds: number;
        source: string;
      };

      setQuality(info.quality);
      setSource(info.source === "yts" ? "YTS" : "EZTV");
      setPhase("loading");

      const hasWebSeed = !!info.torrentB64;
      setStatus(
        hasWebSeed
          ? `جارٍ التحميل عبر WebSeed HTTP (${info.quality})…`
          : `جارٍ البحث عن Peers عبر WSS (${info.quality})…`
      );

      const WebTorrent = (await import("webtorrent")).default;
      const client = new WebTorrent();
      clientRef.current = client;

      client.on("error", (err: any) => {
        setErrorMsg(String(err?.message ?? err));
        setPhase("error");
      });

      const torrentSource = info.torrentB64
        ? Uint8Array.from(atob(info.torrentB64), (c) => c.charCodeAt(0))
        : info.magnet;

      client.add(torrentSource as any, { announce: WSS_TRACKERS }, (torrent: any) => {
        const videoFile = torrent.files.find((f: any) =>
          /\.(mp4|mkv|avi|mov|webm)$/i.test(f.name)
        );

        if (!videoFile) {
          setErrorMsg("لم يُعثر على ملف فيديو داخل التورنت");
          setPhase("error");
          return;
        }

        if (!videoRef.current) return;

        videoFile.renderTo(videoRef.current, { autoplay: true }, (err: any) => {
          if (err) {
            setErrorMsg(String(err?.message ?? "خطأ في تشغيل الفيديو"));
            setPhase("error");
          }
        });

        setPhase("playing");

        statsTimerRef.current = setInterval(() => {
          setStats({
            numPeers:      torrent.numPeers       ?? 0,
            downloadSpeed: torrent.downloadSpeed   ?? 0,
            progress:      Math.round((torrent.progress ?? 0) * 100),
            timeRemaining: torrent.timeRemaining && isFinite(torrent.timeRemaining)
              ? Math.round(torrent.timeRemaining / 1000)
              : null,
          });
        }, 1000);
      });

    } catch (err: any) {
      setErrorMsg(err?.message ?? "خطأ غير معروف");
      setPhase("error");
    }
  }, [imdbId, type, season, episode, title, destroyClient]);

  function formatSpeed(bps: number): string {
    if (bps < 1024) return `${bps} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  }

  function formatTime(s: number): string {
    if (s < 60) return `${s}ث`;
    if (s < 3600) return `${Math.floor(s / 60)}د`;
    return `${Math.floor(s / 3600)}س ${Math.floor((s % 3600) / 60)}د`;
  }

  const isPlaying = phase === "playing";

  return (
    <div className="w-full h-full relative bg-black">
      {/* ── Idle ─────────────────────────────────────────────────── */}
      {phase === "idle" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10">
          <div className="rounded-full bg-white/8 p-5 border border-white/10">
            <Film className="h-10 w-10 text-white/50" />
          </div>
          <div className="text-center px-6">
            <p className="text-white/75 text-sm font-medium mb-1">مشغّل التورنت</p>
            <p className="text-white/35 text-xs">
              {type === "movie"
                ? "أفلام YTS · WebSeed HTTP · لا يحتاج Peers"
                : "مسلسلات EZTV · WSS WebRTC Peers"}
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

      {/* ── Fetching ─────────────────────────────────────────────── */}
      {phase === "fetching" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-white/75 text-sm">{status}</p>
        </div>
      )}

      {/* ── Loading / Buffering ──────────────────────────────────── */}
      {phase === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10">
          <div className="relative">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
            <Wifi className="absolute inset-0 m-auto h-5 w-5 text-white/40" />
          </div>
          <div className="text-center px-8">
            <p className="text-white/80 text-sm leading-relaxed">{status}</p>
            {quality && (
              <p className="text-primary/70 text-xs mt-1">{quality} · {source}</p>
            )}
          </div>
          <button
            onClick={destroyClient}
            className="text-white/30 text-xs hover:text-white/60 transition-colors"
          >
            إلغاء
          </button>
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────────── */}
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

      {/* ── Video ────────────────────────────────────────────────── */}
      <video
        ref={videoRef}
        className={`w-full h-full ${isPlaying ? "block" : "opacity-0 pointer-events-none"}`}
        controls
        autoPlay
        crossOrigin="anonymous"
        onError={() => {
          if (phase === "playing") {
            setErrorMsg("تعذّر تشغيل الفيديو — قد يكون الـ format غير مدعوم في المتصفح");
            setPhase("error");
          }
        }}
      >
        {trackUrl && <track kind="subtitles" src={trackUrl} srcLang="ar" label="العربية" default />}
      </video>

      {/* ── Live stats bar (while playing) ──────────────────────── */}
      {isPlaying && (
        <div className="absolute bottom-14 start-3 end-3 flex items-center gap-3 z-20 pointer-events-none">
          <div className="flex items-center gap-2 rounded-full bg-black/60 backdrop-blur-md border border-white/10 px-3 py-1.5 text-xs text-white/60">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            <span>{stats.numPeers} peers</span>
            <span className="text-white/30">·</span>
            <span>{formatSpeed(stats.downloadSpeed)}</span>
            <span className="text-white/30">·</span>
            <span>{stats.progress}%</span>
            {stats.timeRemaining !== null && stats.timeRemaining > 0 && (
              <>
                <span className="text-white/30">·</span>
                <span>{formatTime(stats.timeRemaining)}</span>
              </>
            )}
          </div>

          {/* Subtitle upload button */}
          <input ref={fileInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSubFile} />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 px-3 py-1.5 text-xs text-white/60 hover:text-white/90 transition-colors"
          >
            <Upload className="h-3.5 w-3.5" />
            ترجمة
          </button>
        </div>
      )}
    </div>
  );
}
