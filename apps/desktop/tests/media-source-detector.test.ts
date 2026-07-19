import { describe, expect, it } from 'vitest';

import { detectAccessibleMediaSource } from '../src/main/media-source-detector.js';

describe('detectAccessibleMediaSource', () => {
  it('selects ordinary media files for accelerated decode', () => {
    expect(detectAccessibleMediaSource({
      url: 'https://cdn.example.test/video.mp4',
      contentType: 'video/mp4'
    })).toEqual({ accessible: true, kind: 'file', reason: 'accessible_media_file' });
  });

  it('recognises manifests but never treats encrypted media as accessible', () => {
    expect(detectAccessibleMediaSource({ url: 'https://cdn.example.test/playlist.m3u8' })).toMatchObject({
      accessible: true,
      kind: 'hls'
    });
    expect(detectAccessibleMediaSource({
      url: 'https://cdn.example.test/video.mp4',
      encrypted: true
    })).toEqual({ accessible: false, reason: 'encrypted_media' });
  });

  it('falls back when the browser only exposes a blob or opaque URL', () => {
    expect(detectAccessibleMediaSource({ url: 'blob:https://example.test/123' })).toEqual({
      accessible: false,
      reason: 'unsupported_protocol'
    });
    expect(detectAccessibleMediaSource({ url: 'https://example.test/watch/123' })).toEqual({
      accessible: false,
      reason: 'unknown_media_source'
    });
  });
});
