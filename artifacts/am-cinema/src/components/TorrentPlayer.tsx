/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TorrentPlayer — Player 5 (Server-Side Streaming)
 *
 * Architecture:
 *   Browser → HTTP range requests → Express backend → torrent-stream (TCP/UDP) → BitTorrent peers
 *
 * Why server-side?
 *   Browser-based WebTorrent uses WebRTC, which only connects to OTHER browser clients.
 *   Regular seeders (qBittorrent, uTorrent, etc.) don't speak WebRTC → 0 peers forever.
 *   The backend uses torrent-stream over TCP/UDP → connects to ALL seeders normally.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { Upload, Play, Loader2, AlertCircle, Film, Server, RefreshCw } from "lucide-react";
import { parseSrt } from "@/utils/srt";

// ── SRT → VTT ─────────────────────────────────────────────────────────────────
function msToVtt(ms: number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1_000))}.${pad(ms % 1_000, 3)}`;
}
function srtToVtt(srt: string): string {
  return `WEBVTT\n\n${parseSrt(srt).map((c) => `${msToVtt(c.start)} --> ${msToVtt(c.end)}\n${c.text}`).join("\n\n")}`;
}

// ── Component ─────────────────────────────────────────────────────────────────
type Phase = "idle" | "fetching" | "buffering" | "playing" | "error";

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
  const trackBlobRef = useRef<string | null>(null);
  const abortRef     = useRef<AbortController | null>(null);

  const [phase,       setPhase]       = useState<Phase>("idle");
  const [status,      setStatus]      = useState("");
  const [streamLabel, setStreamLabel] = useState("");
  const [errorMsg,    setErrorMsg]    = useState("");
  const [trackUrl,    setTrackUrl]    = useState<string | null>(null);

  // Auto subtitle from prop
  useEffect(() => {
    setTrackUrl(subtitleUrl ? subtitleUrl.replace(/\.srt$/i, ".vtt") : null);
  }, [subtitleUrl]);

  // Manual subtitle upload
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

  // Build query params for the backend
  const buildParams = useCallback(() => {
    const p = new URLSearchParams({ type });
    if (season)  p.set("season",  season);
    if (episode) p.set("episode", episode);
    if (title)   p.set("title",   title);
    return p.toString();
  }, [type, season, episode, title]);

  // Cleanup on unmount or reset
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
  }, []);

  useEffect(() => () => {
    reset();
    if (trackBlobRef.current) URL.revokeObjectURL(trackBlobRef.current);
  }, [reset]);

  // Reset when media changes
  useEffect(() => {
    setPhase("idle");
    setStreamLabel("");
    setErrorMsg("");
    reset();
  }, [imdbId, season, episode, reset]);

  // ── Start streaming ─────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    reset();
    setPhase("fetching");
    setErrorMsg("");
    setStreamLabel("");
    setStatus("جارٍ البحث عن أفضل مصدر (1080p)…");

    abortRef.current = new AbortController();

    try {
      // Step 1: Fetch metadata from backend (checks torrentsdb → YTS → APIBay)
      const metaRes = await fetch(
        `/api/torrent-stream/${imdbId}?${buildParams()}`,
        { signal: abortRef.current.signal }
      );

      if (!metaRes.ok) {
        const err = await metaRes.json().catch(() => ({ message: "لا توجد مصادر تورنت متاحة" })) as { message?: string };
        throw new Error(err.message ?? "لا توجد مصادر تورنت متاحة لهذا الفيلم");
      }

      const meta = await metaRes.json() as { label: string; seeds: number; quality: string };
      setStreamLabel(meta.label);

      // Step 2: Point the video element at the streaming endpoint
      // The backend will start downloading via torrent-stream (TCP/UDP) and pipe bytes
      setPhase("buffering");
      setStatus(`${meta.label} — جارٍ تحميل أول قطعة من البيانات…`);

      const streamUrl = `/api/torrent-stream/${imdbId}/play?${buildParams()}`;

      if (videoRef.current) {
        videoRef.current.src = streamUrl;
        videoRef.current.load();
        videoRef.current.play().catch(() => {
          // Autoplay blocked — user can press play in the native controls
        });
      }

      setPhase("playing");

    } catch (err: any) {
      if (err?.name === "AbortError") return;
      setErrorMsg(err?.message ?? "خطأ غير معروف أثناء الاتصال بالخادم");
      setPhase("error");
    }
  }, [imdbId, buildParams, reset]);

  // ── Render ──────────────────────────────────────────────────────────────────
  const isLoading = phase === "fetching" || phase === "buffering";
  const isActive  = phase === "playing";

  return (
    <div className="relative w-full bg-black" style={{ aspectRatio: "16/9" }}>

      {/* ── Idle ── */}
      {phase === "idle" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/90">
          <div className="rounded-full bg-white/10 p-5">
            <Film className="h-10 w-10 text-white/60" />
          </div>
          <div className="text-center">
            <p className="text-white/70 text-sm font-medium mb-1">مشغّل التورنت — بث مباشر عبر الخادم</p>
            <p className="text-white/35 text-xs">يتصل بالـ Seeders عبر TCP/UDP · لا يحتاج WebRTC</p>
          </div>
          <button
            onClick={start}
            className="flex items-center gap-2 rounded-full bg-red-600 px-8 py-3 text-white font-semibold hover:bg-red-500 active:scale-95 transition-all"
          >
            <Play className="h-5 w-5 fill-current" />
            تشغيل
          </button>
        </div>
      )}

      {/* ── Loading ── */}
      {isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/90 z-10">
          <Loader2 className="h-10 w-10 animate-spin text-red-500" />
          <div className="text-center px-8">
            <p className="text-white/80 text-sm leading-relaxed">{status}</p>
            {streamLabel && (
              <p className="text-white/40 text-xs mt-2 flex items-center justify-center gap-1.5">
                <Server className="h-3 w-3" />
                {streamLabel}
              </p>
            )}
          </div>

          {/* Phase steps */}
          <div className="flex items-center gap-3 text-xs">
            <Step active={phase === "fetching"}  done={phase === "buffering" || isActive} label="البحث عن مصدر" />
            <div className="w-5 h-px bg-white/15" />
            <Step active={phase === "buffering"} done={isActive}                          label="بدء البث" />
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {phase === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/90 z-10 text-center px-6">
          <AlertCircle className="h-10 w-10 text-red-500" />
          <p className="text-white/80 text-sm leading-relaxed">{errorMsg}</p>
          <button
            onClick={start}
            className="flex items-center gap-2 rounded-full border border-white/20 px-6 py-2.5 text-white/70 text-sm hover:bg-white/10 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            إعادة المحاولة
          </button>
        </div>
      )}

      {/* ── Video element (always mounted, shown when playing) ── */}
      <video
        ref={videoRef}
        className={`w-full h-full ${isActive ? "block" : "hidden"}`}
        controls
        autoPlay
        crossOrigin="anonymous"
        onError={() => {
          if (phase === "playing") {
            setErrorMsg("تعذّر بث الفيديو — الخادم لا يزال يبحث عن Seeders، حاول مجدداً بعد لحظات");
            setPhase("error");
          }
        }}
        onWaiting={() => {
          if (phase === "playing") setStatus("جارٍ التحميل المسبق…");
        }}
      >
        {trackUrl && (
          <track kind="subtitles" src={trackUrl} srcLang="ar" label="العربية" default />
        )}
      </video>

      {/* ── Stream label badge (playing) ── */}
      {isActive && streamLabel && (
        <div className="absolute top-3 left-3 flex items-center gap-2 rounded-xl bg-black/70 px-3 py-1.5 text-xs text-white/70 backdrop-blur-sm pointer-events-none border border-white/10">
          <Server className="h-3 w-3 text-green-400" />
          <span>{streamLabel}</span>
        </div>
      )}

      {/* ── Subtitle controls ── */}
      <div className="absolute bottom-14 right-3 flex items-center gap-2 z-20">
        <input
          ref={fileInputRef}
          type="file"
          accept=".srt,.vtt"
          className="hidden"
          onChange={handleSubFile}
        />
        {(isActive || isLoading) && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white/70 backdrop-blur-sm hover:bg-black/80 transition-colors"
          >
            <Upload className="h-3.5 w-3.5" />
            ترجمة
          </button>
        )}
        {trackUrl && isActive && (
          <button
            onClick={() => {
              setTrackUrl(null);
              if (trackBlobRef.current) {
                URL.revokeObjectURL(trackBlobRef.current);
                trackBlobRef.current = null;
              }
            }}
            className="rounded-full bg-black/60 px-3 py-1.5 text-xs text-white/50 backdrop-blur-sm hover:bg-black/80 transition-colors"
          >
            إزالة الترجمة
          </button>
        )}
      </div>
    </div>
  );
}

// ── Step indicator ─────────────────────────────────────────────────────────────
function Step({ done, active, label }: { done: boolean; active: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`h-2 w-2 rounded-full transition-colors ${done ? "bg-green-400" : active ? "bg-red-400 animate-pulse" : "bg-white/20"}`} />
      <span className={`text-[10px] ${done ? "text-green-400" : active ? "text-white/80" : "text-white/30"}`}>{label}</span>
    </div>
  );
}
