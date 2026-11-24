# 贡献指南

感谢你对 LoveMemo 项目的关注！我们欢迎任何形式的贡献。

## 如何贡献

### 报告 Bug

如果你发现了 Bug，请在 [Issues](https://github.com/exqs/LoveMemo/issues) 页面提交问题，并包含：

- Bug 的详细描述
- 复现步骤
- 预期行为
- 实际行为
- 系统环境（操作系统、Node.js 版本、Rust 版本）
- 截图（如果适用）

### 提交功能建议

如果你有新功能的想法，请在 [Issues](https://github.com/exqs/LoveMemo/issues) 页面提交建议，并说明：

- 功能的详细描述
- 为什么需要这个功能
- 预期的使用场景
- 可能的实现方式（如果有）

### Pull Request 流程

1. Fork 本仓库
2. 创建你的功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交你的修改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

### Pull Request 要求

- 确保代码通过 lint 检查：`npm run lint`
- 确保测试通过：`npm test`
- 更新相关文档（如果需要）
- 在 PR 描述中说明修改的内容和原因

## 开发规范

### 代码风格

- TypeScript：遵循项目的 ESLint 配置
- Rust：遵循 `rustfmt` 和 `clippy` 规范

### 提交信息

提交信息应该清晰描述修改的内容，格式如下：

```
<type>: <subject>

<body>
```

**Type 类型：**
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式调整
- `refactor`: 代码重构
- `test`: 测试相关
- `chore`: 构建工具或辅助工具的变动

**示例：**
```
feat: 添加导出数据功能

在设置页面添加导出按钮，支持导出为 SQLite 文件。
```

## 开发环境设置

1. 安装依赖：
```bash
npm install
```

2. 运行开发服务器：
```bash
npm run tauri dev
```

3. 运行测试：
```bash
npm test
```

4. 运行 lint：
```bash
npm run lint
```

## 项目结构

```
src/
├── ai/           # AI 调用层
├── components/   # React 组件
├── db/           # 数据库操作
├── domain/       # 领域逻辑
├── lib/          # 工具函数
├── pages/        # 页面组件
├── fixtures/     # 测试数据
└── App.tsx       # 应用入口

src-tauri/
├── src/          # Rust 源代码
└── tauri.conf.json  # Tauri 配置
```

## 获取帮助

如果你在贡献过程中遇到问题，可以：

- 查看项目的 [README.md](README.md)
- 在 [Issues](https://github.com/exqs/LoveMemo/issues) 页面提问
- 加入我们的社区讨论

再次感谢你的贡献！
