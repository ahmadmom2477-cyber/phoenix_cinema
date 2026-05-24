import { Router } from "express";
import { SearchMediaQueryParams, GetMediaDetailsParams } from "@workspace/api-zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  findByImdbId,
  mapTmdbToMedia,
  getTrendingMovies,
  getTrendingTv,
  getMovieImdbId,
  getTvImdbId,
} from "../utils/tmdb.js";

const router = Router();

const __dirLocal = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirLocal, "..", "data");
const CACHE_FILE = join(DATA_DIR, "omdb-cache.json");

interface CacheEntry { data: unknown; expiresAt: number; }
let memCache: Map<string, CacheEntry> = new Map();

function loadCache() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    if (!existsSync(CACHE_FILE)) return;
    const obj = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as Record<string, CacheEntry>;
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (v.expiresAt > now) memCache.set(k, v);
    }
  } catch {}
}

function saveCache() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const obj: Record<string, CacheEntry> = {};
    memCache.forEach((v, k) => { obj[k] = v; });
    writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch {}
}

export function getCached(key: string): unknown | null {
  const entry = memCache.get(key);
  if (!entry || entry.expiresAt < Date.now()) { memCache.delete(key); return null; }
  return entry.data;
}

export function setCache(key: string, data: unknown, ttlMs: number) {
  memCache.set(key, { data, expiresAt: Date.now() + ttlMs });
  setImmediate(() => saveCache());
}

loadCache();

// ── OMDB key management ────────────────────────────────────────────────────
const OMDB_BASE = "https://www.omdbapi.com";
const OMDB_KEYS = ["6866d5b4", "d19d0e5c", "fccd07eb", "e7f94365", "cae875d0", "eafc380f"];
let keyIndex = 0;
const KEY_HEALTH_FILE = join(DATA_DIR, "omdb-key-health.json");
const keyLimitedAt = new Map<string, number>();
const RESET_AFTER = 8 * 60 * 60 * 1000;

function loadKeyHealth() {
  try {
    if (!existsSync(KEY_HEALTH_FILE)) return;
    const obj = JSON.parse(readFileSync(KEY_HEALTH_FILE, "utf-8")) as Record<string, number>;
    const now = Date.now();
    for (const [key, ts] of Object.entries(obj)) {
      if (now - ts < RESET_AFTER) keyLimitedAt.set(key, ts);
    }
  } catch {}
}

function saveKeyHealth() {
  try {
    const obj: Record<string, number> = {};
    keyLimitedAt.forEach((ts, key) => { obj[key] = ts; });
    writeFileSync(KEY_HEALTH_FILE, JSON.stringify(obj));
  } catch {}
}

loadKeyHealth();

function getAvailableKey(): string | null {
  const now = Date.now();
  for (let i = 0; i < OMDB_KEYS.length; i++) {
    const key = OMDB_KEYS[keyIndex % OMDB_KEYS.length];
    keyIndex++;
    const limitedAt = keyLimitedAt.get(key);
    if (!limitedAt || now - limitedAt > RESET_AFTER) return key;
  }
  return null;
}

function markKeyLimited(key: string) {
  keyLimitedAt.set(key, Date.now());
  setImmediate(() => saveKeyHealth());
}

export const TTL_SEARCH = 60 * 60 * 1000;
export const TTL_MEDIA  = 7 * 24 * 60 * 60 * 1000;
export const TTL_TREND  = 2 * 60 * 60 * 1000;

function mapOmdbSearchItem(item: Record<string, string>) {
  return {
    imdbId: item["imdbID"] ?? "",
    title: item["Title"] ?? "",
    year: item["Year"] ?? "",
    type: item["Type"] ?? "movie",
    poster: item["Poster"] !== "N/A" ? item["Poster"] : null,
    rated: null, plot: null, genre: null, imdbRating: null, totalSeasons: null,
  };
}

