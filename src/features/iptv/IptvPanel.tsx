
import { useEffect, useMemo, useState } from 'react';
import {
  type IptvChannel,
  type IptvContentType,
} from './m3u';
import { iptvApiUrl } from './api';
import type { SubtitleTrackSource } from '../player/types';

interface IptvPanelProps {
  onSelectChannel: (channel: IptvChannel) => void;
  onChannelsLoaded: (channels: IptvChannel[]) => void;
}

interface CatalogResponse {
  success?: boolean;
  total: number;
  counts: Record<IptvContentType, number>;
}

interface CatalogItemsResponse {
  items: IptvChannel[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  groups: string[];
}

interface ApiError {
  error?: string;
}

interface XtreamTestResponse {
  success: boolean;
  authenticated: boolean;
  status: string;
  expirationDate: string | null;
  isTrial: boolean;
  activeConnections: number;
  maxConnections: number;
}

interface XtreamCategory {
  category_id: string;
  category_name: string;
  parent_id: string | null;
}

interface XtreamCategoriesResponse {
  type: IptvContentType;
  categories: XtreamCategory[];
  total: number;
}

interface XtreamItem {
  id: string;
  name: string;
  url: string;
  logo: string | null;
  group: string;
  categoryId: string | null;
  type: IptvContentType;
  cover?: string | null;
  plot?: string | null;
  year?: string | number | null;
  rating?: string | number | null;
}

interface XtreamItemsResponse {
  type: IptvContentType;
  items: XtreamItem[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

interface XtreamSearchResponse {
  type: IptvContentType;
  items: XtreamItem[];
  total: number;
}

interface XtreamEpisode {
  id: string;
  name: string;
  episodeNumber: number;
  url: string;
  extension: string;
  subtitles?: SubtitleTrackSource[];
  info: {
    plot?: string;
    duration?: string;
    movie_image?: string;
    [key: string]: unknown;
  };
}

interface XtreamSeason {
  id: string;
  name: string;
  seasonNumber: number;
  episodeCount: number;
}

interface XtreamEpisodesBySeason {
  seasonId: string;
  episodes: XtreamEpisode[];
}

interface XtreamSeriesResponse {
  seriesId: string;
  info: Record<string, unknown>;
  seasons: XtreamSeason[];
  episodesBySeason: XtreamEpisodesBySeason[];
}

interface XtreamVodResponse {
  url: string;
  extension: string;
  subtitles: SubtitleTrackSource[];
}

type CatalogMode = 'm3u' | 'xtream';

const PAGE_SIZE = 50;

const STORAGE_KEYS = {
  open: 'ourcinema-iptv-open',
  type: 'ourcinema-iptv-type',
  group: 'ourcinema-iptv-group',
};

const contentTabs: {
  id: IptvContentType;
  label: string;
}[] = [
    { id: 'live', label: 'Canlı TV' },
    { id: 'movie', label: 'Filmler' },
    { id: 'series', label: 'Diziler' },
  ];

function getStoredValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function getInitialOpenState(): boolean {
  return getStoredValue(STORAGE_KEYS.open) !== 'false';
}

function getInitialType(): IptvContentType {
  const value = getStoredValue(STORAGE_KEYS.type);

  if (value === 'movie' || value === 'series') {
    return value;
  }

  return 'live';
}

function getInitialGroup(): string {
  return getStoredValue(STORAGE_KEYS.group) || 'Tümü';
}

async function readResponse<T>(response: Response): Promise<T> {
  const text = await response.text();

  let data: T & ApiError;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Backend geçerli JSON döndürmedi. HTTP ${response.status}.`,
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error || `İstek başarısız. HTTP ${response.status}`,
    );
  }

  return data;
}

function formatExpirationDate(value: string | null): string {
  if (!value) return 'Belirtilmemiş';

  const timestamp = Number(value);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return value;
  }

  return new Date(timestamp * 1000).toLocaleDateString('tr-TR');
}

function getCategoryDepth(
  category: XtreamCategory,
  categories: XtreamCategory[],
): number {
  let depth = 0;
  let parentId = category.parent_id;
  const visited = new Set<string>();

  while (parentId && depth < 10) {
    if (visited.has(parentId)) break;

    visited.add(parentId);

    const parent = categories.find(
      (item) => item.category_id === parentId,
    );

    if (!parent) break;

    depth += 1;
    parentId = parent.parent_id;
  }

  return depth;
}

function flattenCategories(
  categories: XtreamCategory[],
): XtreamCategory[] {
  const sorted = [...categories].sort((a, b) =>
    a.category_name.localeCompare(b.category_name, 'tr'),
  );

  const result: XtreamCategory[] = [];
  const visited = new Set<string>();

  function addChildren(parentId: string | null, depth: number) {
    if (depth > 10) return;

    const children = sorted.filter(
      (category) => (category.parent_id || null) === parentId,
    );

    for (const category of children) {
      if (visited.has(category.category_id)) continue;

      visited.add(category.category_id);
      result.push(category);

      addChildren(category.category_id, depth + 1);
    }
  }

  addChildren(null, 0);

  for (const category of sorted) {
    if (!visited.has(category.category_id)) {
      result.push(category);
    }
  }

  return result;
}

export function IptvPanel({
  onSelectChannel,
  onChannelsLoaded,
}: IptvPanelProps) {
  const [isOpen, setIsOpen] = useState(getInitialOpenState);

  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [channels, setChannels] = useState<IptvChannel[]>([]);
  const [loadedChannels, setLoadedChannels] = useState<IptvChannel[]>([]);
  const [seriesItems, setSeriesItems] = useState<XtreamItem[]>([]);

  const [counts, setCounts] = useState<
    Record<IptvContentType, number>
  >({
    live: 0,
    movie: 0,
    series: 0,
  });

  const [groups, setGroups] = useState<string[]>([]);
  const [categories, setCategories] = useState<XtreamCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');

  const [selectedType, setSelectedType] =
    useState<IptvContentType>(getInitialType);

  const [selectedGroup, setSelectedGroup] =
    useState(getInitialGroup);

  const [catalogMode, setCatalogMode] = useState<CatalogMode>('m3u');

  const [search, setSearch] = useState('');
  const [searchChannels, setSearchChannels] = useState<IptvChannel[]>([]);
  const [searchSeries, setSearchSeries] = useState<XtreamItem[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [showConnection, setShowConnection] = useState(true);

  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const [loading, setLoading] = useState(false);
  const [testingXtream, setTestingXtream] = useState(false);

  const [error, setError] = useState('');
  const [xtreamError, setXtreamError] = useState('');

  const [xtreamResult, setXtreamResult] =
    useState<XtreamTestResponse | null>(null);

  const [catalogReady, setCatalogReady] = useState(false);

  const [selectedSeries, setSelectedSeries] =
    useState<XtreamItem | null>(null);

  const [seriesDetails, setSeriesDetails] =
    useState<XtreamSeriesResponse | null>(null);

  const [selectedSeasonId, setSelectedSeasonId] = useState('');

  // Panel ve içerik seçimlerini koru.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.open, String(isOpen));
      localStorage.setItem(STORAGE_KEYS.type, selectedType);
      localStorage.setItem(STORAGE_KEYS.group, selectedGroup);
    } catch {
      // Depolama kullanılamıyorsa panel çalışmaya devam eder.
    }
  }, [isOpen, selectedType, selectedGroup]);

  // --------------------------------------------------
  // M3U içeriklerini getir
  // --------------------------------------------------

  async function fetchM3uItems(
    type: IptvContentType,
    group: string,
    nextPage: number,
    append: boolean,
    resetLoaded = false,
  ): Promise<CatalogItemsResponse> {
    const params = new URLSearchParams({
      type,
      page: String(nextPage),
      limit: String(PAGE_SIZE),
    });

    if (group !== 'Tümü') {
      params.set('group', group);
    }

    const response = await fetch(
      iptvApiUrl(`/api/iptv/catalog/items?${params.toString()}`),
    );

    const data = await readResponse<CatalogItemsResponse>(response);

    setChannels((previous) =>
      append ? [...previous, ...data.items] : data.items,
    );

    setGroups(data.groups);
    setTotal(data.total);
    setPage(data.page);
    setHasMore(data.hasMore);

    const previousChannels = resetLoaded ? [] : loadedChannels;

    const merged = new Map(
      previousChannels.map((channel) => [channel.id, channel]),
    );

    for (const channel of data.items) {
      merged.set(channel.id, channel);
    }

    const updatedChannels = Array.from(merged.values());

    setLoadedChannels(updatedChannels);
    onChannelsLoaded(updatedChannels);

    return data;
  }

  // --------------------------------------------------
  // Xtream kategorileri
  // --------------------------------------------------

  async function fetchXtreamCategories(
    type: IptvContentType,
  ): Promise<XtreamCategory[]> {
    const response = await fetch(
      iptvApiUrl(`/api/iptv/xtream/categories?type=${type}`),
    );

    const data = await readResponse<XtreamCategoriesResponse>(
      response,
    );

    return flattenCategories(data.categories);
  }

  // --------------------------------------------------
  // Xtream içerikleri - sayfalı
  // --------------------------------------------------

  async function fetchXtreamItems(
    type: IptvContentType,
    categoryId: string,
    nextPage: number,
  ): Promise<XtreamItemsResponse> {
    const params = new URLSearchParams({
      type,
      page: String(nextPage),
      limit: String(PAGE_SIZE),
    });

    if (categoryId) {
      params.set('categoryId', categoryId);
    }

    const response = await fetch(
      iptvApiUrl(`/api/iptv/xtream/items?${params.toString()}`),
    );

    return readResponse<XtreamItemsResponse>(response);
  }

  function mapXtreamChannels(items: XtreamItem[]): IptvChannel[] {
    return items
      .filter((item) => item.type !== 'series' && Boolean(item.url))
      .map((item) => ({
        id: item.id,
        name: item.name,
        url: item.url,
        logo: item.logo,
        group: item.group,
        type: item.type,
      })) as IptvChannel[];
  }

  // --------------------------------------------------
  // Xtream içerik türünü yükle
  // --------------------------------------------------

  async function loadXtreamType(type: IptvContentType) {
    const nextCategories = await fetchXtreamCategories(type);

    setCategories(nextCategories);
    setSelectedCategoryId('');
    setChannels([]);
    setLoadedChannels([]);
    setSeriesItems([]);
    setPage(1);
    setTotal(0);
    setHasMore(false);
    setSelectedGroup('Tümü');

    onChannelsLoaded([]);

    // Canlı yayınlarda tüm liste kullanılabilir.
    // Film ve dizilerde kategori seçilmeden içerik istenmez.
    if (type === 'live') {
      const data = await fetchXtreamItems('live', '', 1);
      const mappedChannels = mapXtreamChannels(data.items);

      setChannels(mappedChannels);
      setLoadedChannels(mappedChannels);
      onChannelsLoaded(mappedChannels);

      setTotal(data.total);
      setCounts((previous) => ({
        ...previous,
        live: data.total,
      }));
      setPage(data.page);
      setHasMore(data.hasMore);
    }
  }

  // --------------------------------------------------
  // M3U kataloğunu geri yükle
  // --------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function restoreCatalog() {
      try {
        const xtreamSessionResponse = await fetch(
          iptvApiUrl('/api/iptv/xtream/session'),
        );

        if (xtreamSessionResponse.ok) {
          const xtreamSession = await readResponse<{
            ready?: boolean;
            error?: string | null;
          }>(xtreamSessionResponse);

          if (xtreamSession.ready) {
            setCatalogReady(true);
            setCatalogMode('xtream');
            setShowConnection(false);
            setSelectedType('live');
            setSelectedGroup('Tümü');
            setLoading(true);
            await loadXtreamType('live');

            if (cancelled) return;

            return;
          }

          if (xtreamSession.error) {
            setXtreamError(xtreamSession.error);
          }
        }

        const response = await fetch(iptvApiUrl('/api/iptv/catalog'));

        if (!response.ok) return;

        const data = await readResponse<CatalogResponse>(response);

        if (cancelled) return;

        setCounts(data.counts);
        setCatalogReady(true);
        setCatalogMode('m3u');
        setShowConnection(false);
        setLoading(true);

        const storedType = getInitialType();
        const storedGroup = getInitialGroup();

        let items = await fetchM3uItems(
          storedType,
          storedGroup,
          1,
          false,
          true,
        );

        if (cancelled) return;

        if (
          storedGroup !== 'Tümü' &&
          !items.groups.includes(storedGroup)
        ) {
          setSelectedGroup('Tümü');

          items = await fetchM3uItems(
            storedType,
            'Tümü',
            1,
            false,
            true,
          );
        }

        if (cancelled) return;

        setSelectedType(storedType);
        setSelectedGroup(
          storedGroup !== 'Tümü' &&
            items.groups.includes(storedGroup)
            ? storedGroup
            : 'Tümü',
        );
      } catch {
        // Katalog yoksa kullanıcı manuel bağlantı kurabilir.
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void restoreCatalog();

    return () => {
      cancelled = true;
    };
  }, []);

  // --------------------------------------------------
  // Xtream bağlantı testi
  // --------------------------------------------------

  async function testXtream() {
    const server = serverUrl.trim();
    const user = username.trim();
    const pass = password;

    if (!server || !user || !pass) {
      setXtreamError(
        'Sunucu adresi, kullanıcı adı ve şifre gerekli.',
      );
      setXtreamResult(null);
      return;
    }

    setTestingXtream(true);
    setXtreamError('');
    setXtreamResult(null);

    try {
      const response = await fetch(iptvApiUrl('/api/iptv/test-xtream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          serverUrl: server,
          username: user,
          password: pass,
        }),
      });

      const data = await readResponse<XtreamTestResponse>(response);

      setXtreamResult(data);
    } catch (err) {
      setXtreamError(
        err instanceof Error
          ? err.message
          : 'Xtream API bağlantısı test edilemedi.',
      );
    } finally {
      setTestingXtream(false);
    }
  }

  // --------------------------------------------------
  // Xtream kataloğunu yükle
  // --------------------------------------------------

  async function loadXtreamCatalog() {
    if (!xtreamResult) {
      setError('Önce Xtream API bağlantısını test etmelisin.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      setCatalogMode('xtream');
      setCatalogReady(true);
      setShowConnection(false);

      setSelectedType('live');
      setSelectedGroup('Tümü');
      setSelectedSeries(null);
      setSeriesDetails(null);
      setSelectedSeasonId('');
      setSearch('');

      await loadXtreamType('live');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Xtream kataloğu yüklenemedi.',
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // M3U kataloğunu yükle
  // --------------------------------------------------

  async function loadPlaylist() {
    const server = serverUrl.trim();
    const user = username.trim();
    const pass = password;

    if (!server || !user || !pass) {
      setError('Sunucu adresi, kullanıcı adı ve şifre gerekli.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(iptvApiUrl('/api/iptv/catalog'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          serverUrl: server,
          username: user,
          password: pass,
        }),
      });

      const data = await readResponse<CatalogResponse>(response);

      setCatalogMode('m3u');
      setCounts(data.counts);
      setChannels([]);
      setLoadedChannels([]);
      setSeriesItems([]);
      setGroups([]);
      setCategories([]);
      setSelectedCategoryId('');
      setTotal(0);
      setHasMore(false);
      setCatalogReady(true);
      setShowConnection(false);
      setSearch('');

      setSelectedSeries(null);
      setSeriesDetails(null);
      setSelectedSeasonId('');

      onChannelsLoaded([]);

      setSelectedType('live');
      setSelectedGroup('Tümü');

      await fetchM3uItems('live', 'Tümü', 1, false, true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'IPTV listesi yüklenemedi.',
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // İçerik türü değiştir
  // --------------------------------------------------

  async function changeType(type: IptvContentType) {
    if (loading) return;

    setSelectedType(type);
    setSelectedGroup('Tümü');
    setSelectedCategoryId('');
    setChannels([]);
    setSeriesItems([]);
    setSearch('');
    setError('');

    setSelectedSeries(null);
    setSeriesDetails(null);
    setSelectedSeasonId('');

    setLoading(true);

    try {
      if (catalogMode === 'xtream') {
        await loadXtreamType(type);
      } else {
        await fetchM3uItems(type, 'Tümü', 1, false, true);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'İçerikler yüklenemedi.',
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // M3U grup değiştir
  // --------------------------------------------------

  async function changeGroup(group: string) {
    if (loading) return;

    setSelectedGroup(group);
    setChannels([]);
    setSearch('');
    setError('');
    setLoading(true);

    try {
      if (catalogMode === 'm3u') {
        await fetchM3uItems(
          selectedType,
          group,
          1,
          false,
          true,
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Kategori yüklenemedi.',
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // Xtream kategorisi değiştir
  // --------------------------------------------------

  async function changeXtreamCategory(categoryId: string) {
    if (loading) return;

    // Film ve dizilerde kategori seçimi zorunlu.
    if (!categoryId && selectedType !== 'live') {
      setSelectedCategoryId('');
      setChannels([]);
      setSeriesItems([]);
      setTotal(0);
      setHasMore(false);
      setPage(1);
      onChannelsLoaded([]);
      return;
    }

    setSelectedCategoryId(categoryId);
    setChannels([]);
    setSeriesItems([]);
    setSearch('');
    setError('');
    setPage(1);
    setLoading(true);

    try {
      const data = await fetchXtreamItems(
        selectedType,
        categoryId,
        1,
      );

      if (selectedType === 'series') {
        setSeriesItems(data.items);
        setChannels([]);
        setLoadedChannels([]);
        onChannelsLoaded([]);
      } else {
        const mappedChannels = mapXtreamChannels(data.items);

        setChannels(mappedChannels);
        setLoadedChannels(mappedChannels);
        onChannelsLoaded(mappedChannels);
      }

      setTotal(data.total);
      setPage(data.page);
      setHasMore(data.hasMore);

      setCounts((previous) => ({
        ...previous,
        [selectedType]: data.total,
      }));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Kategori içerikleri yüklenemedi.',
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // Daha fazla içerik yükle - M3U ve Xtream
  // --------------------------------------------------

  async function loadMore() {
    if (loading || !hasMore) return;

    setLoading(true);
    setError('');

    try {
      const nextPage = page + 1;

      if (catalogMode === 'm3u') {
        await fetchM3uItems(
          selectedType,
          selectedGroup,
          nextPage,
          true,
        );
      } else {
        const data = await fetchXtreamItems(
          selectedType,
          selectedCategoryId,
          nextPage,
        );

        if (selectedType === 'series') {
          setSeriesItems((previous) => [
            ...previous,
            ...data.items,
          ]);
        } else {
          const newChannels = mapXtreamChannels(data.items);

          setChannels((previous) => [
            ...previous,
            ...newChannels,
          ]);

          const merged = new Map(
            loadedChannels.map((channel) => [
              `${channel.id}-${channel.url}`,
              channel,
            ]),
          );

          for (const channel of newChannels) {
            merged.set(`${channel.id}-${channel.url}`, channel);
          }

          const updatedChannels = Array.from(merged.values());

          setLoadedChannels(updatedChannels);
          onChannelsLoaded(updatedChannels);
        }

        setPage(data.page);
        setTotal(data.total);
        setHasMore(data.hasMore);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Daha fazla içerik yüklenemedi.',
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // Dizi detaylarını ve sezonları getir
  // --------------------------------------------------

  async function openSeries(series: XtreamItem) {
    if (loading) return;

    setLoading(true);
    setError('');
    setSelectedSeries(series);
    setSeriesDetails(null);
    setSelectedSeasonId('');

    try {
      const response = await fetch(
        iptvApiUrl(
          `/api/iptv/xtream/series/${encodeURIComponent(series.id)}`,
        ),
      );

      const data = await readResponse<XtreamSeriesResponse>(response);

      setSeriesDetails(data);

      const firstSeasonId =
        data.episodesBySeason[0]?.seasonId ||
        data.seasons[0]?.id ||
        '';

      setSelectedSeasonId(firstSeasonId);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Dizi detayları alınamadı.',
      );
    } finally {
      setLoading(false);
    }
  }

  function closeSeries() {
    setSelectedSeries(null);
    setSeriesDetails(null);
    setSelectedSeasonId('');
    setError('');
  }

  // --------------------------------------------------
  // Bölüm oynat
  // --------------------------------------------------

  function playEpisode(episode: XtreamEpisode) {
    const extensionFromUrl = (() => {
      try {
        const pathname = new URL(episode.url).pathname;
        return pathname.split('.').pop()?.toLowerCase() || 'bulunamadı';
      } catch {
        return 'URL okunamadı';
      }
    })();

    console.log('[IPTV Episode Debug]', {
      episodeName: episode.name,
      extension: episode.extension,
      extensionFromUrl,
    });
    const channel = {
      id: episode.id,
      name: `${selectedSeries?.name || 'Dizi'} - ${episode.name}`,
      url: episode.url,
      logo: episode.info.movie_image || selectedSeries?.cover || null,
      group: selectedSeries?.group || 'Diziler',
      type: 'series',
      seriesId: selectedSeries?.id,
      episodeId: episode.id,
      subtitleTracks: episode.subtitles,
    } as IptvChannel;

    onSelectChannel(channel);
  }

  async function selectChannel(channel: IptvChannel) {
    if (catalogMode !== 'xtream' || channel.type !== 'movie') {
      onSelectChannel(channel);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(
        iptvApiUrl(`/api/iptv/xtream/vod/${encodeURIComponent(channel.id)}`),
      );
      const details = await readResponse<XtreamVodResponse>(response);
      onSelectChannel({
        ...channel,
        url: details.url,
        subtitleTracks: details.subtitles,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Film bilgileri alınamadı.',
      );
    } finally {
      setLoading(false);
    }
  }

  // --------------------------------------------------
  // Filtrelenmiş veriler
  // --------------------------------------------------

  const flattenedCategories = useMemo(
    () => flattenCategories(categories),
    [categories],
  );

  const filteredChannels = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('tr-TR');

    if (!query) return channels;

    return channels.filter((channel) =>
      channel.name.toLocaleLowerCase('tr-TR').includes(query),
    );
  }, [channels, search]);

  const filteredSeries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('tr-TR');

    if (!query) return seriesItems;

    return seriesItems.filter((series) =>
      series.name.toLocaleLowerCase('tr-TR').includes(query),
    );
  }, [seriesItems, search]);

  useEffect(() => {
    const query = search.trim();
    let cancelled = false;

    if (query.length < 2) {
      setSearchChannels([]);
      setSearchSeries([]);
      setSearchTotal(0);
      setSearchError('');
      setSearchLoading(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      setSearchLoading(true);
      setSearchError('');

      try {
        const params = new URLSearchParams({
          type: selectedType,
          page: '1',
          limit: '100',
          q: query,
        });
        const endpoint = catalogMode === 'xtream'
          ? `/api/iptv/xtream/search?${params.toString()}`
          : `/api/iptv/catalog/items?${params.toString()}`;
        const response = await fetch(iptvApiUrl(endpoint));

        if (catalogMode === 'xtream') {
          const data = await readResponse<XtreamSearchResponse>(response);
          if (cancelled) return;
          setSearchTotal(data.total);
          if (selectedType === 'series') {
            setSearchSeries(data.items);
            setSearchChannels([]);
          } else {
            setSearchChannels(mapXtreamChannels(data.items));
            setSearchSeries([]);
          }
        } else {
          const data = await readResponse<CatalogItemsResponse>(response);
          if (cancelled) return;
          setSearchChannels(data.items);
          setSearchSeries([]);
          setSearchTotal(data.total);
        }
      } catch (err) {
        if (!cancelled) {
          setSearchError(err instanceof Error ? err.message : 'Arama yapılamadı.');
          setSearchChannels([]);
          setSearchSeries([]);
          setSearchTotal(0);
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, selectedType, catalogMode]);

  const isGlobalSearch = search.trim().length >= 2;
  const visibleChannels = isGlobalSearch ? searchChannels : filteredChannels;
  const visibleSeries = isGlobalSearch ? searchSeries : filteredSeries;

  const selectedSeasonEpisodes = useMemo(() => {
    if (!seriesDetails) return [];

    return (
      seriesDetails.episodesBySeason.find(
        (season) => season.seasonId === selectedSeasonId,
      )?.episodes || []
    );
  }, [seriesDetails, selectedSeasonId]);

  // --------------------------------------------------
  // Arayüz
  // --------------------------------------------------

  return (
    <>
      {!isOpen && (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="fixed right-0 top-1/2 z-40 -translate-y-1/2 rounded-l-2xl border border-r-0 border-accent/40 bg-gradient-to-br from-accent to-[#9f1720] px-4 py-5 font-semibold text-white shadow-[0_12px_40px_rgba(224,49,59,0.28)] transition hover:pr-5"
          aria-label="IPTV panelini aç"
        >
          <span className="flex items-center gap-2">
            <span>▣</span>
            <span>IPTV</span>
          </span>
        </button>
      )}

      {isOpen && (
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
          aria-label="IPTV panelini kapat"
        />
      )}

      <aside
        aria-label="IPTV Kütüphanesi"
        aria-hidden={!isOpen}
        className={`fixed right-0 top-0 z-50 flex h-[100dvh] w-full max-w-[460px] flex-col border-l border-white/10 bg-[#09090d] text-white shadow-[-24px_0_80px_rgba(0,0,0,0.55)] transition-transform duration-300 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
      >
        {/* Başlık */}
        <div className="relative flex shrink-0 items-center justify-between overflow-hidden border-b border-white/[0.08] bg-gradient-to-br from-[#191116] via-[#100e12] to-[#0b0b10] px-5 py-5">
          <div className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-accent/10 blur-3xl" />
          <div className="relative flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/25 bg-accent/10 text-xl text-accent shadow-inner shadow-accent/10">
              ▶
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold tracking-wide">IPTV Kütüphanesi</h2>
                {catalogReady && <span className="h-1.5 w-1.5 rounded-full bg-online shadow-[0_0_10px_rgba(61,220,132,0.8)]" />}
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Canlı yayınlar <span className="px-1 text-slate-600">·</span> Filmler <span className="px-1 text-slate-600">·</span> Diziler
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-xl text-slate-300 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            aria-label="Paneli kapat"
          >
            ×
          </button>
        </div>

        {/* Bağlantı alanı */}
        <div className="shrink-0 border-b border-white/[0.08] bg-white/[0.015] p-4">
          {catalogReady && (
            <button
              type="button"
              onClick={() => setShowConnection((value) => !value)}
              className="mb-3 flex w-full items-center justify-between text-sm font-medium text-slate-300 transition hover:text-white"
            >
              <span>Bağlantı ayarları</span>
              <span>{showConnection ? '−' : '+'}</span>
            </button>
          )}

          {(!catalogReady || showConnection) && (
            <div className="flex flex-col gap-2">
              <input
                type="url"
                value={serverUrl}
                onChange={(event) => {
                  setServerUrl(event.target.value);
                  setXtreamResult(null);
                  setXtreamError('');
                }}
                placeholder="Sunucu adresi (http://sunucu:port)"
                autoComplete="url"
                className="w-full rounded-xl border border-white/[0.08] bg-[#111116] px-3.5 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
              />

              <input
                type="text"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setXtreamResult(null);
                  setXtreamError('');
                }}
                placeholder="Kullanıcı adı"
                autoComplete="username"
                className="w-full rounded-xl border border-white/[0.08] bg-[#111116] px-3.5 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
              />

              <input
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setXtreamResult(null);
                  setXtreamError('');
                }}
                placeholder="Şifre"
                autoComplete="current-password"
                className="w-full rounded-xl border border-white/[0.08] bg-[#111116] px-3.5 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
              />

              <button
                type="button"
                onClick={testXtream}
                disabled={testingXtream || loading}
                className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testingXtream
                  ? 'Xtream API test ediliyor...'
                  : 'Xtream API Test Et'}
              </button>

