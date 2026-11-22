# M2 实测记录（本地 embedding + 混合检索）

对应设计文档里程碑 **M2**：`M2-1` embedding 可行性实验、`M2-2` 混合检索与小评测。
环境：DSH `deepseek-official/deepseek-flash`、Electron 44.7 / Node 24.21、Windows。
数据来自本机真实运行，不是估算。

## M2-1 embedding 可行性：通过

| 项目 | 实测值 |
|---|---|
| 依赖 | `@huggingface/transformers@4.3.2` + `onnxruntime-node@1.30.0`（共 42 包，`node_modules` 463.3 MiB） |
| onnxruntime 在 Electron 运行时 | **可加载**（`ELECTRON_RUN_AS_NODE` 下 `InferenceSession` 可用；N-API v6 与 Node ABI 无关） |
| 模型 | `Xenova/multilingual-e5-small`（q8 量化），5 文件 / 129.1 MiB |
| 模型下载 | hf-mirror，164 s，带 sha256 校验、断点续传、幂等重跑 |
| worker 首次加载 | **1.56–1.79 s**（含 transformers 导入 + ONNX session + warm-up） |
| 单条 384 维推理 | 中位 **12.5 ms**（范围 9.8–31.7 ms，首条含 arena 首次触达） |
| 主线程阻塞 | 60 条排队推理期间：50 ms 定时器中位漂移 **3.0 ms**、最大 7.6 ms、事件循环占用 2.3% —— **不阻塞** |
| 归一化 | `|v| = 1.000000`；同文本在 Node 与 Electron 下逐位一致 |
| 语义 sanity | `sim(同义句 A,B)=0.9454 > sim(句A, 午饭句)=0.8355`；同一文本 passage vs query 余弦 0.9748（前缀生效） |

结论：**CPU 推理必须放 worker 的约束可以满足**，插件激活与提示词拼装完全不等模型加载。

## M2-2 检索评测（40 条记忆 / 15 条查询 / 2 个空间）

`node tools/eval-retrieval.mjs`，种子与查询见脚本（中文为主，含精确标识符类查询）。

| 模式 | recall@5 | MRR | 中位延迟 |
|---|---|---|---|
| 仅关键词（FTS5 trigram，短查询 LIKE） | 0.5333 | 0.4056 | 0.37 ms |
| 仅向量（e5 点积） | **1.0000** | **0.9667** | 0.71 ms（不含查询 embedding） |
| 混合 RRF 1:1 | 1.0000 | 0.8889 | 8.43 ms |
| **混合 RRF 2:1（默认）** | **1.0000** | **0.9667** | 8.51 ms |
| 混合 RRF 3:1 | 1.0000 | 0.9667 | 8.13 ms |

三个结论：

1. **向量路是主力**：40 条里中文子串关键词只召回 8/15，向量路 15/15。
2. **朴素的 1:1 RRF 会拖低排序**（MRR 从 0.9667 掉到 0.8889）——关键词路的排序噪声把语义排序稀释了。改成 **2:1（向量权重 2）** 后 MRR 回到 0.9667 且 recall 不变，所以把它设为默认（`DEFAULT_WEIGHTS`）。3:1 没有进一步提升。
3. 混合的收益在于**兜底**：精确标识符/短查询这类语义模型容易抖的查询，靠 FTS5/LIKE 补上；代价是约 8 ms 的四次候选集合并。

规模：1000 条 384 维记忆时，BLOB 读取 6.8 ms + 点积扫描 1.0 ms，整条 `search()` 中位 8.5 ms（向量暴力扫描足够，暂不需要 sqlite-vec）。

## 端到端（真实 Host，真实模型调用）

插件内注册了 `memory_search` 工具（宿主注入 `exec.agent.id` 决定空间归属，**模型不能指定 session/space**），
在真实会话里用一条自然语言查询调用：

```
memory_search("前缀缓存会不会因为改提示词失效") → 3 hit(s) (vector=true, keyword=true)
- [space-default/reflection] DeepSeek 前缀缓存实测很耐用：13.5 小时空闲后首个请求仍命中；改提示词不会重写系统节点 0。 (score 0.0164)
- [space-default/fact] 用户偏好深色主题：界面默认使用暗色配色，避免纯白背景。 (score 0.0161)
- [space-default/fact] 本项目的 GitHub 仓库是 LSwzx/dsh-context-array，默认分支 main，推送走 fastgithub 加速。 (score 0.0159)
```

排序正确、两条路径都可用、符合"记忆文本是数据不是指令"的提示词约束。

## 与设计文档的差异

1. **RRF 默认权重从 1:1 改为 2:1**（依据上表）。文档 §3.3 原写"默认 RRF，可后续调参"，本次即调参结果。
2. **M0-6 折叠没有实现，改为"接管 + 压力告警"**（决策见设计文档 §6/§7）。检索层不依赖折叠。
3. 自动"每轮检索并追加 `<memory>`"**没有接线**：库里目前只有种子记忆、没有 M3 的管理员写入链路，
   自动注入会在每轮塞入低价值内容。M2 交付的是可调用的检索能力 + 工具；自动注入留到 M3/M4 有真实记忆后。
4. 依赖从"零依赖"变为一个运行时依赖（`@huggingface/transformers`）；这是 M2-1 的必然代价，
   替代瘦身方案（`onnxruntime-node` + tokenizers 手写 mean pooling）可省约 158 MB，未实施。

## 复现

```powershell
cd D:\dshprogram\dsh-context-array
npm install
node tools/fetch-model.mjs          # 下载到 %USERPROFILE%\.dsh\context-array\models（幂等）
node tools/seed-memories.mjs        # 往当前库塞 3 条种子记忆（幂等，固定 id）
node tools/eval-retrieval.mjs       # M2-2 评测表
node --test                         # 全仓测试
```
