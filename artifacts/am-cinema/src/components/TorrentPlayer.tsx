import { useState, useRef, useEffect, useCallback } from "react";
import { Loader2, RefreshCw, AlertCircle, Film, Maximize, Settings, ChevronUp, ChevronDown } from "lucide-react";
import { parseSrt } from "@/utils/srt";

interface SrtCue { start: number; end: number; text: string }

interface TorrentPlayerProps {
  imdbId: string;
  type: "movie" | "series";
  season?: string;
  episode?: string;
  title?: string;
  subtitleUrl?: string | null;
}

const SOURCES = [
  {
    id: "vidlink",
    label: "VidLink",
    buildUrl: (imdbId: string, type: string, season: string, episode: string) =>
      type === "series"
        ? `https://vidlink.pro/tv/${imdbId}/${season}/${episode}?autoplay=true&title=false`
        : `https://vidlink.pro/movie/${imdbId}?autoplay=true&title=false`,
  },
  {
    id: "videasy",
    label: "Videasy",
    buildUrl: (imdbId: string, type: string, season: string, episode: string) =>
      type === "series"
        ? `https://player.videasy.net/tv/${imdbId}/${season}/${episode}`
        : `https://player.videasy.net/movie/${imdbId}`,
  },
  {
    id: "embedsu",
    label: "EmbedSu",
    buildUrl: (imdbId: string, type: string, season: string, episode: string) =>
      type === "series"
        ? `https://embed.su/embed/tv/${imdbId}/${season}/${episode}`
        : `https://embed.su/embed/movie/${imdbId}`,
  },
];

/**
 * Player 5 — Multi-source iframe embed with timer-based Arabic SRT overlay.
 * Falls back through VidLink → Videasy → EmbedSu automatically.
 * Subtitle overlay: timer starts on iframe load, cues shown based on elapsed time.
 */
