# Utils 模块说明

`src/utils/` 是无业务语义的基础工具函数。只放真正跨模块复用、无副作用的纯工具。

## 关键文件

- `fs.ts`: `readJson`、`writeJsonAtomic`、`writeTextAtomic`、`ensureDir`、`expandPath`。
- `id.ts`: ID 生成辅助。

## 修改注意

- 不要在这里堆业务逻辑；有领域语义的函数放对应模块。
- 保持纯函数，便于测试。