              {xtreamResult && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                  <p className="font-semibold text-emerald-400">
                    ✓ Xtream API bağlantısı başarılı
                  </p>

                  <div className="mt-2 space-y-1 text-xs text-slate-300">
                    <p>Durum: {xtreamResult.status}</p>
                    <p>
                      Bitiş tarihi:{' '}
                      {formatExpirationDate(
                        xtreamResult.expirationDate,
                      )}
                    </p>
                    <p>
                      Deneme hesabı:{' '}
                      {xtreamResult.isTrial ? 'Evet' : 'Hayır'}
                    </p>
                    <p>
                      Aktif bağlantı: {xtreamResult.activeConnections}
                    </p>
                    <p>
                      Maksimum bağlantı: {xtreamResult.maxConnections}
                    </p>
                  </div>
                </div>
              )}

              {xtreamError && (
                <p className="break-words rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
                  {xtreamError}
                </p>
              )}

              <button
                type="button"
                onClick={loadXtreamCatalog}
                disabled={!xtreamResult || loading || testingXtream}
                className="rounded-xl bg-gradient-to-r from-accent to-[#c8212c] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-accent/15 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Xtream Kataloğunu Yükle
              </button>

              <div className="my-1 border-t border-white/10" />

              <button
                type="button"
                onClick={loadPlaylist}
                disabled={loading || testingXtream}
                className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
              >
                M3U Listesini Yükle
              </button>
            </div>
          )}

          {error && (
            <p className="mt-3 break-words rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
              {error}
            </p>
          )}
        </div>

        {catalogReady && (
          <>
            {/* İçerik sekmeleri */}
            <div className="grid shrink-0 grid-cols-3 gap-2 border-b border-white/[0.08] p-4">
              {contentTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  disabled={loading}
                  onClick={() => changeType(tab.id)}
                  className={`rounded-lg px-2 py-3 text-sm font-semibold transition disabled:opacity-50 ${selectedType === tab.id
                      ? 'bg-gradient-to-br from-accent to-[#a9151e] text-white shadow-lg shadow-accent/15'
                      : 'border border-white/[0.06] bg-white/[0.035] text-slate-400 hover:bg-white/[0.07] hover:text-white'
                    }`}
                >
                  <span className="block">{tab.label}</span>
                  <span className="mt-1 block text-xs opacity-75">
                    {counts[tab.id].toLocaleString('tr-TR')}
                  </span>
                </button>
              ))}
            </div>

            {/* Dizi detay görünümü */}
            {catalogMode === 'xtream' && selectedSeries ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <button
                  type="button"
                  onClick={closeSeries}
                  className="mb-4 text-sm font-semibold text-blue-400 hover:text-blue-300"
                >
                  ← Dizi listesine dön
                </button>

                <div className="mb-5 flex gap-3">
                  {selectedSeries.cover && (
                    <img
                      src={selectedSeries.cover}
                      alt=""
                      className="h-28 w-20 shrink-0 rounded-lg bg-slate-800 object-cover"
                    />
                  )}

                  <div className="min-w-0">
                    <h3 className="font-bold text-white">
                      {selectedSeries.name}
                    </h3>

                    {selectedSeries.year && (
                      <p className="mt-1 text-xs text-slate-400">
                        {selectedSeries.year}
                      </p>
                    )}

                    {selectedSeries.rating && (
                      <p className="mt-1 text-xs text-amber-400">
                        ★ {selectedSeries.rating}
                      </p>
                    )}

                    {selectedSeries.plot && (
                      <p className="mt-2 line-clamp-4 text-xs leading-5 text-slate-400">
                        {selectedSeries.plot}
                      </p>
                    )}
                  </div>
                </div>

                {seriesDetails && (
                  <>
                    <h4 className="mb-3 text-sm font-semibold text-slate-200">
                      Sezonlar
                    </h4>

                    <div className="mb-5 flex flex-wrap gap-2">
                      {seriesDetails.episodesBySeason.map((season) => {
                        const seasonInfo = seriesDetails.seasons.find(
                          (item) => item.id === season.seasonId,
                        );

                        return (
                          <button
                            key={season.seasonId}
                            type="button"
                            onClick={() =>
                              setSelectedSeasonId(season.seasonId)
                            }
                            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${selectedSeasonId === season.seasonId
                                ? 'bg-accent text-white'
                                : 'border border-white/[0.06] bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]'
                              }`}
                          >
                            {seasonInfo?.name ||
                              `Sezon ${season.seasonId}`}
                          </button>
                        );
                      })}
                    </div>

                    <h4 className="mb-3 text-sm font-semibold text-slate-200">
                      Bölümler ({selectedSeasonEpisodes.length})
                    </h4>

                    <div className="flex flex-col gap-2">
                      {selectedSeasonEpisodes.map((episode) => (
                        <button
                          key={episode.id}
                          type="button"
                          onClick={() => playEpisode(episode)}
                          className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-left transition hover:border-accent/35 hover:bg-white/[0.06]"
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/15 bg-accent/10 text-xs font-bold text-accent">
                            {episode.episodeNumber || '▶'}
                          </span>

                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-slate-200">
                              {episode.name}
                            </span>

                            {episode.info.duration && (
                              <span className="mt-1 block text-xs text-slate-500">
                                {episode.info.duration}
                              </span>
                            )}
                          </span>

                          <span className="text-xs text-slate-500">
                            ▶
                          </span>
                        </button>
                      ))}
                    </div>

                    {selectedSeasonEpisodes.length === 0 && (
                      <p className="rounded-xl bg-slate-900 p-5 text-center text-sm text-slate-400">
                        Bu sezonda bölüm bulunamadı.
                      </p>
                    )}
                  </>
                )}

                {!seriesDetails && loading && (
                  <p className="py-8 text-center text-sm text-slate-400">
                    Dizi detayları yükleniyor...
                  </p>
                )}
              </div>
            ) : (
              <>
                {/* Arama */}
                <div className="shrink-0 px-4 pt-4">
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Tüm IPTV kategorilerinde ara..."
                    className="w-full rounded-xl border border-white/[0.08] bg-[#111116] px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
                  />
                </div>

                {/* Kategoriler */}
                <div className="shrink-0 border-b border-white/10 px-4 py-3">
                  {catalogMode === 'xtream' ? (
                    <div className="flex flex-col gap-1">
                      {selectedType === 'live' && (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => changeXtreamCategory('')}
                          className={`w-full rounded-lg px-3 py-2 text-left text-xs font-medium transition ${!selectedCategoryId
                              ? 'bg-accent text-white'
                              : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-white'
                            }`}
                        >
                          Tüm kategoriler
                        </button>
                      )}

                      <div className="max-h-36 overflow-y-auto">
                        {flattenedCategories.map((category) => {
                          const depth = getCategoryDepth(
                            category,
                            categories,
                          );

                          return (
                            <button
                              key={category.category_id}
                              type="button"
                              disabled={loading}
                              onClick={() =>
                                changeXtreamCategory(
                                  category.category_id,
                                )
                              }
                              style={{
                                paddingLeft: `${12 + depth * 16}px`,
                              }}
                              className={`mb-1 block w-full rounded-lg py-2 pr-3 text-left text-xs transition disabled:opacity-50 ${selectedCategoryId ===
                                  category.category_id
                                  ? 'bg-accent/15 text-white'
                                  : 'text-slate-400 hover:bg-white/[0.05] hover:text-white'
                                }`}
                            >
                              {category.category_name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {['Tümü', ...groups]
                        .filter(
                          (group, index, array) =>
                            array.indexOf(group) === index,
                        )
                        .map((group) => (
                          <button
                            key={group}
                            type="button"
                            disabled={loading}
                            onClick={() => changeGroup(group)}
                            className={`shrink-0 rounded-full px-3 py-2 text-xs font-medium transition disabled:opacity-50 ${selectedGroup === group
                                ? 'bg-accent text-white'
                                : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-white'
                              }`}
                          >
                            {group}
                          </button>
                        ))}
                    </div>
                  )}
                </div>

                {/* İçerik sayısı */}
                <div className="flex shrink-0 items-center justify-between px-4 py-3">
                  <span className="text-xs text-slate-400">
                    {search.trim().length > 0
                      ? isGlobalSearch
                        ? searchLoading
                          ? 'Tüm kategoriler aranıyor...'
                          : `${(selectedType === 'series' ? searchSeries.length : searchChannels.length).toLocaleString('tr-TR')} sonuç gösteriliyor`
                        : 'Tüm kategorilerde aramak için en az 2 karakter yazın.'
                      : `${(catalogMode === 'xtream' && selectedType === 'series' ? filteredSeries.length : filteredChannels.length).toLocaleString('tr-TR')} içerik gösteriliyor`}
                  </span>

                  <span className="text-xs text-slate-500">
                    {isGlobalSearch
                      ? searchTotal > 100
                        ? `${searchTotal.toLocaleString('tr-TR')} eşleşme · ilk 100`
                        : `Toplam ${searchTotal.toLocaleString('tr-TR')} eşleşme`
                      : search.trim().length === 0
                        ? `Toplam ${total.toLocaleString('tr-TR')}`
                        : ''}
                  </span>
                </div>

                {/* İçerik listesi */}
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                  {isGlobalSearch && searchLoading ? (
                    <p className="py-8 text-center text-sm text-slate-400">
                      Tüm IPTV kategorileri aranıyor...
                    </p>
                  ) : isGlobalSearch && searchError ? (
                    <p role="alert" className="rounded-xl bg-red-950/40 p-5 text-center text-sm text-red-200">
                      {searchError}
                    </p>
                  ) : catalogMode === 'xtream' &&
                    selectedType === 'series' ? (
                    selectedCategoryId || isGlobalSearch ? (
                      <div className="flex flex-col gap-2">
                        {visibleSeries.map((series) => (
                          <button
                            key={series.id}
                            type="button"
                            onClick={() => openSeries(series)}
                            className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-left transition hover:border-accent/35 hover:bg-white/[0.06]"
                          >
                            {series.cover ? (
                              <img
                                src={series.cover}
                                alt=""
                                loading="lazy"
                                className="h-16 w-12 shrink-0 rounded-lg bg-slate-800 object-cover"
                              />
                            ) : (
                              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-blue-400">
                                ▶
                              </div>
                            )}

                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-slate-200">
                                {series.name}
                              </span>

                              {series.year && (
                                <span className="mt-1 block text-xs text-slate-500">
                                  {series.year}
                                </span>
                              )}
                              {isGlobalSearch && series.group && (
                                <span className="mt-1 block truncate text-[11px] text-slate-500">
                                  {series.group}
                                </span>
                              )}
                            </span>

                            <span className="text-xs text-slate-500">
                              →
                            </span>
                          </button>
                        ))}
                        {visibleSeries.length === 0 && !searchLoading && (
                          <p className="rounded-xl bg-slate-900 p-6 text-center text-sm text-slate-400">
                            {search ? 'Aramanızla eşleşen dizi bulunamadı.' : 'Bu kategoride dizi bulunamadı.'}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="rounded-xl bg-slate-900 p-6 text-center text-sm text-slate-400">
                        Dizileri görüntülemek için yukarıdan bir kategori seç.
                      </p>
                    )
                  ) : catalogMode === 'xtream' &&
                    selectedType === 'movie' &&
                    !selectedCategoryId && !isGlobalSearch ? (
                    <p className="rounded-xl bg-slate-900 p-6 text-center text-sm text-slate-400">
                      Filmleri görüntülemek için yukarıdan bir kategori seç.
                    </p>
                  ) : visibleChannels.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {visibleChannels.map((channel) => (
                        <button
                          key={`${channel.id}-${channel.url}`}
                          type="button"
                          onClick={() => void selectChannel(channel)}
                            className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-left transition hover:border-accent/35 hover:bg-white/[0.06]"
                        >
                          {channel.logo ? (
                            <img
                              src={channel.logo}
                              alt=""
                              loading="lazy"
                              className="h-10 w-10 shrink-0 rounded-lg bg-slate-800 object-contain"
                            />
                          ) : (
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-xs font-bold text-blue-400">
                              {selectedType === 'live' ? 'TV' : '▶'}
                            </div>
                          )}

                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">
                            {channel.name}
                            {isGlobalSearch && channel.group && (
                              <span className="ml-2 text-[11px] font-normal text-slate-500">
                                · {channel.group}
                              </span>
                            )}
                          </span>

                          <span className="text-xs text-slate-500">
                            ▶
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    !loading && !searchLoading && (
                      <p className="rounded-xl bg-slate-900 p-6 text-center text-sm text-slate-400">
                        {searchError || (search
                          ? 'Aramanızla eşleşen içerik bulunamadı.'
                          : 'Bu kategoride içerik bulunamadı.')}
                      </p>
                    )
                  )}

                  {hasMore && !search && (
                    <button
                      type="button"
                      onClick={loadMore}
                      disabled={loading}
                      className="mt-3 w-full rounded-lg bg-slate-800 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
                    >
                      {loading ? 'Yükleniyor...' : 'Daha fazla yükle'}
                    </button>
                  )}

                  {loading && (
                    <p className="py-4 text-center text-xs text-slate-400">
                      İçerikler yükleniyor...
                    </p>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {!catalogReady && !loading && (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <div>
              <div className="mb-3 text-4xl">▣</div>
              <p className="font-medium text-slate-300">
                IPTV bağlantısı bekleniyor
              </p>
              <p className="mt-2 text-sm text-slate-500">
                Kütüphaneyi yüklemek için sunucu bilgilerini gir.
              </p>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
