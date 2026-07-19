# Voice Vac 跨窗口 3D 管道设计

## 目标

把 Voice Vac 的核心亮点从“胶囊窗口中的管道动画”升级为“管道从桌面 App 伸入当前浏览器视频”的可验证交互。用户拖出吸头，吸头进入当前 Chrome 页面并吸附到视频；App 胶囊、页面吸头和中间软管保持同一个 session 状态。音频仍只通过 Chrome `tabCapture` 进入私有转录通道，不改变系统扬声器或麦克风。

## 设计判断

MCP 只用于开发期控制 Blender、生成和迭代 3D 资产，不承担运行时跨窗口绘制。运行时由 Electron 浮窗、Chrome Content Script 覆盖层和本地 Bridge 组成。单个 HTML 窗口不能真正越过自己的边界，因此“连续软管”由两个端点和跨坐标系曲线共同呈现。

## 技术选型

### 资产制作

- Blender 4.x 作为建模、材质、灯光、动画和 GLB 导出工具。
- 优先评估开源 `djeada/blender-mcp-server`：本地 MCP Server 通过 TCP 连接 Blender 插件，支持对象、材质、灯光、渲染、脚本和导出。
- MCP 仅用于开发机，不打包进最终 Voice Vac App。
- 输出资产必须是可复现的 `.blend` 源文件和 `.glb` 运行时文件。

### 运行时

- Three.js 使用 `GLTFLoader` 加载 GLB。
- 机身、吸头、端口使用静态网格与 PBR 材质。
- 软管使用骨骼链或参数化曲线形变；不能只使用伸缩圆柱。
- 动画状态：`idle`、`drag`、`stretch`、`snap`、`suction`、`complete`、`collapse`、`error`。

### 跨窗口连接

- Desktop：透明、置顶、无边框 Electron 窗口显示胶囊端点。
- Chrome：Content Script 在当前网页挂载 Shadow DOM 覆盖层，寻找并标记可播放 `<video>`，显示 3D 吸头和吸附轮廓。
- Bridge：本地 loopback WebSocket/HTTP，维护 `session_id`、端点屏幕坐标、目标 tab id、状态和窗口生命周期。
- Extension 仍通过 `tabCapture` 与 Offscreen Document 捕获目标标签页音频。
- PVTT MCP Server 只消费转录结果，不直接控制 Blender 或页面绘制。

## 运行时数据流

```text
App 胶囊
  └─ start_drag(session_id)
      ↓
Local Bridge
  └─ publish session + endpoint coordinates
      ↓
Chrome Content Script
  └─ mount nozzle overlay → detect <video> → snap
      ↓
Extension Service Worker / Offscreen
  └─ tabCapture → PCM → ASR
      ↓
Transcript Store → App / Extension / PVTT MCP
```

坐标消息最小格式：

```json
{
  "session_id": "uuid",
  "app_endpoint": {"screen_x": 240, "screen_y": 180},
  "page_endpoint": {"screen_x": 1240, "screen_y": 620},
  "tab_id": 123,
  "state": "stretch",
  "target_rect": {"x": 420, "y": 180, "width": 960, "height": 540}
}
```

## 交互状态机

```text
idle
  → dragging       用户按住吸头
  → detecting      页面扫描视频目标
  → ready          吸头吸附到视频
  → transcribing   开始捕获并转录
  → paused         短按主键暂停
  → completed      转录完成
  → error          权限、目标或连接失败
```

- `dragging`：软管沿 App 端点和指针实时伸长，波纹间距保持，不允许整体非均匀拉伸。
- `detecting`：候选视频出现细边吸附轮廓，吸头产生轻微磁吸预览。
- `ready`：释放指针后吸头锁定到视频边缘，软管产生一次回弹和锁定动画。
- `transcribing`：管道内部的光点从视频端流向 App 端，目标标签页静音处理，其他标签页不进入通道。
- `completed`：流动停止，端口亮起完成色，Transcript 气泡出现。
- `error`：软管短促抖动、端口变红，并显示可恢复错误原因。

## 3D 资产规格

### 新增视觉约束

- 胶囊是 App 的外壳，不是软管本身；外壳保持小型 iOS 液态玻璃胶囊。
- 玻璃优先采用光滑高光、轻微折射、透明边缘和弹性 hover/press 反馈，不使用粗糙磨砂或旧版绿色主按钮。
- 主按钮保留独立的圆形 Apple 玻璃触感，播放/暂停图标保持高对比但不使用厚重描边。
- 吸头必须是立体吸尘器头，带两个眼睛、前端吸入口、机械套环和软管连接件；不能用二维圆角块代替。
- 软管的中心线必须包含轻微弯曲、固定位置的小褶皱和拉伸时的角度抖动；收回时沿曲线发生随机但可复现的局部折叠，不能出现折线式硬拐角。

