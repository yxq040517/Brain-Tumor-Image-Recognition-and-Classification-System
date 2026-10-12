# 脑瘤影像识别分类系统（NeuroLens）

基于 Next.js、FastAPI 和 PyTorch 的本地脑部 MRI 影像四分类研究工作台。系统使用固定版本的开源视觉分类模型，支持影像导入、分类推理、可解释性热力图、本地影像库、模型管理和报告导出。

> **仅用于科研与教学，不可用于临床诊断或医疗决策。** 输入为单张二维脑部 MRI 切片，不支持三维体数据或肿瘤分割。界面中的分类分数是未经校准的模型分数，不是患病概率；热力图也不是病灶轮廓。

## 主要功能

| 模块 | 功能 |
| --- | --- |
| 影像分析 | 拖放导入、单张或批量分析、任务进度、四分类结果及各类别分数 |
| 交互阅片 | 缩放、平移、旋转、亮度与对比度调整、矩形标注 |
| 可解释性 | 内置 ViT 模型的 Grad-CAM 热力图；自定义模型按兼容性提供解释能力 |
| 影像库 | 本地保存记录、筛选与排序、分组、备注、人工复核、影像对比及批量操作 |
| 数据概览 | 7 天或 30 天统计与类别分布 |
| 模型管理 | 导入兼容的本地模型、切换当前模型、删除不再使用的上传模型 |
| 报告导出 | 单条或批量 PDF 报告、Excel 表格 |

支持的分类标签：

| 模型标签 | 界面名称 |
| --- | --- |
| `Glioma` | 胶质瘤类 |
| `Meningioma` | 脑膜瘤类 |
| `No Tumor` | 无肿瘤类 |
| `Pituitary` | 垂体瘤类 |

## 技术栈与环境要求

- **前端**：Next.js 16、React 19、TypeScript，使用 npm 管理依赖。
- **后端**：FastAPI、PyTorch、Transformers、SQLAlchemy、SQLite，使用 uv 管理依赖。
- **运行环境**：Node.js **22 或更新版本**；uv；Python **3.12 或 3.13**。一键启动脚本使用 Python 3.12，uv 可在需要时下载该版本。
- **硬件**：默认使用 CPU，不要求独立显卡。首次安装需要下载依赖及约 **327 MiB** 的模型权重，请预留磁盘空间。
- **网络**：首次安装、模型下载需要联网；依赖和模型准备完成后，推理在本机执行，不依赖外部推理 API。

安装工具：

