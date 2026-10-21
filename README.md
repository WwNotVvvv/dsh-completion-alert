# 任务完成提醒（dsh-completion-alert）

[![CI](https://github.com/WwNotVvvv/dsh-completion-alert/actions/workflows/ci.yml/badge.svg)](https://github.com/WwNotVvvv/dsh-completion-alert/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

一个 DSH 插件：**对话任务结束时提醒你**——播放可自定义的提示音，并弹出系统级通知。

关键在于它**能说出具体原因**。普通提醒只会告诉你"出错了"，而你往往要切回会话才知道错在哪；这个插件把会话里显示的那条错误信息取出来，念给你听。

---

## 功能

- **三种状态，视觉可区分**：`✅ 已完成` / `⚠️ 异常中断` / `❓ 等待回答`，各有独立开关、独立文案、独立音频。
- **声音三选一**：
  - 内置提示音（无需任何配置，开箱可用）
  - 文字转语音（TTS），可自定义每种状态读什么
  - 自定义音频片段，可按角色分组、按状态分别指定
- **屏幕级通知**：走系统通知，窗口最小化、你在别的应用里时也能看到。**不是**页面内的浮层——页面内浮层在你最小化窗口时恰好看不见，而这正是最需要提醒的场景。
- **任务栏角标**：显示"有几个对话完成但你还没看"。只有该对话在屏幕上**且**窗口聚焦时才消一个。
- **异常原因朗读**：10 类常见错误各有可自定义的提示语，见下表。
- **中英双语**：界面文字与朗读语言都跟随 DSH 的界面语言。

## 安装

DSH 里用插件管理器安装（`install_bundle`），三种地址形式任选：

| 方式 | 填什么 |
|---|---|
| 本地目录 | 插件目录的**绝对路径**，或 `file:` / `link:` 前缀 |
| Git 仓库 | `github:WwNotVvvv/dsh-completion-alert`（本仓库） |
| npm 包 | 包名，或 `包名@版本` |
| 压缩包 | 绝对 `.tgz` 路径，或 `https://…tgz` |

安装后需要**刷新页面**才会加载浏览器端代码。

## 权限

系统通知需要你手动授权（浏览器安全限制，无法自动弹）。若提示音没有响，通常是浏览器要求先有一次用户交互——在设置页点一下任意按钮即可"解锁"音频。

## 设置

「设置 → 任务提醒」下：

- **总开关**：一键静音全部提醒（角标也会停）
- **状态开关**：分别控制完成 / 异常 / 等待
- **声音**：模式、音量、TTS 文字、语速、音色、角色分组音频
- **异常原因朗读**：10 类错误逐条自定义 + 每类独立试听
- **通知**：系统通知、任务栏角标

> 朗读文字、朗读语言留空即"跟随界面语言"。你的既有配置不会被改动。

## 错误分类

插件把失败归到 10 类，先按稳定的错误码精确匹配，认不出错误码时再匹配错误文字（中转站常返回裸 HTTP 状态、HTML 错误页或自述措辞，中英都覆盖）。

| 类型 | 典型错误码 | 默认提示语 |
|---|---|---|
| 认证失败 | `AUTH` `MISSING_CREDENTIAL` `ACCOUNT_SIGN_IN_REQUIRED` | 接口密钥无效或未授权 |
| 额度不足 | `QUOTA` `ACCOUNT_QUOTA` | 账户额度已用尽 |
| 请求过快 | `RATE_LIMIT` | 请求过于频繁，已被限流 |
| 服务端错误 | `SERVER`（5xx、overload） | 服务端返回错误，可能是上游故障 |
| 连接中断 | `STREAM_CLOSED` `TRANSPORT` `TIMEOUT` | 连接中断或超时 |
| 地址或模型错误 | `UNKNOWN_MODEL` `NO_ADAPTER` | 接口地址或模型名不正确 |
| 返回异常 | `MALFORMED_RESPONSE` `EMPTY_RESPONSE` | 返回内容异常，无法解析 |
| 上下文超限 | `CONTEXT_WINDOW_EXCEEDED` | 对话内容超出模型上下文长度 |
| 请求被拒 | `INVALID_REQUEST` `IMAGE_OFFLOAD_REQUIRED` | 请求参数被拒绝 |
| 其他错误 | 以上都认不出 | 错误原因未识别 |

另有独立开关「同时朗读原始错误信息」（默认关），关掉时只念上表的提示语，原始技术措辞仍**完整显示在通知里**。

### 原因从哪来

取自会话自己的 `turn/end` 记录——**和你在会话里看到的是同一句话**。转发的事件只用来判定"是否失败"，措辞优先用日志里的原文。

## 兼容性

- 在 **DSH 0.2.0-rc.2** 上开发与验证。
- `package.json` 声明 `peerDependencies` 为 `">=0.2.0-rc.2 <0.3.0"`；DSH 会在安装/激活时校验，不匹配会提示并给出豁免入口，而不是静默失效。
- 使用了少量 DSH 内部接口（会话事件源、`api-session/status|error` 转发事件、三个 slot）。这些接口若在未来版本变更，最坏情况是提醒不触发；读取日志那段有兜底，不会抛错。

## 数据存放

全部在本地，**插件不发起任何网络请求**。

- 设置：`localStorage` 键 `dsh.completion-alert.v1`
- 音频片段：`IndexedDB` 库 `dsh-completion-alert`

## 卸载

用插件管理器 `remove_bundle`，目标 `@local/dsh-completion-alert`。
残留的 `localStorage` 键与 IndexedDB 库不影响其他功能，可手动清除。

## 开发

```bash
npm test          # 静态审计 + 行为测试（无需 npm install）
```

测试基于 Node 内置 `vm` 模拟浏览器与 Cordis 上下文，**零依赖**、不需要真实浏览器。
CI 在 Node 20 / 22 上跑同一套测试，见 `.github/workflows/ci.yml`。

### 仓库结构

**仓库根目录就是包根目录**——`package.json` 必须在根上，否则 `github:用户名/仓库名`
这种安装方式找不到包（pnpm 会克隆仓库并把根当成包）。所以应当在本目录内
`git init`，而不是在它的上一层。

```
client.js          浏览器端全部逻辑（检测、声音、通知、角标、设置页）
index.js           Host 端，故意为空：本插件不需要 Host 服务
cordis.patch.yml   Loader 补丁，插入一个插件条目
icon.svg           Plugin Manager 卡片图标
locale/            插件列表显示用的标题与描述（DSH 读 en.json 的 meta.*）
tests/             静态审计 + 行为测试
```

### 仓库

<https://github.com/WwNotVvvv/dsh-completion-alert>

`package.json` 的 `repository` / `homepage` / `bugs` 已指向该仓库，所以插件管理器里
直接填 `github:WwNotVvvv/dsh-completion-alert` 即可安装。

锁版本：加 `#v1.0.0`（见 [Releases](https://github.com/WwNotVvvv/dsh-completion-alert/releases)）。
版本历史见 [CHANGELOG.md](./CHANGELOG.md)，发版流程见 [docs/RELEASING.md](./docs/RELEASING.md)。

## 许可证

MIT，见 [LICENSE](./LICENSE)。

---

## English summary

A DSH plugin that alerts you when a conversation finishes, fails, or waits for your
answer: a customizable sound plus a **screen-level** notification (not an in-page card,
which would be invisible exactly when the window is minimised).

It reports **what went wrong**, not just that something did: the failure reason is read
from the session's own `turn/end` record — the same text the conversation shows — then
classified into 10 families, each with its own editable spoken phrase. Reliable codes are
matched exactly; when a relay station returns only a bare HTTP status or its own prose,
the message text is matched instead, in both Chinese and English.

Spoken text and language follow the interface language when left empty. Requires DSH
`>=0.2.0-rc.2 <0.3.0`. Local storage only; the plugin makes no network requests.
