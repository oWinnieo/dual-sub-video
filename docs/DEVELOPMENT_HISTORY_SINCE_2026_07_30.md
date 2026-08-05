# LingoLoop 本地开发变更记录（自 2026-07-30 起）

> 更新日期：2026-08-05
> 仓库：`dual-sub-video`
> 统计范围：本地克隆基线 `a95b903` 之后，至工程维护提交 `f080be19b48234ea8a520a7fecbc75ee524b393a` 的所有可达提交；后续文档维护提交仅用于补录该提交。

## 1. 结论摘要

- 本项目于 **2026-07-30 20:08:20 +0800** 从 `https://github.com/Dankcode/dual-sub-video.git` 克隆到本机。
- 克隆时的基线提交是 `a95b903`，该提交本身的提交日期为 2026-07-13，不计入本地 7 月 30 日之后的开发提交。
- 第一条本地功能提交产生于 **2026-07-30 22:47:13 +0800**。
- 从克隆基线到统计截止提交共有 **13 个提交**：
  - 8 个功能提交；
  - 3 个纯合并提交；
  - 1 个文档维护提交；
  - 1 个工程维护提交。
- 统计截止提交相对克隆基线的最终净变化为：**31 个文件、增加 6,495 行、删除 12,307 行**；其中大部分删除行来自移除重复的 npm 锁文件，不代表业务代码大规模删减。
- 原先记录为尚未提交的“批量翻译、自适应限流、持久化缓存”改动，已经由 `e6cbcc15f02fd504e652dc5060018d153f202cd3` 正式提交。
- 接下来的重点优化方向是提升大文件、长视频的字幕生成速度：
  - 推理链路计划从 Whisper 模型迁移到 `whisper.cpp` 原生 C/C++ 程序，并以独立子进程运行，使高负载转写与界面、翻译等任务解耦。
  - 运行时根据操作系统和硬件能力自动选择加速后端：Apple Silicon 优先使用 Metal，NVIDIA GPU 可使用 CUDA，AMD 和 Intel 设备则按平台选择 ROCm、Vulkan 或 OpenVINO，并始终保留 CPU 回退路径。
  - 该优化不限定于苹果芯片，最终目标是建立一套统一、可检测、可回退的跨平台转写加速方案。
- 产品交互细节仍有进一步优化空间，后续需要持续完善操作反馈、状态提示、进度呈现、异常恢复和任务控制等体验，并统一不同功能阶段的交互逻辑，使视频导入、字幕生成、翻译、播放和导出流程更加清晰、连贯且易于理解。

## 2. 提交时间线

| 时间 | Commit | 类型 | 标题 |
| --- | --- | --- | --- |
| 2026-07-30 22:47 | `abac7b2` | 功能 | fix transcription and translation reliability |
| 2026-07-30 22:54 | `ca87a78` | 合并 | Merge pull request #1 from oWinnieo/codex/fix-transcription-translation |
| 2026-07-31 18:37 | `2d556f0` | 功能 | improve smart transcription and translation retries |
| 2026-07-31 18:39 | `a194589` | 合并 | merge smart transcription improvements |
| 2026-07-31 23:36 | `2ade39b` | 功能 | improve library and player controls |
| 2026-07-31 23:37 | `2cf22bd` | 合并 | merge library and player control improvements |
| 2026-08-01 18:23 | `15b3a31` | 功能 | feat: improve subtitle regeneration and translation flow |
| 2026-08-02 20:34 | `8cda329` | 功能 | Add progressive subtitle generation |
| 2026-08-04 00:43 | `2a44a10` | 功能 | Improve progressive subtitle generation |
| 2026-08-04 20:04 | `e6cbcc1` | 功能 | Improve translation batching and persistent cache |
| 2026-08-05 15:28 | `64cbea8` | 功能 | Improve media library workflow and sample testing |
| 2026-08-05 15:32 | `a57fdf8` | 文档 | Document media library workflow commit |
| 2026-08-05 15:54 | `f080be1` | 工程 | Standardize Node and Yarn tooling |

## 3. 每个 Commit 的具体改动

### 3.1 `abac7b2` — fix transcription and translation reliability

- 时间：2026-07-30 22:47:13 +0800
- 父提交：`a95b903`
- 规模：5 个文件，增加 524 行，删除 99 行

主要目标是让“本地 Whisper 转写 → 翻译 → 播放/导出”的失败状态能够被识别、展示和重试，而不是把失败结果当成成功字幕。

