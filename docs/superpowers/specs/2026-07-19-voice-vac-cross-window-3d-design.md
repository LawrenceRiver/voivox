# Voice VAC 原生跨窗口产品设计

## 1. 最终定义

**产品名：Voice VAC**

Voice VAC 是一台常驻 macOS 桌面的微型“视频吸尘器”。用户把三维吸头从玻璃胶囊中拖到 Chrome 视频上，按下实体红钮，目标标签页的声音便通过独立的私有通道进入本地语音识别模型，并从独立玻璃气泡中变成文字。

它只处理用户当前能够正常播放的内容，不修改 macOS 扬声器、麦克风或 Logic Pro 等应用的音频设备，不录制其他应用，不绕过 DRM、登录或付费权限，也不依赖云端 API。

用户可见名称、安装包、Extension 标题、README 和演示材料统一使用 `Voice VAC`。为避免破坏已经安装的 Chrome Extension、Native Messaging、MCP 配置和本地数据，第一轮原生迁移保留现有内部兼容标识，例如 `@voivox/*`、`VOIVOX_*`、`com.voivox.bridge`、`io.voivox.app` 与既有 Extension ID；这些标识不再出现在正常用户界面中。

## 2. 已锁定的产品原则

- App 是母版体验；Extension 和 MCP Monitor 复用相同状态、颜色、图标与动效语义。
- 胶囊不是普通应用窗口或仪表盘，而是一个始终悬浮的小型桌面装置。
- 软管必须在视觉上真正伸出胶囊并跨越其他窗口。
- Blender 负责游戏级资产；运行时由原生 macOS 窗口和 3D 引擎完成，Blender 不随 App 分发。
- 软管不是伸缩圆柱或网页曲线，而是带真实波纹网格、骨骼、弯曲、扭转、阻尼和回弹的可形变资产。
- 拖拽模式绑定的是当前 Chrome 标签页与视频元素，不是简单复制网页 URL。
- 吸附成功只进入“已就绪”；必须按红色按钮才开始播放、捕获和转录。
- 无效吸附不会自动弹回。吸头留在原处并亮黄灯，用户可以重新拖动或点击 `×` 收回。
- 所有界面提示默认英语；用户切换中文界面后才显示中文。转写内容始终保持视频原语言。

## 3. App 的视觉结构

### 3.1 胶囊

- 基准尺寸约为 `406 × 116 pt`，高度参照用户桌面截图中的男性桌面宠物，宽度约为高度的 3.5 倍。
- 使用真正的圆角胶囊轮廓，底片为光滑、透明、带折射和高光的 macOS Liquid Glass，不使用磨砂白卡片。
- 胶囊默认停靠在屏幕右下区域；拖动玻璃空白处可以移动，位置在下次启动时恢复。
- 胶囊内部只有两个主要物件：
  - 左侧：停泊在圆形接口中的三维鸭嘴吸头；
  - 右侧：带真实按压行程的三维红色按钮。
- 设置、语言、模型、模式和 Automation Mode 不占用胶囊表面；它们从状态栏图标或胶囊上下文菜单打开独立的窄玻璃面板。

### 3.2 鸭嘴吸头

- 待机时鸭嘴长方形开口竖向停泊。
- 外形是游戏道具化的吸尘器头：宽扁吸入口、柔软边缘、机械套环和软管连接口；不是二维圆角矩形。
- 吸头拥有独立的透明命中窗口，因此可以接收拖拽和双击，而软管覆盖层始终允许鼠标穿透。
- 拖出后吸头可以跨 App、Chrome、桌面和其他普通窗口移动。

### 3.3 红色按钮

- 视觉参考实体机械按钮：红色软质覆膜帽、暗色底座、短行程弹簧和边缘高光。
- `ready` 时按钮底座出现柔和的暖白提示光。
- 按下开始转录后，按钮帽保持在压低状态。
- 转录中再次短按进入暂停；暂停时按钮回升一小段但不完全弹起；再次按下继续。
- 点击软管上的 `×` 负责停止、保存当前文字并收回软管。
- 不使用绿色主按钮或扁平网页播放图标。

### 3.4 Transcript 气泡

