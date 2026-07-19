export type AccessibleMediaKind = 'file' | 'hls' | 'dash';

export type MediaSourceDecision = {
  accessible: boolean;
  kind?: AccessibleMediaKind;
  reason:
    | 'accessible_media_file'
    | 'accessible_hls_manifest'
    | 'accessible_dash_manifest'
    | 'encrypted_media'
    | 'unsupported_protocol'
    | 'unknown_media_source';
};

/**
 * Classifies a media URL without downloading it. A positive result only means
 * that the source is a legal, ordinary HTTP(S) byte source; the caller still
 * has to perform a same-origin/CORS and DRM check before fetching.
 */
export function detectAccessibleMediaSource(input: {
  url?: string;
  contentType?: string;
  encrypted?: boolean;
}): MediaSourceDecision {
  if (input.encrypted) {
    return { accessible: false, reason: 'encrypted_media' };
  }
  if (!input.url) {
    return { accessible: false, reason: 'unknown_media_source' };
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { accessible: false, reason: 'unsupported_protocol' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { accessible: false, reason: 'unsupported_protocol' };
  }

  const contentType = input.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === 'application/vnd.apple.mpegurl' || contentType === 'application/x-mpegurl') {
    return { accessible: true, kind: 'hls', reason: 'accessible_hls_manifest' };
  }
  if (contentType === 'application/dash+xml') {
    return { accessible: true, kind: 'dash', reason: 'accessible_dash_manifest' };
  }
  if (contentType?.startsWith('audio/') || contentType?.startsWith('video/')) {
    return { accessible: true, kind: 'file', reason: 'accessible_media_file' };
  }

  const pathname = url.pathname.toLowerCase();
  if (/\.(m3u8)$/u.test(pathname)) {
    return { accessible: true, kind: 'hls', reason: 'accessible_hls_manifest' };
  }
  if (/\.(mpd)$/u.test(pathname)) {
    return { accessible: true, kind: 'dash', reason: 'accessible_dash_manifest' };
  }
  if (/\.(mp4|m4a|webm|mp3|wav|ogg|oga|aac|flac)$/u.test(pathname)) {
    return { accessible: true, kind: 'file', reason: 'accessible_media_file' };
  }
  return { accessible: false, reason: 'unknown_media_source' };
}
