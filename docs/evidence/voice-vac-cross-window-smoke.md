# Voice Vac 跨窗口会话验证记录

日期：2026-07-19

## 已验证

- `CrossWindowSessionStore` 能创建、更新、复制快照、清理过期会话。
- 本地 Bridge 提供桌面端 `/v1/tunnel-sessions`。
- Chrome 限权 Bridge 提供 `/v1/extension/tunnel-sessions`，只接受扩展令牌和扩展 Origin。
- Extension 内容脚本可以扫描可见 `<video>`，在拖动吸嘴时高亮目标，并绘制页面级 SVG 曲线路径。
- 目标标签页滚动或窗口大小变化时，曲线端点重新计算。
- 释放吸嘴后，Extension 注册标题、URL、目标矩形和页面端点；App/MCP 可读取同一 session。

## 还需要真实设备验收

1. 在 Chrome 中打开一个可播放视频，加载 `apps/chrome-extension/dist`。
2. 打开 Voice Vac App，把吸嘴拖到视频区域，确认轮廓吸附后释放。
3. 点击播放按钮，确认目标标签页静音，其他标签页和 macOS 音频设备不变。
4. 等待中文或英文转写，确认 Extension/App/MCP 返回同一份纯文本。
5. 移动 Chrome 窗口、滚动页面、关闭标签页，确认 session 能更新或清理。

这份记录不把 SVG 曲线冒充成真正的跨 OS 3D 窗口；连续的全屏透明 overlay 仍是后续桌面渲染增强项。