- 气泡是独立透明悬浮窗口，不拼进胶囊。
- 外观参照用户提供的桌面宠物气泡：细长、光滑玻璃、轻微阴影和紧凑两行信息。
- 第一行固定显示 `Voice VAC`。
- 第二行显示最新一至两行实时转写；右侧显示圆形活动状态。
- 点击气泡展开完整 Transcript；展开面板提供复制全文、复制选中内容、清空、重新转录以及 TXT/SRT/VTT/JSON 导出。
- 复制成功后使用短暂的 `Copied` / `已复制` 状态，不把状态文字混入复制内容。

## 4. 跨窗口运行时

一个 `406 × 116 pt` 的窗口不能在自身边界之外绘制像素。Voice VAC 使用多个透明窗口合成为一个连续装置：

```text
Voice VAC.app（LSUIElement 后台宿主）
│
├─ CapsulePanel
│  └─ AppKit NSPanel + NSGlassEffectView
│
├─ HoseOverlayPanel[每块显示器一个]
│  └─ 透明、置顶、点击穿透；RealityKit/Metal 渲染软管与粒子
│
├─ NozzleHitPanel
│  └─ 跟随吸头的最小交互窗口
│
├─ TranscriptPanel / URLInputPanel
│  └─ 独立 Liquid Glass 气泡
│
└─ Local Bridge
   ├─ Chrome Native Messaging
   ├─ 本地 ASR Service
   ├─ Transcript Store
   └─ MCP Server
```

胶囊窗口、吸头窗口、软管覆盖层和文字气泡的透明边界不可见。用户看到的是吸头和软管从胶囊中真实伸出，而不是一个巨大的透明主窗口。

### 4.1 原生技术栈

- 第一版最低系统为 macOS 26，目标为 Apple Silicon；这是使用系统级 Liquid Glass 并获得当前 RealityKit 能力的明确边界。
- Swift 6、AppKit：生命周期、状态栏、透明 `NSPanel`、拖放、跨屏坐标和点击穿透。
- `NSGlassEffectView`：胶囊、气泡和设置面板的原生 Liquid Glass。
- RealityKit：加载 Blender 资产、PBR 材质、骨骼蒙皮、动画和逐帧更新。
- Metal：仅用于 RealityKit 无法覆盖的软管形变或粒子着色，不从零重写完整渲染器。
- 现有 Electron UI 在迁移期间只保留为诊断入口；最终可见产品不再依赖 Electron/Three.js。

## 5. 软管资产与物理

### 5.1 Blender 资产

Blender 输出可复现的 `.blend` 源文件和运行时 `.usdz`/`.reality` 资产：

- 真实环形波纹软管；
- 48–72 节骨骼；
- 鸭嘴、旋转接头、接口套环、红色按钮及底座；
- 停泊、旋转、吸附压缩、按钮按下等确定性动画；
- 高曲率区域使用少量 corrective blend shapes，避免内弧穿插和硬折线。

所有资产使用稳定节点名，并配有自动节点、骨骼、材质、边界和导出验证。

### 5.2 运行时形变

软管采用：

```text
Orientation-based Cosserat Rod
+ XPBD compliant constraints
+ active-length deployment
+ Blender skinned corrugated mesh
```

- 中心线节点同时保存位置和材料朝向，以支持弯曲、剪切和扭转。
- 大部分长度来自胶囊中隐藏管段逐节部署，不把短管强行拉伸到屏幕对角线。
- 软管最大活动长度按当前多屏布局动态计算，至少覆盖当前屏幕对角线并保留约 8% 余量；单屏基准约为 `2200 pt`。
- 拖动时主端点跟随指针，管身以阻尼滞后，形成柔软塑料管被甩动的感觉。
- 低频、固定 seed 的微小预弯曲制造不规则蜿蜒；随机只影响次级运动，不改变手稿定义的主要动作。
- 鸭嘴连接处有视觉旋转接头，避免每次旋转都把整根软管拧成电话线。
- 吸气效果由端口压缩、软管脉冲与少量粒子表现，不模拟真实空气流体。

## 6. 两条主要交互路径

### 6.1 拖拽到 Chrome：Live Tunnel

```text
首次在目标页面点击 Extension 完成武装
→ 从胶囊拖出鸭嘴
→ 鸭嘴从竖向转为横向
→ 软管按活动长度逐段部署
→ Chrome 页面显示视频候选吸附轮廓
→ 松手后鸭嘴垂直接触并短促压缩
→ ready，红钮亮起
→ 用户按红钮
→ 页面尝试播放 + tabCapture + 本地 ASR
→ Transcript 气泡持续出字
```

