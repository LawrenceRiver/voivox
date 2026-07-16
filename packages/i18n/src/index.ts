export type Locale = 'zh-CN' | 'en';

const zhCNMessages = {
  'app.name': 'VOIVOX',
  'app.tagline': '把正在播放的声音变成文字',
  'language.label': '语言',
  'language.system': '跟随系统',
  'language.zhCN': '中文',
  'language.en': 'English',
  'common.close': '关闭',
  'common.copy': '复制',
  'common.retry': '重试',
  'common.save': '保存',
  'common.settings': '设置',
  'status.ready': '准备就绪',
  'status.checking': '正在检查…',
  'status.downloading': '正在下载模型…',
  'status.capturing': '正在静音收录',
  'status.transcribing': '正在转写…',
  'status.complete': '转写完成',
  'status.error': '出了一点问题',
  'capture.start': '开始转写',
  'capture.stop': '停止收录',
  'capture.currentTab': '当前 Chrome 标签页',
  'capture.remainingSeconds': '还可录制 {seconds} 秒',
  'capture.silentPrivacy': '只读取声音，不会接管输入法或改变系统音量。',
  'model.fast': '快速',
  'model.quality': '高质量',
  'model.firstDownload': '模型只在第一次使用时下载，之后会保存在本机。',
  'source.title': '声音来自哪里？',
  'source.automatic': '自动发现',
  'source.chromeTab': 'Chrome 标签页',
  'source.macosApp': 'macOS 应用',
  'sessions.title': '最近收录',
  'sessions.empty': '还没有转写记录。',
  'transcript.title': '原始转写',
  'transcript.empty': '开始收录后，文字会出现在这里。',
  'mcp.title': 'Codex MCP',
  'mcp.ready': 'Codex 可以读取你保存的原始转写。',
} as const;

export type MessageKey = keyof typeof zhCNMessages;

const englishMessages = {
  'app.name': 'VOIVOX',
  'app.tagline': 'Turn the audio playing now into text',
  'language.label': 'Language',
  'language.system': 'Follow system',
  'language.zhCN': '中文',
  'language.en': 'English',
  'common.close': 'Close',
  'common.copy': 'Copy',
  'common.retry': 'Retry',
  'common.save': 'Save',
  'common.settings': 'Settings',
  'status.ready': 'Ready',
  'status.checking': 'Checking…',
  'status.downloading': 'Downloading model…',
  'status.capturing': 'Capturing silently',
  'status.transcribing': 'Transcribing…',
  'status.complete': 'Transcript complete',
  'status.error': 'Something went wrong',
  'capture.start': 'Start transcribing',
  'capture.stop': 'Stop capture',
  'capture.currentTab': 'Current Chrome tab',
  'capture.remainingSeconds': '{seconds} seconds remaining',
  'capture.silentPrivacy': 'Reads audio only. It never takes over typing or changes system volume.',
  'model.fast': 'Fast',
  'model.quality': 'High quality',
  'model.firstDownload': 'The model downloads once, then stays cached on this device.',
  'source.title': 'Where is the audio coming from?',
  'source.automatic': 'Auto-detect',
  'source.chromeTab': 'Chrome tab',
  'source.macosApp': 'macOS app',
  'sessions.title': 'Recent captures',
  'sessions.empty': 'No transcripts yet.',
  'transcript.title': 'Raw transcript',
  'transcript.empty': 'Your transcript will appear here after capture starts.',
  'mcp.title': 'Codex MCP',
  'mcp.ready': 'Codex can read the raw transcripts you save.',
} as const satisfies Record<MessageKey, string>;

export const messages: Readonly<
  Record<Locale, Readonly<Record<MessageKey, string>>>
> = {
  'zh-CN': zhCNMessages,
  en: englishMessages,
};

export function resolveLocale(
  systemLanguage: string | null | undefined,
  persisted?: string | null,
): Locale {
  if (persisted === 'zh-CN' || persisted === 'en') {
    return persisted;
  }

  const normalizedSystemLanguage = systemLanguage
    ?.trim()
    .toLowerCase()
    .replaceAll('_', '-');

  return normalizedSystemLanguage && /^zh(?:-|$)/u.test(normalizedSystemLanguage)
    ? 'zh-CN'
    : 'en';
}

export function translate(
  locale: Locale,
  key: MessageKey,
  variables: Readonly<Record<string, string | number>> = {},
): string {
  return messages[locale][key].replace(/\{([^{}]+)\}/gu, (placeholder, variable: string) => {
    const value = variables[variable];
    return value === undefined ? placeholder : String(value);
  });
}
