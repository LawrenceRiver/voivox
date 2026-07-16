import { describe, expect, it } from 'vitest';

import {
  messages,
  resolveLocale,
  translate,
  type MessageKey,
} from '../src/index.js';

describe('resolveLocale', () => {
  it.each(['zh', 'zh-CN', 'zh_Hans_CN', 'ZH-hant-TW'])(
    'maps the Chinese system locale %s to zh-CN',
    (systemLanguage) => {
      expect(resolveLocale(systemLanguage, null)).toBe('zh-CN');
    },
  );

  it.each(['en', 'en-US', 'pl-PL', '', undefined])(
    'falls back to English for the system locale %s',
    (systemLanguage) => {
      expect(resolveLocale(systemLanguage, null)).toBe('en');
    },
  );

  it('prefers a valid persisted locale and ignores an invalid one', () => {
    expect(resolveLocale('en-US', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('zh-CN', 'en')).toBe('en');
    expect(resolveLocale('zh-CN', 'fr')).toBe('zh-CN');
  });
});

describe('translate', () => {
  it('returns the selected language message', () => {
    const key: MessageKey = 'capture.start';

    expect(translate('zh-CN', key)).toBe('开始转写');
    expect(translate('en', key)).toBe('Start transcribing');
  });

  it('interpolates named variables without dropping unresolved placeholders', () => {
    expect(translate('zh-CN', 'capture.remainingSeconds', { seconds: 42 })).toBe(
      '还可录制 42 秒',
    );
    expect(translate('en', 'capture.remainingSeconds')).toBe(
      '{seconds} seconds remaining',
    );
  });
});

describe('message catalogs', () => {
  it('keeps the English catalog in exact key parity with the Chinese source catalog', () => {
    expect(Object.keys(messages.en).sort()).toEqual(
      Object.keys(messages['zh-CN']).sort(),
    );
  });
});