原生拖放携带无害的 Voice VAC token。Chrome Content Script 接收精确落点，使用页面坐标和 `elementsFromPoint()` 找到该位置的视频、播放器或 iframe。保存的目标会话至少包含：

```json
{
  "tab_id": 123,
  "frame_id": 0,
  "title": "Example Video",
  "source_url": "https://example.com/video",
  "target_kind": "video_element",
  "target_rect": {"x": 320, "y": 180, "width": 960, "height": 540}
}
```

跨域 iframe、closed shadow root 或自定义播放器无法稳定定位内部控件时，降级为 `tab_audio_only`：仍可捕获该标签页音频，但不能承诺自动控制播放器。

### 6.2 双击鸭嘴：URL / Accelerated Decode

双击鸭嘴触发严格的四阶段主动画：

1. 鸭嘴解锁并抬起；
2. 开口在屏幕平面内由竖向转为横向；
3. 向后伸出并形成快速 C 形；
4. 卷回形成轻微反 C / S 形，鸭嘴展开为 URL 输入舱。

用户粘贴链接并按 Enter 或小型 Start 键。系统只在合法访问媒体字节时进入 Accelerated Decode；无法获取媒体、MSE/blob、加密或受保护页面自动回退到 Live Tunnel，并提示用户武装对应 Chrome 页面。

## 7. Chrome 的两个发行版本

### 7.1 Voice VAC Store

面向 Chrome Web Store，使用最小权限：

```text
activeTab
scripting
tabCapture
offscreen
nativeMessaging
storage
```

- 每个新标签页或跨域导航后的页面需要点击一次 Extension 图标完成“武装”。
- 武装不会立即捕获、静音或播放；按红钮后才消费授权并启动通道。
- 默认使用 `HTMLMediaElement.play()`，不移动 macOS 鼠标。
- 若浏览器自动播放策略、跨域 iframe 或站点播放器阻止播放，气泡显示 `Press play once in Chrome`，用户真实点击一次后继续。

### 7.2 Voice VAC Automation

面向开发者、企业和侧载用户，单独构建并增加 `debugger` 权限：

- 设置面板提供醒目的 `Automation Mode` 开关。
- 首次开启前以一页简短说明解释权限用途，再引导安装/启用 Automation Extension。
- 开启后可通过 Chrome DevTools Protocol 在目标页面内部发送播放操作，不移动系统鼠标。
- 该权限无法在商店版中静默临时增加，因此必须是独立 Extension 构建；App 本身仍是同一个安装包。
- 仍不承诺绕过 DRM、登录、冻结标签页或站点自身的访问限制。

## 8. 状态机与错误语义

```text
idle
→ dragging
→ target_detected | tab_audio_only
→ ready
→ transcribing
↔ paused
→ completed
→ retracting
→ idle
```

异常不自动收回：

```text
dragging / ready / transcribing
→ warning_yellow
→ 重新拖动 | 点击 × 收回 | 修复后重试
```

主要英语提示：

- `Click the Voice VAC extension on this tab to arm it.`
- `No playable video found here.`
- `Press play once in Chrome.`
- `This embedded player needs one click to start.`
- `This tab is asleep. Bring it forward to continue.`
- `The page changed. Arm this tab again.`

基础设施错误必须返回稳定错误码，例如：

- `TAB_NOT_ARMED`
- `TARGET_NAVIGATED`
- `CAPTURE_DENIED`
- `STREAM_ID_EXPIRED`
- `STREAM_ENDED`
- `TAB_CLOSED`
- `NATIVE_HOST_UNAVAILABLE`
- `NO_AUDIO_AFTER_TIMEOUT`

所有错误都必须有文字解释，不能返回空字符串或伪装成功。

## 9. 收回交互

- 吸头部署后，`×` 固定在吸头上方沿软管切线约一至两指宽的视觉距离处。
- 点击 `×` 时若正在转录，先停止捕获并 flush 已生成 Transcript。
- 软管以受控速度逐节减少活动长度，内段带轻微滞后和摆动，吸头最后旋转回竖向并重新停泊。
- 无效落点和黄灯状态不会自动触发收回；用户可以直接重新抓住吸头继续拖。