function mapOmdbDetail(d: Record<string, string>) {
  return {
    imdbId: d["imdbID"] ?? "",
    title: d["Title"] ?? "",
    year: d["Year"] ?? "",
    type: d["Type"] ?? "movie",
    poster: d["Poster"] !== "N/A" ? d["Poster"] : null,
    rated: d["Rated"] !== "N/A" ? d["Rated"] : null,
    plot: d["Plot"] !== "N/A" ? d["Plot"] : null,
    genre: d["Genre"] !== "N/A" ? d["Genre"] : null,
    director: d["Director"] !== "N/A" ? d["Director"] : null,
    actors: d["Actors"] !== "N/A" ? d["Actors"] : null,
    imdbRating: d["imdbRating"] !== "N/A" ? d["imdbRating"] : null,
    runtime: d["Runtime"] !== "N/A" ? d["Runtime"] : null,
    totalSeasons: d["totalSeasons"] !== "N/A" ? d["totalSeasons"] : null,
    language: d["Language"] !== "N/A" ? d["Language"] : null,
    country: d["Country"] !== "N/A" ? d["Country"] : null,
    awards: d["Awards"] !== "N/A" ? d["Awards"] : null,
  };
}

async function fetchOmdbById(imdbId: string) {
  const key = getAvailableKey();
  if (!key) return null;
  try {
    const params = new URLSearchParams({ apikey: key, i: imdbId, plot: "full" });
    const response = await fetch(`${OMDB_BASE}/?${params.toString()}`);
    const data = await response.json() as Record<string, string>;
    if (data["Response"] === "False") {
      if ((data["Error"] ?? "").toLowerCase().includes("limit")) markKeyLimited(key);
      return null;
    }
    return mapOmdbDetail(data);
  } catch {
    return null;
  }
}

