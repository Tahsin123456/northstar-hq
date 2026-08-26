/**
 * Normalised YouTube shapes.
 *
 * The Data API returns deeply optional, string-typed JSON (`statistics.viewCount`
 * is a *string*, and is simply absent when a channel hides its counts). These
 * types are what the rest of the application is allowed to see: numbers are
 * numbers, absence is `null`, and nothing downstream ever touches a raw
 * response object.
 */

export interface YouTubeChannel {
  readonly channelId: string;
  readonly title: string;
  readonly description: string;
  /** `@handle` including the leading `@`, when YouTube exposes one. */
  readonly handle: string | null;
  readonly customUrl: string | null;
  readonly avatarUrl: string | null;
  readonly bannerUrl: string | null;
  readonly country: string | null;
  /** `null` when the channel hides its subscriber count. */
  readonly subscriberCount: number | null;
  readonly hiddenSubscriberCount: boolean;
  readonly viewCount: number | null;
  readonly videoCount: number | null;
  /** The `UU…` playlist holding every public upload, newest first. */
  readonly uploadsPlaylistId: string | null;
  readonly publishedAt: Date | null;
}

/** A row from the uploads playlist — cheap, but statistics-free. */
export interface UploadsPlaylistEntry {
  readonly videoId: string;
  readonly publishedAt: Date | null;
}

export interface YouTubeVideo {
  readonly videoId: string;
  readonly channelId: string;
  readonly title: string;
  readonly description: string;
  readonly publishedAt: Date;
  readonly durationIso: string;
  /** `null` when the duration is absent or unparseable (e.g. a live stream). */
  readonly durationSeconds: number | null;
  readonly thumbnailUrl: string | null;
  readonly viewCount: number;
  /** `null` when the uploader hides likes. */
  readonly likeCount: number | null;
  /** `null` when comments are disabled. */
  readonly commentCount: number | null;
  /** Player dimensions from `player.embedHtml`; used for aspect-ratio evidence. */
  readonly playerWidth: number | null;
  readonly playerHeight: number | null;
  readonly liveBroadcastContent: string | null;
}

/** How the resolver interpreted the user's input. */
export type ChannelInputKind = "channelId" | "handle" | "customUrl" | "videoUrl" | "url";

export interface ParsedChannelInput {
  readonly kind: ChannelInputKind;
  readonly value: string;
  readonly raw: string;
}

// --- Raw API response shapes (internal to the client) ----------------------

export interface RawThumbnail {
  url?: string;
  width?: number;
  height?: number;
}

export interface RawThumbnails {
  default?: RawThumbnail;
  medium?: RawThumbnail;
  high?: RawThumbnail;
  standard?: RawThumbnail;
  maxres?: RawThumbnail;
}

export interface RawChannelItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    customUrl?: string;
    publishedAt?: string;
    country?: string;
    thumbnails?: RawThumbnails;
  };
  statistics?: {
    viewCount?: string;
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
    videoCount?: string;
  };
  contentDetails?: {
    relatedPlaylists?: {
      uploads?: string;
    };
  };
  brandingSettings?: {
    image?: { bannerExternalUrl?: string };
  };
}

export interface RawPlaylistItem {
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
  };
  snippet?: {
    publishedAt?: string;
    resourceId?: { videoId?: string };
  };
}

export interface RawVideoItem {
  id?: string;
  snippet?: {
    channelId?: string;
    title?: string;
    description?: string;
    publishedAt?: string;
    thumbnails?: RawThumbnails;
    liveBroadcastContent?: string;
  };
  contentDetails?: {
    duration?: string;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
  player?: {
    embedHtml?: string;
    embedWidth?: number | string;
    embedHeight?: number | string;
  };
}

export interface RawListResponse<T> {
  items?: T[];
  nextPageToken?: string;
  pageInfo?: { totalResults?: number; resultsPerPage?: number };
}

export interface RawApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ domain?: string; reason?: string; message?: string }>;
  };
}
