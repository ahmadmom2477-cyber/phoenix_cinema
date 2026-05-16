/* eslint-disable @typescript-eslint/no-explicit-any */
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

type Phase = "idle" | "fetching" | "warming" | "playing" | "error";

interface Props {
  imdbId: string;
  type?: "movie" | "series";
  season?: string;
  episode?: string;
  title?: string;
  subtitleUrl?: string | null;
}

export default function TorrentPlayer({
  imdbId, type = "movie", season, episode, title, subtitleUrl,
}: Props) {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef     = useRef<AbortController | null>(null);
  const trackBlobRef = useRef<string | null>(null);

  const [phase,    setPhase]   = useState<Phase>("idle");
  const [status,   setStatus]  = useState("");
  const [errorMsg, setError]   = useState("");
  const [quality,  setQuality] = useState("");
  const [seeds,    setSeeds]   = useState(0);
  const [trackUrl, setTrack]   = useState<string | null>(null);
  const [dots,     setDots]    = useState(0);

  useEffect(() => {
    setTrack(subtitleUrl ? subtitleUrl.replace(/\.srt$/i, ".vtt") : null);
  }, [subtitleUrl]);

  useEffect(() => {
    if (phase !== "warming") return;
    const id = setInterval(() => setDots((d) => (d + 1) % 4), 500);
    return () => clearInterval(id);
  }, [phase]);

  const buildQuery = useCallback(() => {
    const p = new URLSearchParams({ type });
    if (season)  p.set("season",  season);
    if (episode) p.set("episode", episode);
    if (title)   p.set("title",   title);
    return p.toString();
  }, [type, season, episode, title]);

  const stop = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
  }, []);

  useEffect(() => () => {
    stop();
    if (trackBlobRef.current) URL.revokeObjectURL(trackBlobRef.current);
  }, [stop]);

  useEffect(() => {
    setPhase("idle");
    setError("");
    setQuality("");
    setSeeds(0);
    stop();
  }, [imdbId, season, episode, stop]);

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
    stop();
    setPhase("fetching");
    setError("");
    setStatus("جارٍ البحث عن أفضل تورنت…");

    const qs = buildQuery();
    abortRef.current = new AbortController();

    try {
      // ── 1. Kick off server-side engine + get metadata ─────────────────────
      const resp = await fetch(`/api/torrent-stream/${imdbId}?${qs}`, {
        signal: abortRef.current.signal,
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? "لا توجد تورنتات متاحة");
      }

      const meta = await resp.json() as {
        label: string;
        seeds: number;
        quality: string;
      };

      setQuality(meta.quality ?? "");
      setSeeds(meta.seeds ?? 0);
      setPhase("warming");
      setStatus(`جارٍ الاتصال بالـ peers`);

      // ── 2. Poll /status until engine ready ────────────────────────────────
      let attempts = 0;
      const MAX_ATTEMPTS = 60; // 2 min max

      await new Promise<void>((resolve, reject) => {
        pollRef.current = setInterval(async () => {
          if (abortRef.current?.signal.aborted) {
            reject(new Error("cancelled"));
            return;
          }
          attempts++;
          if (attempts > MAX_ATTEMPTS) {
            reject(new Error("انتهت مهلة الاتصال — جرّب مصدراً آخر"));
            return;
          }

          try {
            const s = await fetch(`/api/torrent-stream/${imdbId}/status?${qs}`);
            const data = await s.json() as {
              state: string;
              ready: boolean;
              errorMessage?: string | null;
            };

            if (data.state === "ready") {
              resolve();
            } else if (data.state === "error") {
              reject(new Error(data.errorMessage ?? "خطأ في الـ engine"));
            }
            // else "warming" → keep polling
          } catch {
            // ignore fetch errors during polling
          }
        }, 2_000);
      });

      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

      // ── 3. Set video src — plain HTTP stream from server ──────────────────
      const playUrl = `/api/torrent-stream/${imdbId}/play?${qs}`;
      if (videoRef.current) {
        videoRef.current.src = playUrl;
        videoRef.current.load();
        videoRef.current.play().catch(() => { /* user gesture may be needed */ });
      }
      setPhase("playing");

    } catch (err: any) {
      if (err?.name === "AbortError" || err?.message === "cancelled") return;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setError(err?.message ?? "خطأ غير معروف");
      setPhase("error");
    }
  }, [imdbId, buildQuery, stop]);

  const isPlaying = phase === "playing";
  const warmingDots = ".".repeat(dots + 1);

  return (
    <div className="w-full flex flex-col bg-black">

      {/* ── Player area ──────────────────────────────────────────────── */}
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
                يعمل عبر Server Streaming — بدون مشاكل المتصفح
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
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <p className="text-white/75 text-sm">{status}</p>
          </div>
        )}

        {/* Warming — server engine connecting to peers */}
        {phase === "warming" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 z-10">
            <div className="relative">
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
              <Wifi className="absolute inset-0 m-auto h-5 w-5 text-white/40" />
            </div>
            <div className="text-center px-8">
              <p className="text-white/80 text-sm leading-relaxed">
                {status}{warmingDots}
              </p>
              {quality && seeds > 0 && (
                <p className="text-primary/70 text-xs mt-1">{quality} · {seeds} seeds</p>
              )}
              <p className="text-white/30 text-xs mt-2">
                السيرفر يتصل بالـ peers — قد يستغرق 30–90 ثانية
              </p>
            </div>
            <button onClick={() => { stop(); setPhase("idle"); }}
              className="text-white/30 text-xs hover:text-white/60 transition-colors">
              إلغاء
            </button>
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 z-10 text-center px-6">
            <AlertCircle className="h-10 w-10 text-red-500" />
            <p className="text-white/80 text-sm leading-relaxed max-w-xs">{errorMsg}</p>
            <button onClick={start}
              className="flex items-center gap-2 rounded-full border border-white/20 px-6 py-2.5 text-white/70 text-sm hover:bg-white/10 transition-colors">
              <RefreshCw className="h-4 w-4" />
              إعادة المحاولة
            </button>
          </div>
        )}

        {/* Video */}
        <video
          ref={videoRef}
          className={`absolute inset-0 w-full h-full ${isPlaying ? "block" : "opacity-0 pointer-events-none"}`}
          controls
          autoPlay
          crossOrigin="anonymous"
          onError={() => {
            if (phase === "playing") {
              setError("تعذّر تشغيل الفيديو — المصدر غير متاح أو الـ format غير مدعوم");
              setPhase("error");
            }
          }}
        >
          {trackUrl && <track kind="subtitles" src={trackUrl} srcLang="ar" label="العربية" default />}
        </video>
      </div>

      {/* ── Bottom bar — subtitle upload only ────────────────────────── */}
      {isPlaying && (
        <div className="flex items-center gap-3 px-3 py-2 bg-black/80 border-t border-white/5">
          <div className="flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-xs text-white/60 flex-1 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0 animate-pulse" />
            <span className="shrink-0">Server Stream</span>
            <span className="text-white/25">·</span>
            <span className="shrink-0 text-white/40">{quality}</span>
          </div>
          <input ref={fileInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSubFile} />
          <button onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-xs text-white/60 hover:text-white/90 hover:bg-white/10 transition-colors shrink-0">
            <Upload className="h-3.5 w-3.5" />
            ترجمة
          </button>
        </div>
      )}
    </div>
  );
}