export default function TorrentPlayer({
  imdbId,
  type,
  season = "1",
  episode = "1",
  title,
  subtitleUrl,
}: TorrentPlayerProps) {
  const [srcIdx, setSrcIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SRT overlay state
  const [cues, setCues] = useState<SrtCue[]>([]);
  const [currentCue, setCurrentCue] = useState<SrtCue | null>(null);
  const [subOffset, setSubOffset] = useState(0); // ms offset
  const [playStartMs, setPlayStartMs] = useState<number | null>(null);
  const [showSubSettings, setShowSubSettings] = useState(false);
  const rafRef = useRef<number | null>(null);
  const prevSubUrlRef = useRef<string | null>(null);

  const source = SOURCES[srcIdx]!;
  const embedUrl = source.buildUrl(imdbId, type, season, episode);
  const hasNext = srcIdx < SOURCES.length - 1;

  // Load & parse SRT when subtitleUrl changes
  useEffect(() => {
    if (!subtitleUrl || subtitleUrl === prevSubUrlRef.current) return;
    prevSubUrlRef.current = subtitleUrl;
    setCues([]);
    setCurrentCue(null);
    setSubOffset(0);
    fetch(subtitleUrl)
      .then((r) => r.text())
      .then((text) => {
        const parsed = parseSrt(text);
        setCues(parsed);
      })
      .catch(() => {});
  }, [subtitleUrl]);

  // Clear cues when subtitle removed
  useEffect(() => {
    if (!subtitleUrl) {
      setCues([]);
      setCurrentCue(null);
      prevSubUrlRef.current = null;
    }
  }, [subtitleUrl]);

  // Timer-based cue rendering
  const tick = useCallback(() => {
    if (playStartMs === null || cues.length === 0) {
      setCurrentCue(null);
      return;
    }
    const elapsed = Date.now() - playStartMs + subOffset;
    const active = cues.find((c) => elapsed >= c.start && elapsed <= c.end) ?? null;
    setCurrentCue(active);
    rafRef.current = requestAnimationFrame(tick);
  }, [playStartMs, cues, subOffset]);

  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (playStartMs !== null && cues.length > 0) {
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [tick, playStartMs, cues]);

  // Reset on source/episode change
  useEffect(() => {
    setLoading(true);
    setFailed(false);
    setPlayStartMs(null);
    setCurrentCue(null);
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(() => setLoading(false), 18000);
    return () => { if (loadTimerRef.current) clearTimeout(loadTimerRef.current); };
  }, [srcIdx, imdbId, season, episode]);

  const handleLoad = () => {
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    setLoading(false);
    // Start subtitle timer from iframe load
    if (cues.length > 0) setPlayStartMs(Date.now());
  };

  const startSubtitleTimer = () => {
    setPlayStartMs(Date.now());
  };

  const tryNext = () => {
    if (hasNext) setSrcIdx((i) => i + 1);
    else { setFailed(true); setLoading(false); }
  };

  const handleFullscreen = () => {
    const el = iframeRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {
        (el as HTMLIFrameElement & { webkitRequestFullscreen?: () => void }).webkitRequestFullscreen?.();
      });
    }
  };

  if (failed) {
    return (
      <div className="relative w-full h-full bg-black flex flex-col items-center justify-center gap-5 p-6">
        <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center">
          <AlertCircle size={24} className="text-red-400" />
        </div>
        <div className="text-center max-w-xs space-y-2">
          <p className="text-white font-semibold">المشغل 5 غير متاح حالياً</p>
          <p className="text-white/50 text-sm">جرّب أحد المصادر الأخرى (1–4)</p>
        </div>
        <button
          onClick={() => { setSrcIdx(0); setFailed(false); setLoading(true); }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary/15 border border-primary/30 text-primary text-sm font-medium hover:bg-primary/25 transition-all"
        >
          <RefreshCw size={14} /> إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black group">
      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black pointer-events-none">
          <div className="relative">
            <div className="w-14 h-14 rounded-full border-2 border-primary/20 flex items-center justify-center">
              <Film size={22} className="text-primary/60" />
            </div>
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary animate-spin" style={{ animationDuration: "0.8s" }} />
          </div>
          <div className="text-center space-y-1">
            <p className="text-white/80 text-sm font-medium">جاري تحميل المشغل 5…</p>
            <p className="text-white/30 text-xs">{source.label}</p>
          </div>
        </div>
      )}

      {/* Iframe embed */}
      <iframe
        ref={iframeRef}
        key={`${srcIdx}-${imdbId}-${season}-${episode}`}
        src={embedUrl}
        className="w-full h-full border-0"
        allowFullScreen
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        referrerPolicy="no-referrer-when-downgrade"
        onLoad={handleLoad}
        title={title ?? imdbId}
      />

      {/* SRT subtitle overlay — bottom-center cue display */}
      {currentCue && (
        <div
          className="absolute bottom-14 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 rounded-lg text-center pointer-events-none"
          style={{ maxWidth: "90%", background: "rgba(0,0,0,0.78)", backdropFilter: "blur(2px)" }}
        >
          {currentCue.text.split("\n").map((line, i) => (
            <p key={i} className="text-white font-medium text-base leading-snug" dir="auto">{line}</p>
          ))}
        </div>
      )}

      {/* Subtitle timer controls — shown when subtitles loaded */}
      {cues.length > 0 && !loading && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          {playStartMs === null ? (
            <button
              onClick={startSubtitleTimer}
              className="px-3 py-1 rounded-full bg-primary/90 text-white text-[11px] font-semibold shadow-lg hover:bg-primary transition-colors"
            >
              ▶ ابدأ مزامنة الترجمة
            </button>
          ) : (
            <>
              <button onClick={() => setSubOffset((o) => o - 5000)} className="w-7 h-7 rounded-full bg-black/70 border border-white/20 text-white/70 hover:text-white flex items-center justify-center text-[10px] font-bold transition-colors" title="-5s">-5s</button>
              <button onClick={() => setSubOffset((o) => o - 500)} className="w-7 h-7 rounded-full bg-black/70 border border-white/20 text-white/70 hover:text-white flex items-center justify-center text-[10px] font-bold transition-colors" title="-0.5s">-½</button>
              <span className="px-2 py-0.5 rounded-full bg-black/70 border border-primary/40 text-primary text-[10px] font-mono min-w-[50px] text-center">
                {subOffset >= 0 ? "+" : ""}{(subOffset / 1000).toFixed(1)}s
              </span>
              <button onClick={() => setSubOffset((o) => o + 500)} className="w-7 h-7 rounded-full bg-black/70 border border-white/20 text-white/70 hover:text-white flex items-center justify-center text-[10px] font-bold transition-colors" title="+0.5s">+½</button>
              <button onClick={() => setSubOffset((o) => o + 5000)} className="w-7 h-7 rounded-full bg-black/70 border border-white/20 text-white/70 hover:text-white flex items-center justify-center text-[10px] font-bold transition-colors" title="+5s">+5s</button>
              <button onClick={() => { setPlayStartMs(Date.now()); setSubOffset(0); }} className="w-7 h-7 rounded-full bg-primary/80 border border-primary/60 text-white flex items-center justify-center transition-colors hover:bg-primary" title="إعادة ضبط">↺</button>
            </>
          )}
        </div>
      )}

      {/* Source switcher bar (top-left) */}
      {!loading && (
        <div className="absolute top-2 start-2 z-10 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          {SOURCES.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setSrcIdx(i)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all ${
                i === srcIdx
                  ? "bg-primary border-primary text-white"
                  : "bg-black/60 border-white/15 text-white/60 hover:border-white/30 hover:text-white"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Next source button */}
      {!loading && hasNext && (
        <button
          onClick={tryNext}
          className="absolute bottom-16 end-3 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-black/70 backdrop-blur-md border border-white/15 text-white/60 hover:text-white text-xs transition-all opacity-0 group-hover:opacity-100"
        >
          <RefreshCw size={12} /> مصدر آخر
        </button>
      )}

      {/* Fullscreen (mobile) */}
      <button
        onClick={handleFullscreen}
        className="absolute top-2 end-2 z-10 md:hidden w-8 h-8 rounded-lg bg-black/60 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/60 hover:text-white transition-all"
      >
        <Maximize size={15} />
      </button>
    </div>
  );
}
