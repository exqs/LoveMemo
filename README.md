# LoveMemo

<div align="center">

[![GitHub Stars](https://img.shields.io/github/stars/exqs/LoveMemo?style=social)](https://github.com/exqs/LoveMemo/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**把每次争吵变成成长的台阶**

用 AI 把关系中的矛盾复盘成知识点，按记忆曲线复习和练习，确保每次教训都能真正记住。

[功能特性](#功能特性) • [快速开始](#快速开始) • [技术栈](#技术栈) • [部署指南](#部署指南) • [贡献指南](CONTRIBUTING.md)

</div>

---

## 这是什么

在亲密关系中，我们常常重复同样的错误——不先说想法、追问反问、说到做不到。每次吵完架都说"下次不会了"，但下次还是会犯。

LoveMemo 把每次矛盾记录下来，用 AI 分析你哪句话说错了、对方的原话是什么、下次该怎么说，然后按记忆曲线定期推送复习和练习，确保你真的能记住。

就像错题本一样，把关系中的"错题"整理成知识库，反复练习直到掌握。

---

## 功能特性

### 📝 智能识别
粘贴聊天记录，AI 自动识别对话、时间、表情、回复关系

### 🧠 AI 复盘
分析这次问题出在哪、对方说过的原话、你的漏接、下次该怎么做

### 📚 知识库
把每次的问题归纳成可复习的知识点卡片，记录出现次数和掌握度

### 🔄 记忆曲线
基于 FSRS 5.0 算法，按遗忘曲线推送复习：回忆卡、选择题、改写题、找茬题、模拟对话

### ✅ 承诺跟踪
记录你答应对方的事情，按时提醒，避免"说到做不到"

### 📊 数据可视化
词云、问题图谱、高频问题排行、趋势分析、复习日历、AI 周报

---

## 快速开始

### 预览界面（无需安装）

项目包含 13 个单文件 HTML 预览页面，可以直接在浏览器打开查看界面（使用示例数据）。

### 本地开发

**前置要求：**
- Node.js 20+
- Rust 工具链（见[部署指南](#部署指南)）

**安装依赖：**
```bash
npm install
# 或使用 pnpm
pnpm install
```

**开发模式：**
```bash
npm run tauri dev
```

**打包应用：**
```bash
npm run tauri build
```

---

## 技术栈

### 前端
- **框架**：React 19 + TypeScript + Vite
- **样式**：Tailwind CSS（错题本主题：方格纸 + 红笔批注）
- **数据库**：sql.js（浏览器内 SQLite）
- **图表**：ECharts 5 + echarts-wordcloud
- **记忆算法**：ts-fsrs v5.4.2（FSRS 5.0）

### 桌面端
- **框架**：Tauri 2
- **语言**：Rust
- **密钥存储**：keyring（系统密钥链）
- **插件**：notification、autostart

### AI 模型
- **识别与复盘**：Claude Opus 5.5（需要 Anthropic API Key）
- **出题与模拟**：DeepSeek V4.1-Flash（需要 DeepSeek API Key）

---

## 部署指南

### Windows

**1. 安装 Rust 工具链**

下载安装器：https://rustup.rs/

或使用 PowerShell：
```powershell
# 下载安装器
Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile rustup-init.exe
# 运行安装
.\rustup-init.exe
```

**2. 安装 Visual Studio Build Tools**

下载：https://visualstudio.microsoft.com/zh-hans/downloads/

在安装器中勾选"使用 C++ 的桌面开发"

**3. 安装项目依赖**
```bash
cd LoveMemo
npm install
# 或
pnpm install
```

**4. 运行开发版**
```bash
npm run tauri dev
```

第一次运行会编译 Rust 代码（约 5-10 分钟），之后启动就很快了。

**5. 打包成安装程序**
```bash
npm run tauri build
```

安装程序在 `src-tauri/target/release/bundle/nsis/` 目录。

### macOS

**1. 安装 Xcode Command Line Tools**
```bash
xcode-select --install
```

**2. 安装 Rust**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**3. 安装项目依赖**
```bash
cd LoveMemo
npm install
```

**4. 运行开发版**
```bash
npm run tauri dev
```

**5. 打包成 .app**
```bash
npm run tauri build
```

应用程序在 `src-tauri/target/release/bundle/macos/`。

### Linux

**1. 安装系统依赖**

Ubuntu/Debian：
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.0-dev \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev
```

Fedora：
```bash
sudo dnf install webkit2gtk4.0-devel \
    openssl-devel \
    curl \
    wget \
    file \
    libappindicator-gtk3-devel \
    librsvg2-devel
sudo dnf group install "C Development Tools and Libraries"
```

**2. 安装 Rust**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**3. 安装项目依赖**
```bash
cd LoveMemo
npm install
```

**4. 运行开发版**
```bash
npm run tauri dev
```

**5. 打包**
```bash
npm run tauri build
```

打包文件在 `src-tauri/target/release/bundle/`（.deb / .AppImage / .rpm）。

---

## 配置 API Key

首次运行后，进入"设置"页面，填入：

- **Claude API Key**：从 https://console.anthropic.com/ 获取
- **DeepSeek API Key**：从 https://platform.deepseek.com/ 获取

API Key 会安全存储在系统密钥链中（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）。

---

## 视觉设计

界面采用"错题本"主题：
- 灰白方格纸背景
- 蓝墨水正文
- 红笔批改（波浪下划线、圈出的分数）
- 荧光笔标重点
- 字体：霞鹜文楷（批注）+ 系统默认（正文）

---

## 数据存储

- **桌面版数据库**：存储在用户数据目录（IndexedDB 持久化）
  - Windows: `%APPDATA%\com.lovememo.app\`
  - macOS: `~/Library/Application Support/com.lovememo.app/`
  - Linux: `~/.local/share/com.lovememo.app/`
- **API Key**：存储在系统密钥链，不会明文保存
- **导出**：设置页面可导出 `.sqlite` 文件

---

## 贡献指南

欢迎提交 Issue 和 Pull Request！详见 [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 许可证

[MIT License](LICENSE)

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=exqs/LoveMemo&type=Date)](https://star-history.com/#exqs/LoveMemo&Date)

---

<div align="center">

**如果这个项目对你有帮助，请给个 Star ⭐️**

Made with ❤️ for better relationships

</div>
