import {
  resolveLocale,
  translate,
  type Locale,
  type MessageKey
} from '@voivox/i18n';

import {
  getCaptureState,
  normalizeCaptureState,
  type CaptureState
} from './bridge.js';
import type { TranscriptionMode } from './local-transcription.js';
import { captureActionKey, isProcessingPhase } from './popup-presentation.js';

const captureButton = requireElement<HTMLButtonElement>('capture');
const actionLabel = requireElement<HTMLElement>('.popup-action-label');
const copyButton = requireElement<HTMLButtonElement>('copy');
const headline = requireElement<HTMLElement>('capture-heading');
const languageButton = requireElement<HTMLButtonElement>('language');
const limit = requireElement<HTMLElement>('limit');
const message = requireElement<HTMLElement>('message');
const modeFast = requireElement<HTMLButtonElement>('mode-fast');
const modeHint = requireElement<HTMLElement>('mode-hint');
const modeLabel = requireElement<HTMLElement>('mode-label');
const modeQuality = requireElement<HTMLButtonElement>('mode-quality');
const privacy = requireElement<HTMLElement>('privacy');
const progressBar = requireElement<HTMLElement>('progress-bar');
const progressTrack = requireElement<HTMLElement>('progress-track');
const retryButton = requireElement<HTMLButtonElement>('retry');
const routeHint = requireElement<HTMLElement>('route-hint');
const routeLabel = requireElement<HTMLElement>('route-label');
const stateLabel = requireElement<HTMLElement>('state');
const transcript = requireElement<HTMLElement>('transcript');
const transcriptEmpty = requireElement<HTMLElement>('transcript-empty');
const transcriptHeading = requireElement<HTMLElement>('transcript-heading');

const localeStorageKey = 'voivoxLocale';
let captureState: CaptureState = normalizeCaptureState(undefined);
let locale: Locale = resolveLocale(chrome.i18n.getUILanguage(), null);
let copied = false;
let operationInFlight = false;

void initialize();

async function initialize(): Promise<void> {
  const [storedLocale, initialCaptureState] = await Promise.all([
    chrome.storage.local.get(localeStorageKey),
    getCaptureState()
  ]);
  locale = resolveLocale(
    chrome.i18n.getUILanguage(),
    typeof storedLocale[localeStorageKey] === 'string'
      ? storedLocale[localeStorageKey] as string
      : null
  );
  captureState = initialCaptureState;
  render();
  try {
    const armed = await chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'tab:arm'
    }) as { captureState?: unknown; session?: unknown };
    captureState = normalizeCaptureState(armed.captureState);
    render();
    if (armed.session) window.close();
  } catch {
    captureState = {
      ...captureState,
      error: locale === 'zh-CN'
        ? '无法武装当前页面。请重新打开 Voice VAC。'
        : 'Could not arm this page. Reopen Voice VAC.',
      phase: 'error'
    };
    render();
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.voivoxCaptureState) {
    return;
  }
  captureState = normalizeCaptureState(changes.voivoxCaptureState.newValue);
  render();
});

captureButton.addEventListener('click', () => void sendAction('capture:toggle'));
retryButton.addEventListener('click', () => void sendAction('capture:retry'));
modeFast.addEventListener('click', () => void setMode('fast'));
modeQuality.addEventListener('click', () => void setMode('quality'));

languageButton.addEventListener('click', async () => {
  locale = locale === 'zh-CN' ? 'en' : 'zh-CN';
  await chrome.storage.local.set({ [localeStorageKey]: locale });
  render();
});

copyButton.addEventListener('click', async () => {
  if (!captureState.transcript) {
    return;
  }
  await navigator.clipboard.writeText(captureState.transcript);
  copied = true;
  render();
  setTimeout(() => {
    copied = false;
    render();
  }, 1_500);
});

async function sendAction(type: 'capture:toggle' | 'capture:retry'): Promise<void> {
  operationInFlight = true;
  render();
  try {
    captureState = normalizeCaptureState(await chrome.runtime.sendMessage({
      target: 'service-worker',
      type
    }));
  } catch {
    captureState = {
      ...captureState,
      error: locale === 'zh-CN' ? '无法连接扩展后台。请重新打开 Voice Vac。' : 'Could not reach the extension background. Reopen Voice Vac.',
      phase: 'error'
    };
  } finally {
    operationInFlight = false;
    render();
  }
}

async function setMode(mode: TranscriptionMode): Promise<void> {
  if (captureState.mode === mode) {
    return;
  }
  operationInFlight = true;
  render();
  try {
    captureState = normalizeCaptureState(await chrome.runtime.sendMessage({
      mode,
      target: 'service-worker',
      type: 'mode:set'
    }));
  } finally {
    operationInFlight = false;
    render();
  }
}

