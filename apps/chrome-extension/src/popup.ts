import { getBridgeConfig, getCaptureState, saveBridgeConfig, type BridgeConfig } from './bridge.js';

const captureButton = requireElement<HTMLButtonElement>('capture');
const state = requireElement<HTMLElement>('state');
const message = requireElement<HTMLElement>('message');
const baseUrlInput = requireElement<HTMLInputElement>('base-url');
const tokenInput = requireElement<HTMLInputElement>('bridge-token');
const saveButton = requireElement<HTMLButtonElement>('save');

void initialize();

async function initialize(): Promise<void> {
  const [bridge, captureState] = await Promise.all([getBridgeConfig(), getCaptureState()]);
  if (bridge) {
    baseUrlInput.value = bridge.baseUrl;
    tokenInput.value = bridge.token;
  }
  render(captureState.active, captureState.tabTitle, captureState.error);
}

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ target: 'service-worker', type: 'capture:toggle' }) as {
      active: boolean;
      tabTitle?: string;
      error?: string;
    };
    render(response.active, response.tabTitle, response.error);
  } catch {
    render(false, undefined, '无法连接 Chrome 收录服务。请重新打开扩展。');
  } finally {
    captureButton.disabled = false;
  }
});

saveButton.addEventListener('click', async () => {
  const config: BridgeConfig = { baseUrl: baseUrlInput.value.trim(), token: tokenInput.value.trim() };
  if (!config.baseUrl.startsWith('http://127.0.0.1:') || !config.token) {
    message.textContent = '请填写桌面 App 提供的本机地址与 Chrome 桥接令牌。';
    return;
  }
  await saveBridgeConfig(config);
  message.textContent = '本机连接已保存。';
});

function render(active: boolean, tabTitle?: string, error?: string): void {
  state.textContent = active ? '收录中' : '准备就绪';
  captureButton.textContent = active ? '停止收录' : '开始静音收录';
  message.textContent = error ?? (active ? `正在收录：${tabTitle ?? '当前标签页'}` : '');
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element ${id}`);
  }
  return element as T;
}
