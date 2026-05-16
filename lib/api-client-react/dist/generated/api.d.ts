import type { QueryKey, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import type { ApiError, DownloadLinks, GetDownloadLinksParams, HealthStatus, MediaDetails, ProxyVideoParams, SearchMediaParams, SearchResults } from "./api.schemas";
import { customFetch } from "../custom-fetch";
import type { ErrorType } from "../custom-fetch";
type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];
/**
 * Returns server health status
 * @summary Health check
 */
export declare const getHealthCheckUrl: () => string;
export declare const healthCheck: (options?: RequestInit) => Promise<HealthStatus>;
export declare const getHealthCheckQueryKey: () => readonly ["/api/healthz"];
export declare const getHealthCheckQueryOptions: <TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData> & {
    queryKey: QueryKey;
};
export type HealthCheckQueryResult = NonNullable<Awaited<ReturnType<typeof healthCheck>>>;
export type HealthCheckQueryError = ErrorType<unknown>;
/**
 * @summary Health check
 */
export declare function useHealthCheck<TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Search OMDB/IMDB for movies, TV shows, and episodes
 * @summary Search movies and TV shows
 */
export declare const getSearchMediaUrl: (params: SearchMediaParams) => string;
export declare const searchMedia: (params: SearchMediaParams, options?: RequestInit) => Promise<SearchResults>;
export declare const getSearchMediaQueryKey: (params?: SearchMediaParams) => readonly ["/api/search", ...SearchMediaParams[]];
export declare const getSearchMediaQueryOptions: <TData = Awaited<ReturnType<typeof searchMedia>>, TError = ErrorType<ApiError>>(params: SearchMediaParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof searchMedia>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof searchMedia>>, TError, TData> & {
    queryKey: QueryKey;
};
export type SearchMediaQueryResult = NonNullable<Awaited<ReturnType<typeof searchMedia>>>;
export type SearchMediaQueryError = ErrorType<ApiError>;
/**
 * @summary Search movies and TV shows
 */
export declare function useSearchMedia<TData = Awaited<ReturnType<typeof searchMedia>>, TError = ErrorType<ApiError>>(params: SearchMediaParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof searchMedia>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Get detailed info for a specific IMDB ID
 */
export declare const getGetMediaDetailsUrl: (imdbId: string) => string;
export declare const getMediaDetails: (imdbId: string, options?: RequestInit) => Promise<MediaDetails>;
export declare const getGetMediaDetailsQueryKey: (imdbId: string) => readonly [`/api/media/${string}`];
export declare const getGetMediaDetailsQueryOptions: <TData = Awaited<ReturnType<typeof getMediaDetails>>, TError = ErrorType<ApiError>>(imdbId: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMediaDetails>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getMediaDetails>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetMediaDetailsQueryResult = NonNullable<Awaited<ReturnType<typeof getMediaDetails>>>;
export type GetMediaDetailsQueryError = ErrorType<ApiError>;
/**
 * @summary Get detailed info for a specific IMDB ID
 */
export declare function useGetMediaDetails<TData = Awaited<ReturnType<typeof getMediaDetails>>, TError = ErrorType<ApiError>>(imdbId: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMediaDetails>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Get trending/popular movies
 */
export declare const getGetTrendingMoviesUrl: () => string;
export declare const getTrendingMovies: (options?: RequestInit) => Promise<SearchResults>;
export declare const getGetTrendingMoviesQueryKey: () => readonly ["/api/trending/movies"];
export declare const getGetTrendingMoviesQueryOptions: <TData = Awaited<ReturnType<typeof getTrendingMovies>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrendingMovies>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTrendingMovies>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTrendingMoviesQueryResult = NonNullable<Awaited<ReturnType<typeof getTrendingMovies>>>;
export type GetTrendingMoviesQueryError = ErrorType<unknown>;
/**
 * @summary Get trending/popular movies
 */
export declare function useGetTrendingMovies<TData = Awaited<ReturnType<typeof getTrendingMovies>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrendingMovies>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Get trending/popular TV series
 */
export declare const getGetTrendingSeriesUrl: () => string;
export declare const getTrendingSeries: (options?: RequestInit) => Promise<SearchResults>;
export declare const getGetTrendingSeriesQueryKey: () => readonly ["/api/trending/series"];
export declare const getGetTrendingSeriesQueryOptions: <TData = Awaited<ReturnType<typeof getTrendingSeries>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrendingSeries>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTrendingSeries>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTrendingSeriesQueryResult = NonNullable<Awaited<ReturnType<typeof getTrendingSeries>>>;
export type GetTrendingSeriesQueryError = ErrorType<unknown>;
/**
 * @summary Get trending/popular TV series
 */
export declare function useGetTrendingSeries<TData = Awaited<ReturnType<typeof getTrendingSeries>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrendingSeries>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Get download links for a movie or TV episode
 */
export declare const getGetDownloadLinksUrl: (imdbId: string, params?: GetDownloadLinksParams) => string;
export declare const getDownloadLinks: (imdbId: string, params?: GetDownloadLinksParams, options?: RequestInit) => Promise<DownloadLinks>;
export declare const getGetDownloadLinksQueryKey: (imdbId: string, params?: GetDownloadLinksParams) => readonly [`/api/downloads/${string}`, ...GetDownloadLinksParams[]];
export declare const getGetDownloadLinksQueryOptions: <TData = Awaited<ReturnType<typeof getDownloadLinks>>, TError = ErrorType<unknown>>(imdbId: string, params?: GetDownloadLinksParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDownloadLinks>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getDownloadLinks>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetDownloadLinksQueryResult = NonNullable<Awaited<ReturnType<typeof getDownloadLinks>>>;
export type GetDownloadLinksQueryError = ErrorType<unknown>;
/**
 * @summary Get download links for a movie or TV episode
 */
export declare function useGetDownloadLinks<TData = Awaited<ReturnType<typeof getDownloadLinks>>, TError = ErrorType<unknown>>(imdbId: string, params?: GetDownloadLinksParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDownloadLinks>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Proxy video embed URL to strip restrictive headers
 */
export declare const getProxyVideoUrl: (params: ProxyVideoParams) => string;
export declare const proxyVideo: (params: ProxyVideoParams, options?: RequestInit) => Promise<string>;
export declare const getProxyVideoQueryKey: (params?: ProxyVideoParams) => readonly ["/api/proxy", ...ProxyVideoParams[]];
export declare const getProxyVideoQueryOptions: <TData = Awaited<ReturnType<typeof proxyVideo>>, TError = ErrorType<ApiError>>(params: ProxyVideoParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof proxyVideo>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof proxyVideo>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ProxyVideoQueryResult = NonNullable<Awaited<ReturnType<typeof proxyVideo>>>;
export type ProxyVideoQueryError = ErrorType<ApiError>;
/**
 * @summary Proxy video embed URL to strip restrictive headers
 */
export declare function useProxyVideo<TData = Awaited<ReturnType<typeof proxyVideo>>, TError = ErrorType<ApiError>>(params: ProxyVideoParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof proxyVideo>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export {};
//# sourceMappingURL=api.d.ts.map