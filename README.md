# dsh-agents-md-only

让 DSH 只读 `AGENTS.md` 和 `AGENTS.local.md` 作为工作区指令，不再读 `CLAUDE.md`、`CLAUDE.local.md`。

DSH 默认四个都读。Web / 桌面版的内置预设各自带一份指令加载器，profile 配置改不到它们。

## 安装

```sh
dsh plugin --profile desktop add github:RicardoYan/dsh-agents-md-only#v0.1.2
```

Web 端把 `desktop` 换成你的 profile 名（一般是 `web`）。装完重启 DSH。

卸载：`dsh plugin --profile desktop remove dsh-agents-md-only`

## 说明

- 对所有预设和会话（含子代理）生效，不需要配置
- 文件名不区分大小写；`~/.dsh/AGENTS.md` 照常读取
- 装上或卸下后，已有会话继续时会收到一份更新后的完整指令（只一次）
- 依赖 DSH 内部接口（`dsh-agent-instructions` 的配置字段），适用于 `@deepseek-ai/dsh` `>=0.2.1-rc.1 <0.3.0-0`

## 许可证

MIT