function render(): void {
  document.documentElement.lang = locale;
  document.body.className = phaseClass(captureState.phase);
  headline.textContent = t('app.tagline');
  stateLabel.textContent = t(statusKey(captureState.phase));
  const captureLabel = t(captureActionKey(captureState));
  captureButton.textContent = captureState.active || isProcessingPhase(captureState.phase) ? 'Ⅱ' : '▶';
  captureButton.setAttribute('aria-label', captureLabel);
  actionLabel.textContent = captureLabel;
  message.textContent = captureMessage();
  languageButton.textContent = locale === 'zh-CN' ? 'EN' : '中';
  languageButton.setAttribute('aria-label', locale === 'zh-CN' ? 'Switch to English' : '切换到中文');

  modeLabel.textContent = t('model.label');
  setModeText(modeFast, t('model.fast'), '≈ 45 MB');
  setModeText(modeQuality, t('model.quality'), '≈ 80 MB');
  modeFast.setAttribute('aria-pressed', String(captureState.mode === 'fast'));
  modeQuality.setAttribute('aria-pressed', String(captureState.mode === 'quality'));
  modeHint.textContent = t(captureState.mode === 'fast' ? 'model.fastHint' : 'model.qualityHint');

  routeLabel.textContent = t('connection.browserLocal');
  routeHint.textContent = t('connection.browserHint');

  const isDownloading = captureState.phase === 'downloading';
  progressTrack.hidden = !isDownloading;
  progressBar.style.width = `${Math.round(captureState.progress ?? 0)}%`;

  transcriptHeading.textContent = t('transcript.title');
  copyButton.textContent = t(copied ? 'transcript.copied' : 'transcript.copy');
  copyButton.disabled = !captureState.transcript;
  const hasTranscript = Boolean(captureState.transcript?.trim());
  transcript.hidden = !hasTranscript;
  transcript.textContent = captureState.transcript ?? '';
  transcriptEmpty.hidden = hasTranscript;
  transcriptEmpty.textContent = t('transcript.empty');
  retryButton.hidden = !captureState.canRetry;
  retryButton.textContent = t('common.retry');

  privacy.textContent = t('privacy.localOnly');
  limit.textContent = t('capture.tenMinuteLimit');
  setControlsDisabled(isProcessingPhase(captureState.phase));
}

function captureMessage(): string {
  if (captureState.errorCode === 'transcription-cancelled') {
    return t('error.transcriptionCancelled');
  }
  if (captureState.errorCode === 'transcription-timeout') {
    return t('error.transcriptionTimedOut');
  }
  if (captureState.error) {
    return captureState.error;
  }
  if (captureState.phase === 'capturing') {
    return t('capture.recordingTab', { tab: captureState.tabTitle ?? t('capture.currentTab') });
  }
  if (captureState.phase === 'downloading') {
    return t('status.downloadProgress', { progress: Math.round(captureState.progress ?? 0) });
  }
  if (captureState.phase === 'transcribing') {
    return t('status.transcribing');
  }
  if (captureState.phase === 'complete') {
    return t('privacy.localOnly');
  }
  return t('capture.silentPrivacy');
}

function setControlsDisabled(busy: boolean): void {
  captureButton.disabled = operationInFlight;
  modeFast.disabled = operationInFlight || busy || captureState.active;
  modeQuality.disabled = operationInFlight || busy || captureState.active;
  retryButton.disabled = operationInFlight || busy;
}

function setModeText(button: HTMLButtonElement, label: string, size: string): void {
  const strong = button.querySelector('strong');
  const span = button.querySelector('span');
  if (strong) strong.textContent = label;
  if (span) span.textContent = size;
}

function statusKey(phase: CaptureState['phase']): MessageKey {
  const keys: Record<CaptureState['phase'], MessageKey> = {
    armed: 'status.ready',
    'awaiting-user-play': 'status.ready',
    capturing: 'status.capturing',
    complete: 'status.complete',
    connecting: 'status.capturing',
    downloading: 'status.downloading',
    error: 'status.error',
    idle: 'status.ready',
    paused: 'status.ready',
    transcribing: 'status.transcribing'
  };
  return keys[phase];
}

function phaseClass(phase: CaptureState['phase']): string {
  if (phase === 'capturing') return 'is-capturing';
  if (phase === 'downloading' || phase === 'transcribing') return 'is-processing';
  if (phase === 'error') return 'is-error';
  return '';
}

function t(key: MessageKey, variables?: Readonly<Record<string, string | number>>): string {
  return translate(locale, key, variables);
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element ${id}`);
  }
  return element as T;
}
