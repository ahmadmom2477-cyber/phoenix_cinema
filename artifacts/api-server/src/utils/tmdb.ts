const TMDB_KEY = "f502dd453a408a6349f1d3620e2e1a66";
const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p/w500";

export type TmdbMediaResult = {
  id: number;
  media_type?: "movie" | "tv";
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  number_of_seasons?: number;
  original_language?: string;
};

async function tmdbGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${path}`);
  return res.json();
}

export function tmdbPoster(path?: string | null): string | null {
  if (!path) return null;
  return `${IMG_BASE}${path}`;
}

export async function findByImdbId(imdbId: string): Promise<TmdbMediaResult | null> {
  try {
    const data = await tmdbGet(`/find/${imdbId}`, { external_source: "imdb_id" }) as {
      movie_results: TmdbMediaResult[];
      tv_results: TmdbMediaResult[];
    };
    const movie = data.movie_results?.[0];
    const tv = data.tv_results?.[0];
    if (movie) return { ...movie, media_type: "movie" };
    if (tv) return { ...tv, media_type: "tv" };
    return null;
  } catch {
    return null;
  }
}

export async function getMovieImdbId(tmdbId: number): Promise<string | null> {
  try {
    const data = await tmdbGet(`/movie/${tmdbId}/external_ids`) as { imdb_id?: string | null };
    return data.imdb_id ?? null;
  } catch {
    return null;
  }
}

export async function getTvImdbId(tmdbId: number): Promise<string | null> {
  try {
    const data = await tmdbGet(`/tv/${tmdbId}/external_ids`) as { imdb_id?: string | null };
    return data.imdb_id ?? null;
  } catch {
    return null;
  }
}

export async function getTrendingMovies(): Promise<TmdbMediaResult[]> {
  try {
    const data = await tmdbGet("/trending/movie/week") as { results: TmdbMediaResult[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

export async function getTrendingTv(): Promise<TmdbMediaResult[]> {
  try {
    const data = await tmdbGet("/trending/tv/week") as { results: TmdbMediaResult[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

export async function discoverMovies(genreId: number, page = 1): Promise<TmdbMediaResult[]> {
  try {
    const data = await tmdbGet("/discover/movie", {
      with_genres: String(genreId),
      sort_by: "popularity.desc",
      page: String(page),
      "vote_count.gte": "50",
    }) as { results: TmdbMediaResult[] };
    return (data.results ?? []).map((r) => ({ ...r, media_type: "movie" as const }));
  } catch {
    return [];
  }
}

export async function discoverTv(genreId: number, page = 1): Promise<TmdbMediaResult[]> {
  try {
    const data = await tmdbGet("/discover/tv", {
      with_genres: String(genreId),
      sort_by: "popularity.desc",
      page: String(page),
      "vote_count.gte": "50",
    }) as { results: TmdbMediaResult[] };
    return (data.results ?? []).map((r) => ({ ...r, media_type: "tv" as const }));
  } catch {
    return [];
  }
}

export async function searchMulti(query: string): Promise<TmdbMediaResult[]> {
  try {
    const data = await tmdbGet("/search/multi", { query, include_adult: "false" }) as {
      results: TmdbMediaResult[];
    };
    return (data.results ?? []).filter((r) => r.media_type === "movie" || r.media_type === "tv");
  } catch {
    return [];
  }
}

export function mapTmdbToMedia(result: TmdbMediaResult, imdbId: string) {
  const isMovie = result.media_type !== "tv";
  const year = (result.release_date || result.first_air_date || "").substring(0, 4);
  return {
    imdbId,
    title: result.title || result.name || "",
    year: year || null,
    type: isMovie ? "movie" : "series",
    poster: tmdbPoster(result.poster_path ?? null),
    plot: result.overview || null,
    imdbRating: result.vote_average ? String(result.vote_average.toFixed(1)) : null,
    genre: null as string | null,
    rated: null as string | null,
    director: null as string | null,
    actors: null as string | null,
    runtime: null as string | null,
    totalSeasons: result.number_of_seasons ? String(result.number_of_seasons) : null,
    language: result.original_language || null,
    country: null as string | null,
    awards: null as string | null,
  };
}

export const OUR_GENRE_TMDB: Record<string, { movie: number; tv: number }> = {
  action:      { movie: 28,    tv: 10759 },
  horror:      { movie: 27,    tv: 9648  },
  drama:       { movie: 18,    tv: 18    },
  comedy:      { movie: 35,    tv: 35    },
  thriller:    { movie: 53,    tv: 9648  },
  animation:   { movie: 16,    tv: 16    },
  romance:     { movie: 10749, tv: 10749 },
  scifi:       { movie: 878,   tv: 10765 },
  crime:       { movie: 80,    tv: 80    },
  adventure:   { movie: 12,    tv: 10759 },
  fantasy:     { movie: 14,    tv: 10765 },
  documentary: { movie: 99,    tv: 99    },
  history:     { movie: 36,    tv: 36    },
  family:      { movie: 10751, tv: 10751 },
  mystery:     { movie: 9648,  tv: 9648  },
  war:         { movie: 10752, tv: 10768 },
};