### 机身

- 白色光滑玻璃胶囊，非磨砂；圆角半径和高光要像 iOS 浮层。
- 左右两个圆形端口，端口内部为深色吸入口和细环形高光。
- 主控键为玻璃圆形按钮，只有播放/暂停语义，不使用旧版绿色按钮。

### 吸头

- 游戏道具风格的双眼吸尘器头；前端宽、后端收窄，带软质橡胶边缘。
- 与胶囊端口共享材质语言，但可在页面上提高对比度。

### 软管

- 波纹几何由真实环节或高质量法线贴图组成。
- 保留静止卷曲形态；拉伸时沿骨骼或曲线延展，横截面保持圆形。
- 连接处有机械套环，吸附时产生压缩和回弹。
- 曲线使用固定 seed 的褶皱位置，保证每次运行形变一致；实时阶段再叠加小幅阻尼抖动。

### 输出与压缩

- 首选单文件 GLB；需要较大纹理时使用 KTX2/Draco 或 Meshopt。
- 每个端点和动画都必须有稳定节点名，便于 Three.js 控制。

## 三种实现路径评估

### A：推荐，跨窗口技术验证后接入 GLB

先用占位几何验证 App→Chrome 的坐标同步、吸附和音频闭环，再替换为 Blender GLB。

- 优点：最快验证产品真正亮点，避免先做漂亮模型却发现窗口连接不可用。
- 缺点：需要经历一次占位体阶段。

### B：先做 Blender 全套资产，再做跨窗口

- 优点：第一眼视觉更完整。
- 缺点：如果坐标、窗口移动、页面滚动处理不稳定，资产制作会返工。

### C：只做单窗口 3D 胶囊

- 优点：最省工程量。
- 缺点：无法证明 Voice Vac 最独特的“管道伸出 App”亮点，不采用。

推荐 A，然后立即进入 Blender 资产替换。

## MVP 验收标准

1. App 胶囊保持小型、透明、置顶，窗口不变成仪表盘。
2. 吸头可以从 App 拖到当前 Chrome 页面的视频区域。
3. 页面出现吸附轮廓，松开后吸头锁定到可播放视频。
4. App 窗口、浏览器窗口移动或页面滚动后，连接位置重新计算且不漂移。
5. 连接成功后，软管出现真实的伸缩、压缩、回弹和吸气反馈。
6. 点击主控键后，只捕获目标标签页音频；系统扬声器、麦克风和其他标签页不被改动。
7. 转录结果同时可由 App、Extension 和 PVTT MCP 获取。
8. 页面不支持捕获、目标视频不可访问或 Bridge 断开时，显示可恢复错误，不伪装成成功。

## 测试计划

### 几何与动画

- Blender 导出后检查节点名、材质、动画 clip 和包体积。
- Three.js 加载 GLB 并验证 idle/drag/snap/suction/collapse 全部可触发。
- 在 WebGL 不可用时保留可交互的降级提示，但不把 CSS 降级当成默认视觉。

### 跨窗口

- App 与 Chrome 在同一显示器上拖拽连接。
- 移动 Chrome 窗口、滚动页面、切换标签页后检查端点重定位。
- 关闭页面、关闭扩展、退出 App 时清理 session 和覆盖层。

### 音频隔离

- 仅目标 tab 进入 `tabCapture`。
- 系统扬声器和麦克风设备不改变。
- 其他标签页和 Spotify/Logic Pro 不进入 ASR。

## 当前环境结论

本机已安装 Blender 5.2 LTS，并注册 `djeada/blender-mcp-server` 作为本地开发 MCP。`tools/blender/assets/voice-vac-machine.blend` 与 `.glb` 已通过节点/动画校验；Three.js 运行时加载 GLB 机身与吸头，并用参数化管道实时生成可伸缩的波纹与局部褶皱。

跨窗口最小闭环也已落地：本地 loopback 提供 `/v1/tunnel-sessions` 与受限的 `/v1/extension/tunnel-sessions`，Extension 在吸头松开时注册目标标签页，桌面 App/MCP 可读取同一会话；网页端用 SVG 曲线覆盖层表现吸头到视频目标的跨页面连接，滚动与窗口变化时重新计算端点。

下一阶段重点是把 Electron 端点从“会话同步”升级为全屏透明 overlay 的连续渲染，并在真实 Chrome 标签页上完成拖拽、吸附、静音捕获和转写的端到端录屏验收。
