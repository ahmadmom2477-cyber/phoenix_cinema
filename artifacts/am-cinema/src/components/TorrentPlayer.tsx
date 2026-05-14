/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TorrentPlayer — Player 5
 *
 * Architecture:
 *   Setup → Filter (1080p/720p only, reject 4K) → Load WT → Proxy WebSeeds → Stream → UI
 *
 * WebTorrent is loaded dynamically from the local npm-installed copy (/webtorrent.min.js)
 * via a JS-injected script element — never via a static <script> tag in HTML.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { Upload, Play, Loader2, AlertCircle, Film, Wifi, Zap } from "lucide-react";
import { parseSrt } from "@/utils/srt";

// ── Constants ─────────────────────────────────────────────────────────────────
const CORS_PROXY  = "https://cors-anywhere.herokuapp.com/";
const TRACKERS    = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
  "wss://tracker.files.fm:7073/announce",
  "wss://spacetracker.xyz:443/announce",
];

// ── Quality filter ────────────────────────────────────────────────────────────
/**
 * Filters and ranks streams:
 *   - REJECT: anything containing '4K' or '2160p'
 *   - Rank 1 : 1080p
 *   - Rank 2 : 720p
 *   - Rank 99 : everything else → rejected
 */
interface TDBStream {
  infoHash?: string; name?: string; title?: string;
  seeders?: number; seeds?: number; quality?: string;
  behaviorHints?: { filename?: string };
  sources?: string[]; urlList?: string[];
}

function filterQuality(streams: TDBStream[]): { stream: TDBStream; rank: number; seeds: number }[] {
  return streams
    .filter((s) => {
      const raw = [s.quality ?? "", s.name ?? "", s.title ?? ""].join(" ");
      return !raw.match(/\b(4K|2160p)\b/i);
    })
    .map((s) => {
      const raw   = [s.quality ?? "", s.name ?? "", s.title ?? ""].join(" ");
      const rank  = /\b1080p\b/i.test(raw) ? 1 : /\b720p\b/i.test(raw) ? 2 : 99;
      const seeds = s.seeders ?? s.seeds ?? 0;
      return { stream: s, rank, seeds };
    })
    .filter((e) => e.rank < 99)
    .sort((a, b) => a.rank - b.rank || b.seeds - a.seeds);
}

// ── WebSeed CORS proxy ────────────────────────────────────────────────────────
function proxyWebSeed(url: string): string {
  return url.startsWith("http") ? `${CORS_PROXY}${url}` : url;
}

// ── Load WebTorrent from local npm copy (JS-injected, not static HTML tag) ───
let _wtLoadPromise: Promise<any> | null = null;

function loadWebTorrentLib(): Promise<any> {
  if (_wtLoadPromise) return _wtLoadPromise;
  _wtLoadPromise = new Promise((resolve, reject) => {
    // Already available (e.g. previous load)
    if (typeof (window as any).WebTorrent === "function") {
      resolve((window as any).WebTorrent); return;
    }
    // Inject script from local npm-installed copy (served from /public/)
    const script = document.createElement("script");
    script.src   = "/webtorrent.min.js";   // → node_modules/webtorrent/dist/webtorrent.min.js
    script.async = true;
    script.onload = () => {
      if (typeof (window as any).WebTorrent === "function") {
        resolve((window as any).WebTorrent);
      } else {
        reject(new Error("WebTorrent لم يُصدِّر دالة البناء — تأكد من تفعيل WebRTC في متصفحك"));
      }
    };
    script.onerror = () => reject(new Error("تعذّر تحميل WebTorrent من المصادر المحلية"));
    document.head.appendChild(script);
  });
  return _wtLoadPromise;
}

// ── Tracker ping ──────────────────────────────────────────────────────────────
function pingTracker(url: string, ms = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(url);
      const t  = setTimeout(() => { try { ws.close(); } catch { /**/ } resolve(false); }, ms);
      ws.onopen  = () => { clearTimeout(t); try { ws.close(); } catch { /**/ } resolve(true); };
      ws.onerror = () => { clearTimeout(t); resolve(false); };
    } catch { resolve(false); }
  });
}

async function healthyTrackers(onStatus: (m: string) => void): Promise<string[]> {
  onStatus("جارٍ فحص مسارات الاتصال…");
  const results = await Promise.all(TRACKERS.map((u) => pingTracker(u).then((ok) => ok ? u : null)));
  const alive   = results.filter((r): r is string => r !== null);
  return alive.length > 0 ? alive : TRACKERS;
}