具体改动：

- 本地 Whisper 转写加入幻觉文本识别：
  - 检测重复词、重复短语和明显异常输出；
  - 拒绝无效字幕 cue；
  - 记录被拒绝的幻觉字幕数量；
  - 尝试根据文字脚本推断语言。
- `/api/transcribe` 增加更明确的错误类型：
  - `ASR_HALLUCINATION`：Whisper 只产生重复或无效文本；
  - `NO_SPEECH`：没有检测到可用语音；
  - 返回 `rejectedHallucinations` 供前端诊断。
- `/api/translate` 增加成功、失败和“译文与原文完全相同”的日志。
- 前端字幕翻译增加：
  - 60 秒请求超时；
  - 最多两次尝试；
  - 每条字幕保存 `translationError`；
  - 统计翻译失败数量；
  - 翻译未完成时不再错误标记为可播放、可导出状态；
  - 支持从失败状态重新翻译。
- 转写过程中锁定本次任务使用的源语言、目标语言和质量配置，避免任务运行中修改设置影响正在执行的任务。
- 媒体库条目开始保存检测语言、源语言、目标语言以及翻译失败状态。

涉及文件：

| 文件 | 改动 |
| --- | --- |
| `src/app/api/transcribe/route.js` | 转写错误分类、幻觉统计 |
| `src/app/api/translate/route.js` | 翻译日志和错误信息 |
| `src/app/page.js` | 翻译重试、状态管理、语言任务快照、播放/导出锁定 |
| `src/lib/asr-engines.js` | 将服务端诊断信息传递给前端 |
| `src/lib/local-transcription.js` | Whisper 幻觉检测、cue 评估和语言推断 |

### 3.2 `ca87a78` — Merge pull request #1

- 时间：2026-07-30 22:54:52 +0800
- 父提交：`a95b903`、`abac7b2`
- 类型：纯合并提交

该提交把 `codex/fix-transcription-translation` 分支中的 `abac7b2` 合并到主开发线。Git 没有记录额外的冲突解决代码，因此功能内容就是上一节所述的 `abac7b2`，不应再次计算为一套新的代码修改。

### 3.3 `2d556f0` — improve smart transcription and translation retries

- 时间：2026-07-31 18:37:39 +0800
- 父提交：`abac7b2`
- 规模：5 个文件，增加 564 行，删除 49 行

主要目标是提升自动语言检测、长音频漏句恢复和 Google 翻译受限时的恢复能力。

具体改动：

- Smart Auto 语言检测：
  - 从音频中选择代表性采样片段；
  - 聚合多个样本的语言证据；
  - 语言证据不足时返回明确错误，而不是随意锁定语言；
  - 自动检测到语言后，将识别质量升级到 Best 模型；
  - 将检测结果、置信度、有效模型和自动升级状态写入日志及 API 响应。
- Whisper 模型加载增加重试和并发加载保护，减少同一模型被重复加载。
- 增加“字幕空洞恢复”：
  - 计算音频帧能量；
  - 找出有明显语音、但没有字幕覆盖的区间；
  - 分段重新识别这些区间；
  - 把恢复出的 cue 合并回完整时间轴。
- Google 翻译增加服务端请求队列：
  - 请求启动间隔至少 250ms；
  - 最多尝试 3 次；
  - 重试间隔为 0ms、1200ms、4000ms；
  - 识别 408、425、429 和 5xx 等可重试状态。
- Google 主翻译通道失败后，临时切换到 GET 接口，并在 60 秒后再次尝试主通道。
- API 把上游状态码、`retryAfterMs` 和 `Retry-After` 返回给前端。
- 前端进一步展示 Smart Auto、空洞恢复、翻译重试等阶段信息。

涉及文件：

| 文件 | 改动 |
| --- | --- |
| `src/app/api/transcribe/route.js` | 输出 Smart Auto 和语音空洞恢复结果 |
| `src/app/api/translate/route.js` | Google 请求队列、重试、GET 后备通道、状态码透传 |
| `src/app/page.js` | 新诊断信息和重试状态展示 |
| `src/lib/asr-engines.js` | 传递语言检测与恢复元数据 |
| `src/lib/local-transcription.js` | 语言采样检测、Best 自动升级、模型加载保护、语音空洞恢复 |

### 3.4 `a194589` — merge smart transcription improvements

