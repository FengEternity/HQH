# Agent 须知

- 功能开发：从 **`dev` 迁出 `dev-<功能>` 短分支**（例如 `dev-ai-search`、`dev-tabbar-shell`），做完合回 `dev`。不要在 `dev` 上同时堆多个未验收大功能，不要在 `main` 上开发。
- **`main` 仅用于发布与验证**（体验版/正式版上传）。`dev` 是集成与联调。
- 完整约定见 `docs/branching.md`。
- 不要把 AppSecret、云密钥、`ADMIN_PIN`、支付密钥写入仓库。
- 对外 git 说明用简体中文；不要在 commit 或源码注释里写 `DES-*`、`ANAL-*` 这类本地文档编号。
