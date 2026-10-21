# 发版流程

本文件说明如何把一个新版本发出去，以及 GitHub Release 的正文该写什么。

## 概念：三件事不是一回事

| 动作 | 命令/入口 | 作用 |
|---|---|---|
| **打 tag** | `git tag` + `git push origin <tag>` | 固定一个可引用的提交，别人能锁版本 |
| **创建 Release** | GitHub 网页（或 API） | 生成带说明的版本页面，附件下载 |
| **发布 npm** | `npm publish` | **本项目不做**，见文末 |

关键点：

- **tag 用 git 就能推，Release 不能。** GitHub Release 是平台对象，只能通过网页或 API 创建；API 需要 token。
- **Release 必须挂在一个已存在的 tag 上**，所以顺序是：先推 tag，再建 Release。
- 只推 tag 不建 Release 完全可用（`#v1.0.0` 就能锁版本），Release 只是给人看的说明页。

## 发一个新版本的步骤

### 1. 确认当前提交是绿的

```bash
npm test                                    # 247 项应全过
git status --short                          # 应为空
```

再看 GitHub Actions：<https://github.com/WwNotVvvv/dsh-completion-alert/actions>
最新一次 `main` 的运行必须是绿勾。**不要给红的提交打 tag。**

### 2. 改版本号

`package.json` 的 `version` 与 `CHANGELOG.md` 的条目要一致：

```json
"version": "1.0.1"
```

`CHANGELOG.md` 顶部加一节：

```markdown
## [1.0.1] - 2026-11-02

### 修复
- ……
```

### 3. 提交并推送

```bash
git add -A
git commit -m "Release v1.0.1"
git push
```

### 4. 打 tag（annotated，带说明）

```bash
git tag -a v1.0.1 -m "v1.0.1"
git push origin v1.0.1
```

校验：

```bash
git ls-remote --tags origin        # 应看到 refs/tags/v1.0.1
git tag -n5                        # 本地 tag 及其说明
```

> tag 名一律 `v` 前缀、与 `package.json` 的 `version` 对应（`1.0.1` → `v1.0.1`）。
> 用 annotated（`-a`）而不是轻量 tag，这样带日期、作者和说明。

### 5. 创建 GitHub Release（网页，约 1 分钟）

1. 打开 <https://github.com/WwNotVvvv/dsh-completion-alert/releases/new>
2. **Choose a tag** → 选刚推的 `v1.0.1`
   （选不到就先点 "Create new tag" 再推一次，或刷新页面）
3. **Target** 保持 `main`
4. **Release title** 填 `v1.0.1`
5. **Describe this release** 粘贴下节模板
6. 勾选 **Set as the latest release**（首次发布同样适用）
7. 点 **Publish release**

### 6. 验证

- `https://github.com/WwNotVvvv/dsh-completion-alert/releases` 能看到该版本
- 仓库首页右侧 **Releases** 显示最新版本号
- 锁版本安装可用：`github:WwNotVvvv/dsh-completion-alert#v1.0.1`

## Release 正文模板

复制下面整段，把版本号与变更条目换成当次的：

```markdown
## 任务完成提醒 v1.0.1

DSH 插件：对话任务结束、失败或等待你回答时，播放可自定义的提示音并弹出系统级通知。
与普通提醒不同的是，**失败时会念出具体原因**。

### 安装

在插件管理器里填：

    github:WwNotVvvv/dsh-completion-alert#v1.0.1

不带 `#v1.0.1` 则跟随 `main` 的最新提交。安装后需要**刷新页面**。

### 本版变更

- 修复：……
- 新增：……

### 环境要求

- DSH `>=0.2.0-rc.2 <0.3.0`（版本不匹配会明确提示，而非静默失效）
- Node 20 / 22（CI 覆盖）

### 已知限制

- 通知权限需手动授予（浏览器安全限制）
- 从未打开、也未保留的会话取不到完整原因，会退回错误码或会话名
- 错误分类基于启发式规则；上游若返回完全自定义的措辞，会归入「其他错误」

### 隐私

插件不发起任何网络请求；状态只存在本地（localStorage + IndexedDB）。
```

## v1.0.0 的 Release 正文（可直接粘贴）

```markdown
## 任务完成提醒 v1.0.0

DSH 插件：对话任务结束、失败或等待你回答时，播放可自定义的提示音并弹出系统级通知。
与普通提醒不同的是，**失败时会念出具体原因**——你不需要切回会话才能知道错在哪。

### 安装

    github:WwNotVvvv/dsh-completion-alert#v1.0.0

安装后**刷新页面**即可生效。

### 亮点

- 三种状态可区分：`✅ 已完成` / `⚠️ 异常中断` / `❓ 等待回答`
- **屏幕级通知**：窗口最小化、你在别的应用里也能看到（页面内浮层做不到这点）
- **任务栏角标**：显示"几个对话完成但还没看"，只有该对话在屏幕上且窗口聚焦时才消
- **声音三选一**：内置提示音 / 语音朗读 / 自定义音频（可按角色分组、按状态指定）
- **10 类常见错误分类**：认证、额度、限流、服务端、连接、地址或模型、返回异常、上下文超限、请求被拒、其他；每类可自定义朗读文字并独立试听
- **原因与会话一致**：取自会话自身的 `turn/end` 记录，就是你在会话里看到的那句话
- **中英双语**：界面与朗读语言跟随界面语言，留空即自动

### 环境要求

- DSH `>=0.2.0-rc.2 <0.3.0`（版本不匹配会明确提示并给出豁免入口，而非静默失效）
- Node 20 / 22（CI 覆盖）

### 已知限制

- 通知权限需手动授予（浏览器安全限制，无法自动弹）
- 从未打开、也未保留的会话取不到完整原因，会退回错误码或会话名
- 错误分类基于启发式规则；上游（尤其中转站）若返回完全自定义的措辞，会归入「其他错误」，此时原始信息仍完整显示在通知里

### 隐私

插件不发起任何网络请求；设置存在 `localStorage`，音频片段存在 `IndexedDB`，全部在本地。
```

## 为什么不上架 npm

`package.json` 里 `private: true` 与 `@local/` 作用域是 DSH bundle 的**官方本地约定**，两者都会挡住 `npm publish`。

若将来要上架 npm，需要同步改 **4 处**，漏一处会导致插件完全不生效：

1. `package.json` 的 `name` → 你自己的 npm 作用域
2. `package.json` 去掉 `"private": true`
3. `cordis.patch.yml` 的 `name`
4. **`client.js` 第 2 行的 `id`** —— 官方要求"浏览器模块的工厂 id 必须等于包名"，测试里有一条 `factory id matches the package name` 专门守它

改完后 `npm publish`，安装方式变为填包名（可带 `@版本`）。