- 时间：2026-07-31 18:39:22 +0800
- 父提交：`ca87a78`、`2d556f0`
- 类型：纯合并提交

该提交把 `2d556f0` 的 Smart Auto、空洞恢复和翻译重试功能合并到主线，没有额外的冲突解决代码。

### 3.5 `2ade39b` — improve library and player controls

- 时间：2026-07-31 23:36:10 +0800
- 父提交：`2d556f0`
- 规模：2 个文件，增加 217 行，删除 28 行

主要目标是完善播放器控件说明和媒体库管理。

具体改动：

- 为播放器图标按钮新增统一 tooltip：
  - 播放速度；
  - 重播当前字幕；
  - 静音；
  - 全屏。
- 将尚未完成的跟读和闪卡功能明确显示为 `Coming Soon` 并禁用，避免用户误以为点击无效。
- 媒体库加入删除按钮：
  - 删除前二次确认；
  - 明确说明不会删除电脑上的原始媒体文件；
  - 处理期间禁止删除；
  - 删除当前媒体时重置播放器状态；
  - 自动选择相邻媒体，或在媒体库为空时返回起始页；
  - 释放对应的 Object URL。
- 新增 tooltip、媒体库行布局和危险删除按钮样式。

涉及文件：

| 文件 | 改动 |
| --- | --- |
| `src/app/page.js` | tooltip、Coming Soon 状态、媒体库删除逻辑 |
| `src/app/globals.css` | tooltip 和媒体库删除按钮样式 |

### 3.6 `2cf22bd` — merge library and player control improvements

- 时间：2026-07-31 23:37:11 +0800
- 父提交：`a194589`、`2ade39b`
- 类型：纯合并提交

该提交把 `2ade39b` 的播放器提示和媒体库删除功能合并到主线，没有额外的冲突解决代码。

### 3.7 `15b3a31` — feat: improve subtitle regeneration and translation flow

- 时间：2026-08-01 18:23:19 +0800
- 父提交：`2cf22bd`
- 规模：3 个文件，增加 638 行，删除 79 行

主要目标是让字幕重新生成、语言切换和批量翻译成为可恢复、可确认的完整工作流。

具体改动：

- 服务端增加进程内翻译缓存：
  - 根据源语言、目标语言和原文生成缓存键；
  - 缓存有效期 6 小时；
  - 最大 5000 条；
  - 可通过 `useCache` 控制是否使用。
- 服务端完善 Google 翻译错误处理：
  - 仅对可恢复状态重试；
  - 保留真实 HTTP 状态；
  - 对 429 返回等待时间。
- 前端翻译最大尝试次数提高到 3，并加入受控 worker pool，遵循 Concurrency 设置，不再同时发出所有 cue 请求。
- 并发阶段失败的字幕会等待 1800ms，然后逐条串行恢复，降低持续触发上游限流的概率。
- 新增语言切换确认对话框：
  - 修改源语言时重新执行语音识别和翻译；
  - 修改目标语言时保留原文和时间轴，仅重新翻译；
  - 用户可以取消并保留现有字幕。
- 新增媒体库字幕重新生成对话框：
  - 可重新选择 Spoken language 和 Translate to；
  - 旧字幕只在新任务成功后替换；
  - 未生成字幕的媒体也可通过同一入口创建字幕。
- 增加重新生成按钮、确认弹窗、状态提示和对应样式。

涉及文件：

| 文件 | 改动 |
| --- | --- |
| `src/app/api/translate/route.js` | 内存缓存、精确重试和状态码处理 |
| `src/app/page.js` | 语言切换确认、字幕重新生成、受控翻译 worker、失败恢复 |
| `src/app/globals.css` | 确认对话框、重新生成按钮和状态样式 |

### 3.8 `8cda329` — Add progressive subtitle generation

- 时间：2026-08-02 20:34:01 +0800
- 父提交：`15b3a31`
- 规模：8 个文件，增加 1,162 行，删除 103 行

主要目标是让长视频不必等待整段识别完成，而是按照时间段持续返回字幕。

具体改动：

- `/api/transcribe` 增加 NDJSON 流式响应模式：
  - 第一段默认 2 分钟；
  - 后续每段 3 分钟；
  - 持续发送 segment start、progress、complete 和 error 事件；
  - 浏览器上传和 Electron 本地路径都可使用流式模式。
