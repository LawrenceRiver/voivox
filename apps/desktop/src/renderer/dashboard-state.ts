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
  input: CapturePresentationInput
): CapturePresentation {
  if (input.activeSession?.status === 'capturing') {
    return {
      actionLabel: '停止收录',
      canChangeSource: false,
      notice: `VOIVOX 正在监听 ${input.sourceLabel}，不会改变其他应用的输入法或声音设置。`,
      statusLabel: '正在静音收录'
    };
  }

  if (input.sourceKind === 'chrome-tab') {
    return {
      actionLabel: '在扩展中开始',
      canChangeSource: true,
      notice: '在 Chrome 扩展中点击开始后，只有当前标签页的声音会被发送到本机转写引擎。',
      statusLabel: '准备就绪'
    };
  }

  return {
    actionLabel: '开始静音收录',
    canChangeSource: true,
    notice: input.sourceKind === 'macos-process'
      ? '选择后，只有所选 macOS 应用的声音会被发送到本机转写引擎。'
      : '选择后，只有内建麦克风的声音会被发送到本机转写引擎。',
    statusLabel: '准备就绪'
  };
}