// ── Magnet builder ────────────────────────────────────────────────────────────
function buildMagnet(hash: string, name?: string, trackers = TRACKERS, webSeeds: string[] = []): string {
  const dn = name ? `&dn=${encodeURIComponent(name)}` : "";
  const tr = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  const ws = webSeeds.map((u) => `&ws=${encodeURIComponent(u)}`).join("");
  return `magnet:?xt=urn:btih:${hash}${dn}${tr}${ws}`;
}

// ── TorrentsDB fetch ──────────────────────────────────────────────────────────
interface StreamResult { infoHash: string; name?: string; label: string; webSeeds: string[] }

async function fetchStream(imdbId: string): Promise<StreamResult> {
  const res = await fetch(`https://torrentsdb.com/stream/movie/${imdbId}.json`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("لم يُعثر على مصادر تورنت لهذا الفيلم");

  const json  = await res.json() as { streams?: TDBStream[] };
  const valid = (json?.streams ?? []).filter((s) => !!s.infoHash);
  if (!valid.length) throw new Error("لا توجد مصادر تورنت متاحة لهذا الفيلم");

  // Apply quality filter (reject 4K, keep 1080p/720p)
  const ranked = filterQuality(valid);
  // Fallback: if filter returns nothing, use any available stream
  const pool   = ranked.length > 0 ? ranked.map((r) => r.stream) : valid;

  const best     = pool[0];
  const qualRaw  = [best.quality ?? "", best.name ?? "", best.title ?? ""].join(" ");
  const qualMatch = qualRaw.match(/\b(1080p|720p|480p|SD)\b/i);
  const quality   = qualMatch?.[1] ?? "HD";
  const seeds     = best.seeders ?? best.seeds ?? 0;
  const webSeeds  = [...(best.sources ?? []), ...(best.urlList ?? [])].filter(Boolean);

  return {
    infoHash : best.infoHash!,
    name     : best.name ?? best.title,
    label    : `${quality} · ${seeds} Seeds${webSeeds.length ? ` · ${webSeeds.length} WebSeed` : ""}`,
    webSeeds,
  };
}

// ── SRT → VTT ─────────────────────────────────────────────────────────────────
function msToVtt(ms: number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1_000))}.${pad(ms % 1_000, 3)}`;
}
function srtToVtt(srt: string): string {
  return `WEBVTT\n\n${parseSrt(srt).map((c) => `${msToVtt(c.start)} --> ${msToVtt(c.end)}\n${c.text}`).join("\n\n")}`;
}

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtSpeed = (b: number) =>
  b < 1024 ? `${b} B/s` : b < 1_048_576 ? `${(b / 1024).toFixed(1)} KB/s` : `${(b / 1_048_576).toFixed(2)} MB/s`;

// ── Component ─────────────────────────────────────────────────────────────────
type Phase = "idle" | "checking" | "fetching" | "connecting" | "playing" | "error";

interface Stats { numPeers: number; downloadSpeed: number; webSeedsCount: number }

interface Props {
  imdbId: string;
  type?: "movie" | "series";
  season?: string;
  episode?: string;
  title?: string;
  subtitleUrl?: string | null;
}

export default function TorrentPlayer({ imdbId, title, subtitleUrl }: Props) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<any>(null);
  const statsRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  const [phase,       setPhase]       = useState<Phase>("idle");
  const [status,      setStatus]      = useState("جارٍ التحضير…");
  const [errorMsg,    setErrorMsg]    = useState("");
  const [streamLabel, setStreamLabel] = useState("");
  const [stats,       setStats]       = useState<Stats>({ numPeers: 0, downloadSpeed: 0, webSeedsCount: 0 });
  const [progress,    setProgress]    = useState(0);

  // Subtitle
  const [trackUrl,    setTrackUrl]    = useState<string | null>(null);
  const trackBlobRef  = useRef<string | null>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);

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
      trackBlobRef.current = url; setTrackUrl(url);
    };
    reader.readAsText(file, "utf-8"); e.target.value = "";
  }, []);

  // Cleanup on unmount
  const destroyClient = useCallback(() => {
    if (statsRef.current)  { clearInterval(statsRef.current); statsRef.current = null; }
    if (clientRef.current) { try { clientRef.current.destroy(); } catch { /**/ } clientRef.current = null; }
    setStats({ numPeers: 0, downloadSpeed: 0, webSeedsCount: 0 }); setProgress(0);
  }, []);

  useEffect(() => () => {
    destroyClient();
    if (trackBlobRef.current) URL.revokeObjectURL(trackBlobRef.current);
  }, [destroyClient]);

  // ── Start ──────────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (!imdbId) return;
    destroyClient();
    setPhase("checking"); setErrorMsg(""); setStreamLabel("");

    try {
      // A. Tracker health check
      const alive = await healthyTrackers(setStatus);
      setStatus(`${alive.length} مسار نشط ✓ — جاري تجاوز القيود والبحث عن أفضل جودة (1080p)...`);

      // B. Fetch & filter stream (1080p > 720p, reject 4K)
      setPhase("fetching");
      const stream = await fetchStream(imdbId);
      setStreamLabel(stream.label);

      // C. Load WebTorrent from local npm copy (JS-injected script, not static HTML tag)
      const WebTorrent = await loadWebTorrentLib();

      // D. Proxy WebSeeds through CORS proxy
      const proxiedSeeds = stream.webSeeds.map(proxyWebSeed);

      // Build Magnet with filtered trackers + proxied WebSeeds
      const magnet = buildMagnet(stream.infoHash, stream.name, alive, proxiedSeeds);

      setPhase("connecting");
      setStatus(
        proxiedSeeds.length > 0
          ? `WebSeeds متوفرة (${proxiedSeeds.length}) — البث عبر HTTP مباشرة…`
          : "جارٍ الاتصال بأول Peer متاح…"
      );

      // E. Initialize WebTorrent client
      const client: any = new WebTorrent({
        webRTC      : true,
        maxWebConns : 100,
        tracker: {
          announce            : alive,
          rejectUnauthorized  : false,   // تجاوز شهادات SSL منتهية الصلاحية
          rtcConfig: {
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "stun:stun1.l.google.com:19302" },
              { urls: "stun:global.stun.twilio.com:3478" },
            ],
          },
        },
      });
      clientRef.current = client;

      client.on("error", (err: Error) => {
        setErrorMsg(err?.message ?? "خطأ في WebTorrent"); setPhase("error");
      });

      // F. Add torrent — on 'torrent' event start streaming immediately if webseeds exist
      client.add(magnet, { destroyStoreOnDestroy: true }, (torrent: any) => {
        const videoExts = /\.(mp4|mkv|webm|avi|mov|m4v)$/i;
        const vFiles: any[] = torrent.files.filter((f: any) => videoExts.test(f.name));
        if (!vFiles.length) {
          setErrorMsg("لم يُعثر على ملف فيديو داخل التورنت"); setPhase("error"); return;
        }
        const file = vFiles.reduce((a: any, b: any) => b.length > a.length ? b : a);

        setPhase("playing");

        // D. If webseeds present → start rendering immediately (no peer needed)
        if (videoRef.current) {
          file.renderTo(videoRef.current, { autoplay: true }, (err: Error | null) => {
            if (err) { setErrorMsg("تعذّر بدء البث: " + err.message); setPhase("error"); }
          });
        }

        // Live stats
        statsRef.current = setInterval(() => {
          setStats({
            numPeers     : torrent.numPeers      ?? 0,
            downloadSpeed: torrent.downloadSpeed  ?? 0,
            webSeedsCount: torrent.numWebSeeds    ?? proxiedSeeds.length,
          });
          setProgress(torrent.progress ?? 0);
        }, 800);

        torrent.once("done", () => { setProgress(1); });

        // noPeers warning after 30s
        let noPeerTimer: ReturnType<typeof setTimeout> | null = null;
        torrent.on("noPeers", () => {
          if ((torrent.numPeers ?? 0) === 0 && proxiedSeeds.length === 0) {
            noPeerTimer = setTimeout(() => {
              if ((torrent.numPeers ?? 0) === 0)
                setErrorMsg("لم يتم العثور على Peers — تأكد من تفعيل WebRTC في متصفحك أو جرّب مصدراً آخر.");
            }, 30_000);
          }
        });
        torrent.on("wire", () => { if (noPeerTimer) { clearTimeout(noPeerTimer); noPeerTimer = null; } });
      });

    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "خطأ غير معروف"); setPhase("error");
    }
  }, [imdbId, destroyClient]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const isActive  = phase === "playing";
  const isLoading = phase === "checking" || phase === "fetching" || phase === "connecting";

  return (
    <div className="relative w-full bg-black" style={{ aspectRatio: "16/9" }}>

      {/* ── Idle ── */}
      {phase === "idle" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90">
          <div className="rounded-full bg-white/10 p-5"><Film className="h-10 w-10 text-white/60" /></div>
          <p className="text-white/50 text-sm">مشغّل تورنت · فحص ذكي للـ Trackers · 1080p أولاً</p>
          <button onClick={start}
            className="flex items-center gap-2 rounded-full bg-red-600 px-7 py-3 text-white font-semibold hover:bg-red-500 transition-colors">
            <Play className="h-5 w-5 fill-current" /> تشغيل
          </button>
        </div>
      )}

      {/* ── Loading ── */}
      {isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90">
          <Loader2 className="h-10 w-10 animate-spin text-red-500" />
          <p className="text-white/80 text-sm text-center px-8 leading-relaxed">{status}</p>

          {/* Step indicators */}
          <div className="flex items-center gap-3 text-xs mt-1">
            <Step active={phase === "checking"}   done={phase !== "checking"}                    label="فحص المسارات" />
            <div className="w-5 h-px bg-white/15" />
            <Step active={phase === "fetching"}   done={phase === "connecting" || isActive}      label="جلب 1080p" />
            <div className="w-5 h-px bg-white/15" />
            <Step active={phase === "connecting"} done={isActive}                                label="الاتصال بـ Peers" />
          </div>

          {streamLabel && <p className="text-white/35 text-xs">{streamLabel}</p>}
        </div>
      )}

      {/* ── Error ── */}
      {phase === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90 text-center px-6">
          <AlertCircle className="h-10 w-10 text-red-500" />
          <p className="text-white/80 text-sm leading-relaxed">{errorMsg}</p>
          <button onClick={start}
            className="flex items-center gap-2 rounded-full border border-white/20 px-5 py-2 text-white/70 text-sm hover:bg-white/10 transition-colors">
            إعادة المحاولة
          </button>
        </div>
      )}

      {/* ── Video ── */}
      <video ref={videoRef} className={`w-full h-full ${isActive ? "block" : "hidden"}`}
        controls autoPlay crossOrigin="anonymous">
        {trackUrl && <track kind="subtitles" src={trackUrl} srcLang="ar" label="العربية" default />}
      </video>

      {/* ── Live stats (playing) ── */}
      {isActive && (
        <div className="absolute top-3 left-3 flex items-center gap-3 rounded-xl bg-black/70 px-4 py-2 text-xs text-white/80 backdrop-blur-sm pointer-events-none border border-white/10">
          <span className="flex items-center gap-1.5 font-semibold">
            <Wifi className={`h-3.5 w-3.5 ${stats.numPeers > 0 ? "text-green-400" : "text-yellow-400"}`} />
            {stats.numPeers} Peers
          </span>
          {stats.webSeedsCount > 0 && (
            <span className="flex items-center gap-1 text-blue-300">
              <Zap className="h-3 w-3" />{stats.webSeedsCount} WebSeed
            </span>
          )}
          {stats.downloadSpeed > 0 && <span className="text-green-300 font-mono">{fmtSpeed(stats.downloadSpeed)}</span>}
          {progress > 0 && <span className="text-white/50">{(progress * 100).toFixed(1)}%</span>}
          <span className="text-white/30 text-[10px]">{streamLabel}</span>
        </div>
      )}

      {/* ── Subtitle controls ── */}
      <div className="absolute bottom-14 right-3 flex items-center gap-2 z-20">
        <input ref={fileInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSubFile} />
        {(isActive || isLoading) && (
          <button onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white/70 backdrop-blur-sm hover:bg-black/80 transition-colors">
            <Upload className="h-3.5 w-3.5" /> ترجمة
          </button>
        )}
        {trackUrl && isActive && (
          <button onClick={() => { setTrackUrl(null); if (trackBlobRef.current) { URL.revokeObjectURL(trackBlobRef.current); trackBlobRef.current = null; } }}
            className="rounded-full bg-black/60 px-3 py-1.5 text-xs text-white/50 backdrop-blur-sm hover:bg-black/80 transition-colors">
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