- 本地 Whisper 增加分段识别：
  - 每段加入 8 秒上下文，减少边界断句；
  - 只保留时间中点属于当前分段的 cue，避免上下文重复；
  - 每段完成后立即回传字幕；
  - 处理完立即删除分段 WAV；
  - 清理超过一天的遗留临时任务目录。
- `asr-engines` 增加 NDJSON 流解析，将服务端事件转换为前端进度和分段回调。
- 前端可以在第一段字幕完成后进入播放器，并在后台继续转写、翻译剩余分段。
- 增加渐进任务进度、通知自动隐藏、分段翻译和媒体库任务状态。
- 新建 `whisper-language-detection.js`：
  - 基于 Whisper 语言 token，而不是普通解码文本进行语言判断；
  - 聚合 beam 候选与多个采样结果；
  - 弱证据返回 unknown，避免错误锁定语言。
- 新增语言检测单元测试，并在 `package.json` 中加入 `yarn test` 脚本。

涉及文件：

| 文件 | 改动 |
| --- | --- |
| `package.json` | 新增 Node test runner 脚本 |
| `src/app/api/transcribe/route.js` | NDJSON 分段流式接口 |
| `src/app/globals.css` | 渐进处理状态和提示样式 |
| `src/app/page.js` | 分段接收、边生成边播放、后台翻译 |
| `src/lib/asr-engines.js` | NDJSON 流解析 |
| `src/lib/local-transcription.js` | Whisper 分段识别、上下文、临时文件清理 |
| `src/lib/whisper-language-detection.js` | 语言 token 检测逻辑 |
| `test/whisper-language-detection.test.js` | 语言检测测试 |

### 3.9 `2a44a10` — Improve progressive subtitle generation

- 时间：2026-08-04 00:43:05 +0800
- 父提交：`8cda329`
- 规模：7 个文件，增加 1,541 行，删除 176 行

主要目标是把基础的流式字幕升级为具备安全缓冲、跳转优先级、暂停恢复和原文先行能力的完整渐进播放系统。

具体改动：

- 启动分段调整为 60 秒、60 秒、120 秒，之后使用 180 秒稳定分段，以更快产生第一段可播放内容。
- 新增渐进缓冲算法：
  - 估算字幕生成速度；
  - 根据生成速度计算 2–8 分钟安全缓冲；
  - 估计还需等待的时间；
  - 支持“立即播放”或“等待安全缓冲”选择。
- 新增字幕生成范围模型：
  - 记录已生成区间；
  - 合并相邻区间；
  - 计算连续可播放位置和总覆盖时间；
  - 在时间轴上保留尚未生成的空洞。
- 拖动或跳转到尚未生成的位置时：
  - 保存待处理 seek；
  - 优先处理播放位置附近及其后的分段；
  - 目标附近字幕准备好后自动完成跳转。
- 增加后台任务控制：
  - 安全暂停并保存进度；
  - 从已完成翻译分段之后恢复；
  - 取消请求与翻译请求；
  - 媒体库保存 partial/progressiveJob 状态。
- 增加“原文字幕先行”模式：
  - Whisper 原文完成后即可播放；
  - 中文翻译在后台原位补全；
  - 双语字幕按照 cue ID 合并。
- 渐进翻译按小批次执行，并限制并发，降低长视频触发翻译限流的概率。
- 新建 `progressive-buffer.js`，集中实现分段、恢复点、优先级、范围合并、字幕合并和缓冲估算。
- 新增 171 行单元测试，覆盖：
  - 启动分段与短视频截断；
  - 安全恢复点；
  - 分段翻译批次；
  - 并发上限；
  - 快慢网络缓冲估算；
  - seek 分段优先级；
  - 稀疏区间合并；
  - 原文与翻译合并。

涉及文件：

| 文件 | 改动 |
| --- | --- |
| `src/app/api/transcribe/route.js` | 启动分段计划和恢复参数 |
| `src/app/globals.css` | 缓冲、时间轴、暂停恢复和状态 UI |
| `src/app/page.js` | 渐进播放主状态机、seek 优先、原文先行、暂停恢复 |
| `src/lib/asr-engines.js` | 传递恢复和流式控制参数 |
| `src/lib/local-transcription.js` | 按恢复点生成分段 |
| `src/lib/progressive-buffer.js` | 渐进分段与缓冲算法 |
| `test/progressive-buffer.test.js` | 渐进缓冲单元测试 |