- [Node.js 下载](https://nodejs.org/)
- [uv 安装说明](https://docs.astral.sh/uv/getting-started/installation/)

仓库通过 `package-lock.json` 和 `backend/uv.lock` 固定依赖。前端默认 npm 源配置见 `.npmrc`。

## 快速开始

### 1. 获取项目

```sh
git clone https://github.com/yxq040517/Brain-Tumor-Image-Recognition-and-Classification-System.git neurolens
cd neurolens
```

以下命令均从项目根目录执行，除非另有说明。

### 2. Windows 一键启动（推荐）

安装好 Node.js 和 uv 后，双击根目录的 **`启动系统.cmd`**，或在终端执行：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

脚本会依次：

1. 检查本机 `3000` 和 `8010` 端口，若被占用则退出，不终止已有服务。
2. 按锁文件检查、安装前端依赖。
3. 使用 uv 准备隔离的 Python 3.12 环境及后端依赖。
4. 下载或校验固定版本模型的配置与权重。
5. 启动前后端服务。

首次启动需要等待依赖安装及模型准备。保持启动窗口开启，按 **Ctrl+C** 停止前后端。

### 3. 手动安装与开发启动

```sh
npm ci
uv sync --frozen --project backend --python 3.12
uv run --project backend --no-sync python scripts/prepare_model.py
npm run dev
```

`npm run dev` 会一起启动前端与后端，但**不会安装依赖或下载模型**。依赖与模型已准备好时，后续可直接运行该命令。

### 4. 访问地址

| 地址 | 用途 |
| --- | --- |
| <http://127.0.0.1:3000> | Web 工作台 |
| <http://127.0.0.1:3000/api/health> | 经前端代理访问后端的健康状态 |
| <http://127.0.0.1:8010/api/health> | 直接访问后端健康状态 |

启动后先等待页面顶部的模型状态就绪；服务已启动不代表模型已经完成加载。健康接口中的 `model.state` 为 `ready` 时才可进行推理。

### 5. 本地生产模式

依赖与模型准备完成后：

```sh
npm run build
npm start
```

`npm start` 使用前端生产构建，并同时启动后端；未执行构建时会报错。开发和生产启动器均固定监听本机 `3000`、`8010` 端口。

## 使用流程

1. 打开 **影像分析**，拖入或选择符合要求的二维 MRI 图片。可使用 `public/samples/` 中的四张公开演示图片。
2. 按需填写批次分组，点击 **开始分析** 或 **开始批量**。
3. 查看分类结果和各类别分数，使用阅片工具调整显示或添加标注；按需生成热力图。
4. 在 **影像库** 中查找记录、添加备注、管理分组、进行人工复核或影像对比。
5. 从分析任务列表或影像库导出 PDF、Excel；在 **数据概览** 中查看统计。
6. 如需更换模型，点击页面顶部的模型状态入口，导入兼容模型并切换。

### 影像输入限制

| 项目 | 限制 |
| --- | --- |
| 文件格式 | PNG、JPEG（`.jpg` / `.jpeg`）、WebP |
| 单文件大小 | 不超过 **10 MiB** |
| 最小尺寸 | 宽、高均至少 **32 像素** |
| 最大像素数 | 不超过 **16,000,000** 像素 |
| 帧数 | 单帧；不接受动画或多帧影像 |

系统会检查图片实际格式，不仅依赖扩展名。DICOM、NIfTI、三维体数据不在支持范围内；模型也不适用于 CT 或通用图片分类任务。

批量报告导出上限：PDF 每次最多 **200** 条记录，Excel 每次最多 **10,000** 条记录。

## 后端接口概览

工作台通过 Next.js 将 `/api/*` 转发到本机后端。当前项目关闭了 Swagger、ReDoc 和 OpenAPI 自动文档，`/docs`、`/redoc`、`/openapi.json` 不可用；完整请求与响应定义见 [backend/app/main.py](backend/app/main.py) 和 [backend/app/schemas.py](backend/app/schemas.py)。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务状态与模型加载状态 |
| `GET` | `/api/model` | 当前模型信息 |
| `GET` | `/api/models` | 可用模型列表 |
| `POST` | `/api/models/upload` | 导入模型；multipart 字段为 `files`、`name` 和可选的 `labels_json` |
| `POST` | `/api/models/{profile_id}/activate` | 激活模型 |
| `DELETE` | `/api/models/{profile_id}` | 删除上传的模型 |
| `POST` | `/api/analyses` | 上传并分析；multipart 字段为 `file` 和可选的 `group` |
| `GET` | `/api/analyses` | 分页、筛选查询分析记录 |
| `GET` / `PATCH` / `DELETE` | `/api/analyses/{identifier}` | 读取、编辑或删除单条记录 |
| `GET` | `/api/analyses/{identifier}/image` | 获取保存的影像 |
| `POST` / `GET` | `/api/analyses/{identifier}/heatmap` | 生成热力图 / 获取热力图图片 |
| `POST` | `/api/analyses/bulk` | 批量管理记录 |
| `POST` | `/api/exports/pdf`、`/api/exports/excel` | 批量导出报告 |
| `GET` | `/api/stats` | 统计数据，`days` 仅支持 `7` 或 `30` |
| `GET` | `/api/groups` | 分组列表与记录数量 |

在 PowerShell 中查看健康状态：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

## 模型说明

### 内置模型

- **来源**：[Hemgg/brain-tumor-classification](https://huggingface.co/Hemgg/brain-tumor-classification)
- **架构**：ViT-Base / `ViTForImageClassification`
- **固定版本**：`2413c5fef4b2184b22493198a46a8e622a16c104`
- **输入尺寸**：224 × 224，具体预处理配置见模型清单。
- **权重格式**：`model.safetensors`
- **默认保存目录**：`backend/models/brain-tumor-classifier/`
- **完整元数据及 SHA-256**：[backend/model-manifest.json](backend/model-manifest.json)

准备脚本校验配置与权重的 SHA-256，后端加载时也校验固定模型。缺失、损坏或不匹配的模型不能用于推理，不会用随机结果替代。

仓库**不包含模型权重**，启动脚本会下载所需文件。默认下载端点为 `https://hf-mirror.com`；需要改用 Hugging Face 官方端点时，执行：

```sh
uv run --project backend --no-sync python scripts/prepare_model.py --endpoint https://huggingface.co
```

也可以通过进程环境变量 `NEUROLENS_MODEL_ENDPOINT` 改变准备脚本的下载端点。该变量用于下载脚本，不是后端 `.env` 的模型运行配置。

模型作者报告的指标及公共样本演示结果均不等于独立临床验证。相关记录见 [public/model-quality.json](public/model-quality.json)，不能据此推断真实患者数据上的可靠性。

### 导入自定义模型

在页面顶部的模型管理入口上传 ZIP 或模型目录文件，至少包含：

```text
my-model/
├── config.json
├── preprocessor_config.json
└── model.safetensors
```

- 必须是 Transformers 支持的标准视觉分类模型，具有四分类输出头。
- 类别映射必须按模型实际输出顺序包含 `No Tumor`、`Glioma`、`Meningioma`、`Pituitary`，各一次；无法从 `LABEL_0` 等名称自动推断时，需要在导入界面明确映射。
- 模型文件总量不超过 **512 MiB**，最多 **64** 个文件，不接受链接或嵌套的模型目录。
- 不支持分片权重、`.pt`、`.pth`、`.bin`、`.onnx` 或自定义 Python 模型代码。
- 加载不启用远程自定义代码。热力图能力取决于模型与预处理的兼容性，界面会标明支持情况。

格式兼容不代表模型训练质量合格。请自行核实训练数据来源、输出标签、许可证及适用范围。

## 配置与本地数据

默认配置即可启动，无需创建 `.env`。需要覆盖默认值时，在 PowerShell 中执行：

```powershell
Copy-Item backend/.env.example backend/.env
```

编辑 `backend/.env`，然后重启服务：

| 配置项 | 默认值 / 说明 |
| --- | --- |
| `NEUROLENS_DATA_DIR` | `data`；分析记录、图片、热力图及上传模型的保存位置 |
| `NEUROLENS_MODEL_DIR` | `models/brain-tumor-classifier`；固定内置模型所在目录 |
| `NEUROLENS_DEVICE` | `cpu`；可设置 `cuda`，但需可用的 CUDA 设备及对应 PyTorch 环境 |
| `NEUROLENS_TORCH_THREADS` | 默认取 CPU 逻辑核数与 4 的较小值，允许范围为 1–16 |

相对路径以 **`backend/` 目录**为基准，不随终端当前目录变化。`NEUROLENS_MODEL_DIR` 只改变内置模型位置，不用于绕过固定模型校验；改用其他目录时，应使用准备脚本的 `--directory` 参数显式准备模型。一键启动脚本仍准备默认目录。

默认数据位置：

```text
backend/data/
├── analyses.sqlite3   # 分析记录数据库
├── images/            # 本地保存的影像
├── heatmaps/          # 生成的热力图
└── model-library/     # 上传模型与模型选择状态
```

备份时先停止服务，再备份整个数据目录；如果修改了 `NEUROLENS_DATA_DIR`，请备份对应位置。不要只复制数据库而遗漏影像和模型文件。

`.gitignore` 排除了模型权重、运行数据、真实 `.env`、依赖目录和构建产物。克隆仓库不会获得其他人的分析记录，也不会自动包含权重。

## 项目结构

```text
.
├── app/                      # Next.js 页面、布局和样式
├── components/               # 分析、阅片、影像库、模型管理等界面
├── lib/                      # API 客户端与前端类型
├── backend/
│   ├── app/                  # FastAPI、模型推理、存储与报告生成
│   ├── tests/                # 图片校验和记录管理回归测试
│   ├── models/               # 本地模型，下载生成，不提交
│   ├── data/                 # 本地运行数据，不提交
│   ├── .env.example          # 环境配置示例
│   ├── model-manifest.json   # 固定模型版本、校验值与限制
│   ├── model-license.txt     # 内置模型许可证
│   ├── pyproject.toml
│   └── uv.lock
├── public/
│   ├── samples/              # 公开演示图片与来源信息
│   └── model-quality.json    # 模型指标与公共样本记录
├── scripts/
│   ├── dev.mjs               # 前后端联合启动与端口检查
│   └── prepare_model.py      # 固定模型下载与完整性校验
├── start.ps1                 # Windows 环境准备及启动脚本
├── 启动系统.cmd              # Windows 双击启动入口
└── THIRD_PARTY_NOTICES.txt    # 第三方模型与样本说明
```

## 开发检查

安装依赖后，从项目根目录执行：

```sh
npm run check
npm run typecheck
npm run build
uv run --directory backend --no-sync python -m ruff check app tests ../scripts/prepare_model.py
uv run --directory backend --no-sync python -m pytest -q
```

检查端口而不启动服务：

```sh
node scripts/dev.mjs --check
```

该命令只检查端口，不检查依赖、模型完整性或推理能力。

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| 找不到 `node`、`npm` 或 `uv` | 安装对应工具，重新打开终端后再启动 |
| `3000` / `8010` 端口被占用 | 如果本系统已运行，直接打开工作台；否则关闭占用端口的服务后重试。启动器不会强行结束其他进程 |
| 提示依赖缺失 | Windows 运行一键启动脚本，或按手动安装步骤准备前后端依赖 |
| 模型下载失败 | 检查网络与剩余磁盘空间，必要时使用 `--endpoint` 切换下载端点，再重新运行准备脚本 |
| 模型缺失、校验失败或一直未就绪 | 查看启动窗口的后端错误，重新准备模型；不要通过改名或修改校验值绕过验证 |
| 上传图片失败 | 检查实际图片格式、10 MiB 大小限制、像素尺寸和是否为单帧 |
| 导出数量超限 | 缩小筛选范围或分批导出 |
| 生产启动提示缺少构建 | 先运行 `npm run build`，再运行 `npm start` |

## 安全、隐私与许可证

- 服务默认只监听 `127.0.0.1`，面向本机使用；当前项目没有用户登录和权限管理，不应直接暴露到公网。
- 如需网络部署，应先补充身份认证、访问控制、HTTPS 与医疗数据合规措施，不能仅修改监听地址。
- 图片、备注、标注及导出报告可能包含敏感信息，请使用获得授权并适当脱敏的数据。本地存储不等于符合医疗数据合规要求。
- 内置模型由发布者声明采用 **Apache-2.0**，许可证见 [backend/model-license.txt](backend/model-license.txt)。
- 公开演示图片来自 Masoud Nickparvar 的 Brain Tumor MRI Dataset，声明采用 **CC BY 4.0**。具体来源、镜像版本和原始文件名见 [public/samples/attribution.json](public/samples/attribution.json)。
- 完整第三方说明见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。上述许可证分别适用于相应第三方资源，仓库当前未为项目业务代码单独声明开源许可证。