import { translate, type Locale } from '@voivox/i18n';

export type CapturePresentationInput = {
  sourceKind: 'chrome-tab' | 'macos-process' | 'microphone';
  sourceLabel: string;
  activeSession?: {
    id: string;
    status: 'capturing' | 'complete' | 'interrupted';
  };
};

export type CapturePresentation = {
  actionLabel: string;
  canChangeSource: boolean;
  notice: string;
  statusLabel: string;
};

export function deriveCapturePresentation(
  input: CapturePresentationInput,
  locale: Locale
): CapturePresentation {
  if (input.activeSession?.status === 'capturing') {
    return {
      actionLabel: translate(locale, 'capture.stop'),
      canChangeSource: false,
      notice: translate(locale, 'desktop.capture.activeNotice', { source: input.sourceLabel }),
      statusLabel: translate(locale, 'status.capturing')
    };
  }

  if (input.sourceKind === 'chrome-tab') {
    return {
      actionLabel: translate(locale, 'desktop.capture.chromeAction'),
      canChangeSource: true,
      notice: translate(locale, 'desktop.capture.chromeNotice'),
      statusLabel: translate(locale, 'status.ready')
    };
  }

  return {
    actionLabel: translate(locale, 'desktop.capture.macAction'),
    canChangeSource: true,
    notice: translate(locale, 'desktop.capture.macNotice'),
    statusLabel: translate(locale, 'status.ready')
  };
}