### 3.10 `e6cbcc15f02fd504e652dc5060018d153f202cd3` — Improve translation batching and persistent cache

- 时间：2026-08-04 20:04:35 +0800
- 父提交：`2a44a10`
- 规模：15 个文件，增加 1,565 行，删除 457 行

该提交解决了翻译调用虽然在界面上有 Batch size 和并发设置，但服务端仍然逐条、单队列串行执行的问题，并把临时内存缓存升级为用户可管理的持久化缓存。

具体改动：

- 新增全局自适应请求池：
  - 初始并发为 2，最高为 3；
  - 收到 429 后立即降为 1；
  - 遵守 `Retry-After`；
  - 冷却完成并连续成功后逐步恢复并发；
  - 请求启动仍保留最小间隔，避免瞬时突发。
- 将免费 Google 翻译通道改成真实批量翻译：
  - 默认每批 20 条；
  - 最多每批 40 条；
  - 每批最多约 6,000 字符；
  - 使用随机批次 token 和编号标记合并文本；
  - 返回结果必须通过条数、标记、索引和顺序校验。
- 增加批量失败兜底：
  - 对齐失败或上游异常时递归二分拆批；
  - 最终可回退到单条请求；
  - 同一请求中的重复文本先去重，再按原 cue ID 回填，避免字幕错位。
- 新增持久化翻译缓存：
  - 使用 SHA-256 内容寻址；
  - 缓存描述包含提供商、模型、源语言、目标语言和原文；
  - 默认目录为 `~/.lingoloop/cache/translations`；
  - 采用临时文件加原子重命名写入；
  - 保留会话内存缓存作为快速层。
- 新增缓存管理能力：
  - `/api/translate/cache` 提供状态查询和清理接口；
  - Electron 增加选择目录和打开目录的 IPC；
  - Advanced 设置页允许用户选择、自定义、恢复默认、打开和清空缓存目录；
  - 浏览器模式明确禁用只适用于 Electron 的目录操作。
- 调整渐进翻译：
  - 界面的 Batch size 真正接入翻译拆批；
  - 拆批同时遵守 cue 数量和字符预算；
  - 渐进翻译并发上限调整为 3；
  - 翻译超时延长到 45 秒。
- 新增自适应请求池、翻译批处理、持久化缓存测试，并更新渐进缓冲测试。

涉及文件：

| 文件 | 改动 |
| --- | --- |
| `.gitignore` | 忽略本地翻译缓存目录 |
| `main/main.js` | 缓存目录选择与打开 IPC |
| `src/app/api/translate/cache/route.js` | 缓存状态和清理 API |
| `src/app/api/translate/route.js` | 批量翻译、对齐校验、去重、拆批和持久化缓存接入 |
| `src/app/globals.css` | 缓存设置界面样式 |
| `src/app/page.js` | 批大小接入、缓存目录设置和渐进翻译调整 |
| `src/lib/adaptive-request-pool.js` | 自适应并发池 |
| `src/lib/progressive-buffer.js` | 按数量和字符预算拆分翻译批次 |
| `src/lib/translation-batch.js` | 批次构建、编号标记和结果解析 |
| `src/lib/translation-cache.js` | 会话缓存和磁盘持久化缓存 |
| `test/adaptive-request-pool.test.js` | 自适应并发测试 |
| `test/progressive-buffer.test.js` | 渐进批次测试更新 |
| `test/translation-batch.test.js` | 批次与对齐测试 |
| `test/translation-cache.test.js` | 持久化缓存测试 |
| `yarn.lock` | 依赖锁文件更新 |

### 3.11 `64cbea84e6a7eac04433672be889d44f489d86de` — Improve media library workflow and sample testing

- 时间：2026-08-05 15:28:51 +0800
- 父提交：`e6cbcc15f02fd504e652dc5060018d153f202cd3`
- 规模：10 个文件，增加 751 行，删除 88 行

主要目标是完善媒体库导入与后台任务交互，统一长视频字幕生成过程中的界面反馈，并加入可以随应用分发的本地转写测试样例。

具体改动：