## 10. ASR、Transcript 与 MCP

ASR 使用统一 Provider，不绑定调用方：

```text
LocalASRProvider
├─ transcribe_stream(audio_stream, options)
├─ transcribe_batch(audio_chunks, options)
└─ align(transcript, audio, options)
```

- 默认模型：`Qwen3-ASR-0.6B`，首次使用按需下载，避免把模型体积塞进 App 安装包。
- 可选高质量模型：`Qwen3-ASR-1.7B`。
- 时间戳使用 Forced Aligner 作为第二阶段，不阻塞第一份纯文本。
- `language = auto`，不添加翻译提示词，不把中文或英文强制成另一种语言。
- 音频只在本地内存和短生命周期分块中处理，默认不长期保存。

App、Extension 和 MCP 共享同一个 Transcript Store。MCP 的主工具保持：

```text
transcribe_active_video
```

它读取最近一次武装的目标会话并直接返回结构化 Transcript；没有已武装页面时返回 `NEEDS_USER_ARMING`，不要求用户先复制到剪贴板。

## 11. 三端一致性

| 状态 | App | Extension | MCP Monitor |
|---|---|---|---|
| idle | 胶囊待机、软管收起 | 等待武装 | 等待调用 |
| ready | 红钮暖白提示光 | 显示目标标题 | 正在连接 |
| transcribing | 红钮压低、管内流动、气泡出字 | 进度与最新文字 | 正在转录 |
| returning | 气泡完成、可展开复制 | 可复制全文 | 正在返回 |
| completed | 完成指示、文字保留 | 结果保留 | 已完成 |
| warning | 黄灯、气泡解释、保持位置 | 可恢复提示 | 结构化错误码 |

三端共享图标含义和状态颜色，但 Extension 只呈现压缩后的装置；MCP Monitor 不提供复制作为主要动作。

## 12. 验收与验证

### 原生 UI

- App 无普通主窗口、无大面积仪表盘、无 Dock 干扰。
- 胶囊基准尺寸、真圆角、Liquid Glass 和两件主物件与设计一致。
- 软管可跨窗口和全屏距离部署，透明区域不截断画面且不拦截无关鼠标操作。
- 鸭嘴双击动画、拖拽动画、吸附压缩、红钮行程、黄灯和缓慢收回均有录屏证据。

### Chrome

- 用户武装后再按红钮才开始捕获。
- 仅目标标签页进入 D Channel；其他标签页、Spotify、Logic Pro 和麦克风不进入。
- Store 与 Automation 两个构建均可安装，并能在 App 设置中清楚识别当前能力。
- 无效落点保留吸头，重新拖动与 `×` 收回均可用。

### 转录与 MCP

- 中文、英文及混合语言样例保持源语言。
- Live 模式可以边播边出字；可访问媒体源时 Accelerated 模式超实时处理并正确回退。
- App 关闭气泡前可继续读取结果；Extension 页面关闭前保留结果；MCP 直接返回完整 Transcript、来源和处理模式。

### 实机验证顺序

1. 单元测试与 Swift/TypeScript/Python 静态检查；
2. Blender 资产结构和导出验证；
3. AppKit Overlay 单屏、Retina、多屏和 Spaces 测试；
4. Chrome 测试页完成外部拖放 PoC；
5. 真实普通网页视频完成 Store 路径；
6. 真实自定义播放器完成 Automation 路径；
7. 使用 Computer Use 记录从武装、拖拽、ready、按键、转写、暂停到收回的完整证据；
8. 打包 DMG、Store Extension ZIP、Automation Extension ZIP 和 MCP 安装说明。

## 13. 实施顺序

1. 保留现有本地 ASR、Transcript Store、MCP 和 tabCapture 能力，先冻结它们的回归测试。
2. 建立原生 AppKit 宿主、胶囊和 Transcript 气泡。
3. 建立 Blender 鸭嘴、按钮和波纹软管资产，并在 RealityKit 中验证。
4. 实现透明跨屏 Overlay、吸头命中窗口和软管物理。
5. 完成 Chrome 外部拖放 PoC 与页面武装状态。
6. 实现 Store 版 Live Tunnel，再实现 Automation 版。
7. 接入 Accelerated Decode、MCP Monitor 和三端状态同步。
8. 完成真实视频验证、隐私文档、安装包和发布证据。
