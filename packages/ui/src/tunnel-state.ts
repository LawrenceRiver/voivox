import type { PvttStatus } from '@voivox/core';

export type TunnelLocale = 'zh-CN' | 'en';

const labels: Record<TunnelLocale, Record<PvttStatus, string>> = {
  'zh-CN': {
    idle: '检测视频',
    detecting: '正在检测',
    ready: '开始转录',
    connecting: '正在连接',
    transcribing: '正在转录',
    paused: '继续转录',
    returning: '正在返回',
    completed: '已完成',
    failed: '失败'
  },
  en: {
    idle: 'Detect video',
    detecting: 'Detecting',
    ready: 'Start transcription',
    connecting: 'Connecting',
    transcribing: 'Transcribing',
    paused: 'Resume transcription',
    returning: 'Returning',
    completed: 'Completed',
    failed: 'Failed'
  }
};

export function tunnelStatusLabel(locale: TunnelLocale, status: PvttStatus): string {
  return labels[locale][status];
}

export function tunnelPrimaryLabel(locale: TunnelLocale, status: PvttStatus): string {
  if (status === 'transcribing') return locale === 'zh-CN' ? '暂停转录' : 'Pause transcription';
  if (status === 'paused') return locale === 'zh-CN' ? '继续转录' : 'Resume transcription';
  if (status === 'ready') return locale === 'zh-CN' ? '开始转录' : 'Start transcription';
  return tunnelStatusLabel(locale, status);
}