export async function fetchMediaById(imdbId: string) {
  const cacheKey = `media:${imdbId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached as ReturnType<typeof mapOmdbDetail>;

  // Try TMDB first for richer poster/plot
  const [tmdbResult, omdbResult] = await Promise.all([
    findByImdbId(imdbId),
    fetchOmdbById(imdbId),
  ]);

  if (!omdbResult && !tmdbResult) return null;

  let merged: ReturnType<typeof mapOmdbDetail>;

  if (omdbResult) {
    merged = { ...omdbResult };
    // Upgrade poster and plot from TMDB if better
    if (tmdbResult) {
      const tmdbMapped = mapTmdbToMedia(tmdbResult, imdbId);
      if (tmdbMapped.poster && (!merged.poster || merged.poster.includes("N/A"))) {
        merged.poster = tmdbMapped.poster;
      }
      if (tmdbMapped.plot && (!merged.plot || merged.plot.length < (tmdbMapped.plot?.length ?? 0))) {
        merged.plot = tmdbMapped.plot;
      }
      if (tmdbMapped.imdbRating && parseFloat(tmdbMapped.imdbRating) > 0) {
        merged.imdbRating = tmdbMapped.imdbRating;
      }
      if (tmdbMapped.totalSeasons && !merged.totalSeasons) {
        merged.totalSeasons = tmdbMapped.totalSeasons;
      }
    }
  } else {
    // OMDB failed, use TMDB only
    merged = mapTmdbToMedia(tmdbResult!, imdbId) as ReturnType<typeof mapOmdbDetail>;
  }

  setCache(cacheKey, merged, TTL_MEDIA);
  return merged;
}

// ── Search (OMDB — returns IMDB IDs directly, no TMDB needed) ──────────────
router.get("/search", async (req, res) => {
  const parseResult = SearchMediaQueryParams.safeParse(req.query);
  if (!parseResult.success) {
    res.status(400).json({ error: "invalid_params", message: "Missing required query parameter: q" });
    return;
  }

  const { q, type, year } = parseResult.data;
  const cacheKey = `search:${q}:${type ?? ""}:${year ?? ""}`;
  const cached = getCached(cacheKey);
  if (cached) { res.json(cached); return; }

  const key = getAvailableKey();
  if (!key) {
    res.status(503).json({ error: "rate_limited", message: "API limit reached, please try again later" });
    return;
  }

  const params = new URLSearchParams({ apikey: key, s: q });
  if (type) params.append("type", type);
  if (year) params.append("y", year);

  try {
    const response = await fetch(`${OMDB_BASE}/?${params.toString()}`);
    const data = await response.json() as Record<string, unknown>;

    if (data["Response"] === "False") {
      const err = data["Error"] as string ?? "";
      if (err.toLowerCase().includes("limit")) {
        markKeyLimited(key);
        res.status(503).json({ error: "rate_limited", message: "API limit reached, please try again later" });
        return;
      }
      const empty = { results: [], total: 0 };
      setCache(cacheKey, empty, TTL_SEARCH);
      res.json(empty);
      return;
    }

    const searchArr = (data["Search"] as Record<string, string>[]) ?? [];
    const total = parseInt((data["totalResults"] as string) ?? "0", 10);
    const result = { results: searchArr.map(mapOmdbSearchItem), total };
    setCache(cacheKey, result, TTL_SEARCH);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Search error");
    res.status(500).json({ error: "search_failed", message: "Failed to fetch search results" });
  }
});

// ── Media detail (TMDB primary + OMDB fallback) ───────────────────────────
router.get("/media/:imdbId", async (req, res) => {
  const parseResult = GetMediaDetailsParams.safeParse(req.params);
  if (!parseResult.success) {
    res.status(400).json({ error: "invalid_params", message: "Invalid IMDB ID" });
    return;
  }

  const { imdbId } = parseResult.data;

  try {
    const result = await fetchMediaById(imdbId);
    if (!result) {
      res.status(404).json({ error: "not_found", message: `No media found for IMDB ID: ${imdbId}` });
      return;
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Media detail error");
    res.status(500).json({ error: "fetch_failed", message: "Failed to fetch media details" });
  }
});

// ── Trending — TMDB powered ────────────────────────────────────────────────
async function fetchTrendingWithImdbIds(
  getFn: () => Promise<import("../utils/tmdb.js").TmdbMediaResult[]>,
  cacheKey: string
) {
  const cached = getCached(cacheKey);
  if (cached) return cached as { results: unknown[]; total: number };

  const tmdbResults = await getFn();
  const isMovie = cacheKey.includes("movie");

  // Resolve IMDB IDs in parallel (batched, limit to first 12)
  const top = tmdbResults.slice(0, 12);
  const imdbIdResults = await Promise.allSettled(
    top.map((r) =>
      isMovie ? getMovieImdbId(r.id) : getTvImdbId(r.id)
    )
  );

  const items: unknown[] = [];
  for (let i = 0; i < top.length; i++) {
    const tmdb = top[i];
    const idResult = imdbIdResults[i];
    const imdbId = idResult.status === "fulfilled" ? idResult.value : null;
    if (!imdbId) continue;

    const mapped = mapTmdbToMedia({ ...tmdb, media_type: isMovie ? "movie" : "tv" }, imdbId);
    // Cache individual media detail
    const mk = `media:${imdbId}`;
    if (!getCached(mk)) setCache(mk, mapped, TTL_MEDIA);
    items.push(mapped);
  }

  const out = { results: items, total: items.length };
  if (items.length > 0) setCache(cacheKey, out, TTL_TREND);
  return out;
}

router.get("/trending/movies", async (req, res) => {
  try {
    const out = await fetchTrendingWithImdbIds(getTrendingMovies, "trending:movies");
    res.json(out);
  } catch (err) {
    req.log.error({ err }, "trending movies error");
    res.status(500).json({ error: "fetch_failed", message: "Failed to fetch trending movies" });
  }
});

router.get("/trending/series", async (req, res) => {
  try {
    const out = await fetchTrendingWithImdbIds(getTrendingTv, "trending:series");
    res.json(out);
  } catch (err) {
    req.log.error({ err }, "trending series error");
    res.status(500).json({ error: "fetch_failed", message: "Failed to fetch trending series" });
  }
});

export default router;
