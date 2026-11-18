
import type { SubtitleTrackSource } from '../player/types';

export type IptvContentType = 'live' | 'movie' | 'series';

export interface IptvCategory {
  id: string;
  name: string;
  parentId: string | null;
  type: IptvContentType;
}

export interface IptvChannel {
  id: string;
  name: string;
  url: string;
  logo: string | null;
  group: string;
  type: IptvContentType;
  seriesId?: string;
  episodeId?: string;
  subtitleTracks?: SubtitleTrackSource[];
}

export interface IptvSeries {
  id: string;
  name: string;
  logo: string | null;
  categoryId: string | null;
  plot?: string;
  releaseDate?: string;
  rating?: string;
}

export interface IptvEpisode {
  id: string;
  seriesId: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  url: string;
  containerExtension: string | null;
}

export interface IptvSeason {
  seasonNumber: number;
  name: string;
  episodes: IptvEpisode[];
}