- 新增媒体身份识别逻辑：桌面端优先按规范化绝对路径识别同一媒体，浏览器端按文件名、大小和最后修改时间识别重复文件；同一批选择中的重复项目也会被跳过。
- 媒体库增加独立的“添加视频”入口，避免从媒体库添加文件后自动切换当前播放项目；重复导入时显示明确提示。
- 点击正在处理的媒体库项目时改为展示该任务的生成进度，并允许关闭进度视图后继续后台处理。
- 统一长视频渐进生成、暂停、恢复、缓冲和优先生成等状态的英文提示与操作文案。
- 加入基于 whisper.cpp JFK 公共领域语音样例生成的内置 MP4，并补充来源说明和文件存在性测试。
- 新增媒体重复识别单元测试，并将用量超限错误信息统一为英文。
- 新增本地开发历史文档，汇总克隆基线之后的提交记录、改动范围和后续优化方向。

涉及文件：

| 文件 | 改动 |
| --- | --- |
| `.gitignore` | 允许提交内置样例视频 |
| `docs/DEVELOPMENT_HISTORY_SINCE_2026_07_30.md` | 新增开发历史、统计口径和后续优化方向 |
| `public/samples/ATTRIBUTION.md` | 更新 JFK 样例来源与授权说明 |
| `public/samples/sample.mp4` | 新增内置本地转写测试视频 |
| `src/app/globals.css` | 重复导入提示和处理进度界面样式 |
| `src/app/page.js` | 防重复导入、媒体库任务进度交互和生成状态文案 |
| `src/lib/media-identity.js` | 媒体身份键生成与重复文件分组 |
| `src/lib/usage-tracker.js` | 用量超限错误文案统一 |
| `test/media-identity.test.js` | 媒体身份与重复导入测试 |
| `test/sample-media.test.js` | 内置样例文件存在性测试 |

### 3.12 `a57fdf8ace54eb3e461828bed79fe79658d4afe8` — Document media library workflow commit

- 时间：2026-08-05 15:32:17 +0800
- 父提交：`64cbea84e6a7eac04433672be889d44f489d86de`
- 规模：1 个文件，增加 52 行，删除 11 行
- 类型：文档维护提交

该提交把 `64cbea84e6a7eac04433672be889d44f489d86de` 的真实提交信息、媒体库交互改动和最新净变化补录到本文档，并将统计范围固定到该功能提交。

### 3.13 `f080be19b48234ea8a520a7fecbc75ee524b393a` — Standardize Node and Yarn tooling

- 时间：2026-08-05 15:54:49 +0800
- 父提交：`a57fdf8ace54eb3e461828bed79fe79658d4afe8`
- 规模：5 个文件，增加 15 行，删除 11,751 行
- 类型：工程维护提交

主要目标是统一可复现的开发与打包环境，解决 ESLint 因缺少 TypeScript peer dependency 无法启动，以及 Node 20 不满足 `@electron/rebuild@4.0.1` 运行要求的问题。

具体改动：

- 新增 `.nvmrc`，将项目开发环境固定到 Node.js 22；`package.json` 同时声明最低版本为 Node.js 22.12.0。
- 在 `package.json` 中声明 Yarn 1.22.22 为项目包管理器，并把 TypeScript 5 加入开发依赖；实际锁定版本为 5.9.3。
- 删除重复的 `package-lock.json`，保留 `yarn.lock` 作为唯一依赖锁文件，避免 npm 与 Yarn 解析结果分叉。
- 更新 Whisper 兼容脚本中的依赖安装提示，统一使用 `yarn install`。
- 正式安装和验证不再使用 `--ignore-engines`；该参数只在问题诊断期间临时使用过。

验证结果（Node.js 22.23.2、Yarn 1.22.22）：

- `yarn install --frozen-lockfile`：通过。
- `yarn test`：29 项测试全部通过。
- `yarn lint`：通过，原先缺少 TypeScript 导致的启动错误已解决。
- `yarn build`：通过，Next.js 生产构建成功。
- `yarn electron:pack`：通过，Apple Silicon 的 `sharp` 原生模块完成重建，并生成未公证的 macOS arm64 应用目录；正式发布仍需单独验证开发者签名和 notarization。

涉及文件：

| 文件 | 改动 |
| --- | --- |
| `.nvmrc` | 固定使用 Node.js 22 |
| `package.json` | 声明 Node/Yarn 版本并增加 TypeScript 开发依赖 |
| `package-lock.json` | 删除重复的 npm 锁文件 |
| `scripts/setup-whisper.sh` | 将依赖安装提示统一为 Yarn |
| `yarn.lock` | 锁定 TypeScript 5.9.3 |

## 4. 从克隆基线到统计截止提交的最终净变化

这里统计的是 `a95b903..f080be19b48234ea8a520a7fecbc75ee524b393a` 的最终文件差异，不重复计算分支合并。

| 文件 | 增加 | 删除 | 主要变化 |
| --- | ---: | ---: | --- |
| `.gitignore` | 4 | 0 | 忽略本地缓存并允许提交内置样例视频 |
| `.nvmrc` | 1 | 0 | 固定使用 Node.js 22 |
| `docs/DEVELOPMENT_HISTORY_SINCE_2026_07_30.md` | 458 | 0 | 开发历史、统计口径和后续优化方向 |
| `main/main.js` | 18 | 2 | Electron 缓存目录 IPC |
| `package-lock.json` | 0 | 11,748 | 删除重复的 npm 锁文件 |
| `package.json` | 7 | 1 | 测试命令、Node/Yarn 版本和 TypeScript 依赖 |
| `public/samples/ATTRIBUTION.md` | 6 | 4 | 内置样例来源与授权说明 |
| `public/samples/sample.mp4` | — | — | 内置本地转写测试视频（二进制文件） |
| `scripts/setup-whisper.sh` | 3 | 2 | 统一依赖安装提示为 Yarn |
| `src/app/api/transcribe/route.js` | 135 | 4 | 转写诊断、分段流式接口、恢复参数 |
| `src/app/api/translate/cache/route.js` | 27 | 0 | 持久化缓存管理 API |
| `src/app/api/translate/route.js` | 294 | 29 | 翻译重试、批处理、自适应限流和缓存 |
| `src/app/globals.css` | 734 | 11 | 播放器、媒体库、弹窗、渐进处理和缓存设置 UI |
| `src/app/page.js` | 2,255 | 220 | 转写翻译主流程、媒体库、渐进播放器和缓存管理 |
| `src/lib/adaptive-request-pool.js` | 137 | 0 | 自适应并发池 |
| `src/lib/asr-engines.js` | 119 | 12 | 转写流解析和诊断传递 |
| `src/lib/local-transcription.js` | 828 | 34 | Whisper 可靠性、Smart Auto、空洞恢复和分段识别 |
| `src/lib/media-identity.js` | 48 | 0 | 媒体身份键与重复导入识别 |
| `src/lib/progressive-buffer.js` | 213 | 0 | 渐进缓冲和翻译拆批算法 |
| `src/lib/translation-batch.js` | 86 | 0 | 批次封装与对齐解析 |
| `src/lib/translation-cache.js` | 145 | 0 | 会话和磁盘翻译缓存 |
| `src/lib/usage-tracker.js` | 1 | 1 | 用量超限错误文案统一 |
| `src/lib/whisper-language-detection.js` | 94 | 0 | Whisper 语言 token 检测 |
| `test/adaptive-request-pool.test.js` | 41 | 0 | 自适应并发测试 |
| `test/media-identity.test.js` | 48 | 0 | 媒体身份与重复导入测试 |
| `test/progressive-buffer.test.js` | 171 | 0 | 渐进缓冲测试 |
| `test/sample-media.test.js` | 12 | 0 | 内置样例文件存在性测试 |
| `test/translation-batch.test.js` | 46 | 0 | 翻译批次测试 |
| `test/translation-cache.test.js` | 43 | 0 | 持久化缓存测试 |
| `test/whisper-language-detection.test.js` | 51 | 0 | 语言检测测试 |
| `yarn.lock` | 470 | 239 | 依赖解析、平台可选包和 TypeScript 锁定版本 |
| **合计** | **6,495** | **12,307** | **31 个文件** |

## 5. 文档与统计口径说明

- 本文档只记录自 2026-07-30 起的提交历史、逐 commit 改动和最终净变化。
- `README.md` 和 `LINGOLOOP_PLAN.md` 保持当前 Git 提交中的原始版本。
- 功能提交的“增加/删除行数”来自该 commit 相对其父提交的 Git 统计。
- 合并提交没有额外冲突解决代码，因此只说明整合作用，不重复计算被合并功能的行数。
- “最终净变化”来自克隆基线到统计截止提交的直接 diff，因此会小于各功能提交历史增删行数的简单相加；被后续重写或删除的内容不会出现在最终净变化里。
- 删除 `package-lock.json` 产生的 11,748 个删除行属于锁文件清理，不代表删除了同等规模的业务代码。
- Git 不记录未提交改动的完整创建历史；只有进入 commit 后，才能作为可核验的历史节点记录。
