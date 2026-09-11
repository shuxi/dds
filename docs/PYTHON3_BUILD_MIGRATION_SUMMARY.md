# DDS 项目迁移至 Python 3 编译 — 工作总结

日期：2026-09-10（构建）；2026-09-11（resmoke 测试）  
目标：将基于 MongoDB 4.0.3 的 DDS 工程从 Python 2.7 构建链迁移为可用 Python 3 编译，并完成 `mongod` / `mongos` / `mongo` / `mongobridge` 验证；随后将 **resmoke JS 测试框架** 迁移为可用 Python 3 运行。

---

## 1. 环境与 Python 版本

| 项 | 值 |
|----|-----|
| 操作系统 | Linux（WSL2） |
| 系统 Python 3 | **Python 3.12.3**（`/usr/bin/python3`） |
| 构建使用解释器 | 项目内虚拟环境 `.venv-py3`（基于 3.12.3） |
| C/C++ 编译器 | GCC 14.x（编译时配合 `--disable-warnings-as-errors`） |
| 内置 SCons | **SCons 3.1.2**（新增 vendored 到 `src/third_party/scons-3.1.2/`，替代原 2.5.0） |

说明：原构建入口与文档均要求 Python 2.7；内置 SCons 2.5.0 明确不支持 Python 3，且依赖已在 3.12 中移除的 `imp` 模块。

---

## 2. 依赖安装与更新命令

因 Ubuntu/Debian 启用 PEP 668，系统 `pip3` 不能直接往全局装包，采用 **venv** 方式。

### 2.1 创建虚拟环境

```bash
cd /root/claudeCodeProject/vup/dds
python3 -m venv .venv-py3
```

### 2.2 升级 pip 并安装构建所需 Python 库

```bash
.venv-py3/bin/pip install -U pip

.venv-py3/bin/pip install \
  'pyyaml>=5.4' \
  'cheetah3>=3.2.6' \
  'jinja2==2.11.3' \
  packaging \
  setuptools
```

### 2.3 实际安装到的关键包版本（构建验证时）

| 包名 | 版本 | 用途 |
|------|------|------|
| pip | 26.2.1 | 包管理 |
| PyYAML | 6.0.3 | SCons / IDL 等配置与 YAML 解析 |
| Cheetah3 | 3.2.6.post1 | `generate_error_codes.py` 模板生成 |
| Jinja2 | 2.11.3 | 部分脚本模板依赖 |
| packaging | 26.3 | Icecream 工具版本比较（替代已弱化的 `pkg_resources`） |
| setuptools | 84.0.0 | 安装/兼容支撑 |

另：系统已具备 `python3-yaml`（apt），但正式编译推荐统一走 `.venv-py3`，以保证 Cheetah3 等包可用。

### 2.4 引入 SCons 3.1.2

从 SourceForge 下载 `scons-local-3.1.2.zip`，解压并 vendored 到：

- `src/third_party/scons-3.1.2/`

默认由 `buildscripts/scons.py` 通过 `SCONS_VERSION=3.1.2` 加载（可用环境变量覆盖）。

---

## 3. 推荐编译命令

```bash
cd /root/claudeCodeProject/vup/dds

# mongod
./.venv-py3/bin/python buildscripts/scons.py \
  MONGO_VERSION=4.0.3 mongod \
  --disable-warnings-as-errors -j$(nproc) \
  2>&1 | tee /tmp/py3_mongod_build.log

# mongos / mongo shell / mongobridge
./.venv-py3/bin/python buildscripts/scons.py \
  MONGO_VERSION=4.0.3 mongos mongo mongobridge \
  --disable-warnings-as-errors -j$(nproc) \
  2>&1 | tee /tmp/py3_core_tools_build.log
```

验证结果（本次工作）：上述目标均编译成功，`--version` 显示 `v4.0.3`。

---

## 4. 改动文件清单（不展开具体代码 diff）

### 4.1 新增（未跟踪）

| 路径 | 说明 |
|------|------|
| `src/third_party/scons-3.1.2/` | 支持 Python 3 的 SCons 3.1.2 本地包 |
| `.venv-py3/` | 本地 Python 3 虚拟环境与已装依赖（一般不入库） |

### 4.2 构建入口与顶层配置

| 文件 |
|------|
| `buildscripts/scons.py` |
| `SConstruct` |
| `buildscripts/requirements.txt` |
| `docs/building.md` |
| `buildscripts/utils.py` |
| `buildscripts/moduleconfig.py` |
| `buildscripts/make_archive.py` |

### 4.3 shebang / 辅助脚本（python2 → python3 等）

| 文件 |
|------|
| `buildscripts/idl/idlc.py` |
| `buildscripts/idl/run_tests.py` |
| `buildscripts/idl/tests/test_binder.py` |
| `buildscripts/idl/tests/test_generator.py` |
| `buildscripts/idl/tests/test_import.py` |
| `buildscripts/idl/tests/test_parser.py` |
| `buildscripts/pylinters.py` |
| `buildscripts/prune_check.py` |
| `buildscripts/sha256sum.py` |

### 4.4 IDL 编译器（构建期 codegen）

| 文件 |
|------|
| `buildscripts/idl/idl/binder.py` |
| `buildscripts/idl/idl/bson.py` |
| `buildscripts/idl/idl/syntax.py` |

### 4.5 site_scons 工具链

| 文件 |
|------|
| `site_scons/libdeps.py` |
| `site_scons/mongo/__init__.py` |
| `site_scons/mongo/generators.py` |
| `site_scons/site_tools/dagger/graph.py` |
| `site_scons/site_tools/distsrc.py` |
| `site_scons/site_tools/icecream.py` |
| `site_scons/site_tools/idl_tool.py` |
| `site_scons/site_tools/jstoh.py` |
| `site_scons/site_tools/mongo_benchmark.py` |
| `site_scons/site_tools/mongo_integrationtest.py` |
| `site_scons/site_tools/mongo_unittest.py` |
| `site_scons/site_tools/split_dwarf.py` |
| `site_scons/site_tools/thin_archive.py` |
| `site_scons/site_tools/xcode.py` |

### 4.6 源码树中的构建脚本 / SConscript / 头文件

| 文件 |
|------|
| `src/mongo/SConscript` |
| `src/mongo/installer/msi/SConscript` |
| `src/mongo/base/generate_error_codes.py` |
| `src/mongo/db/auth/generate_action_types.py` |
| `src/mongo/db/fts/generate_stop_words.py` |
| `src/mongo/db/fts/unicode/gen_casefold_map.py` |
| `src/mongo/db/fts/unicode/gen_delimiter_list.py` |
| `src/mongo/db/fts/unicode/gen_diacritic_list.py` |
| `src/mongo/util/generate_icu_init_cpp.py` |
| `src/mongo/db/free_mon/free_mon_options.h` |

说明：`free_mon_options.h` 的修改属于配合 GCC 14 编译所需的头文件包含修复（与 Python 3 迁移同期暴露），一并纳入本次可编译状态。

---

## 5. 工作内容分类概览（按事项，非代码细节）

1. **升级构建引擎**：引入 SCons 3.1.2，调整 `buildscripts/scons.py` 默认版本与 shebang。  
2. **SConstruct / site_scons 可在 Py3 下加载**：修正 Py2 专有语法与已移除标准库用法（如 `imp`→`importlib`、`md5`→`hashlib`、字典视图、八进制字面量、`print` 语句、`bytes`/`str` 等）。  
3. **构建期代码生成脚本适配 Py3**：IDL、error_codes（Cheetah）、FTS/unicode 生成器、ICU 初始化生成、归档脚本等。  
4. **Python 依赖与文档**：更新 `requirements.txt`、`docs/building.md`；建立 `.venv-py3` 并安装上述包。  
5. **版本串显示修复**：修正 `git describe` 在 Py3 下返回 bytes 导致 `INNER_MONGO_VERSION` 异常；空值时回退到 `MONGO_VERSION`。  
6. **编译验证**：成功产出 `mongod`、`mongos`、`mongo`、`mongobridge`。  
7. **resmoke 测试框架 Python 3 化**：修正 `long`/`xrange`/`basestring`/`Queue`/`print`/`execfile`/`.next()`、三处 `__metaclass__` 注册、`rmtree` 路径处理；放宽 `PyYAML`、约束 `pymongo<4`。

---

## 6. 明确未纳入本次范围的事项

- **打包脚本、lint 全家桶、CI 流水线** 的全面迁移。  
- resmoke 以外的辅助工具（如 `burn_in_tests.py`、`ciconfig/tags.py` 的 `sort(cmp=...)`）若走冷路径，可能仍含 Py2 API，需按需再改。  
- replica set / auth / stepdown 等重度依赖 pymongo 旧 API 的套件：已通过钉死 `pymongo>=3,<4` 规避；未做 pymongo 4 API 改写。  
- 将 `.venv-py3` 或本地构建产物提交进版本库（不建议）。

---

## 7. 快速复现清单

```bash
cd /root/claudeCodeProject/vup/dds
python3 -m venv .venv-py3
.venv-py3/bin/pip install -U pip
.venv-py3/bin/pip install \
  'pyyaml>=5.4' 'cheetah3>=3.2.6' 'jinja2==2.11.3' packaging setuptools \
  'pymongo>=3.0,<4' 'requests>=2.16.1'

# 编译
./.venv-py3/bin/python buildscripts/scons.py \
  MONGO_VERSION=4.0.3 mongod mongos mongo mongobridge \
  --disable-warnings-as-errors -j$(nproc)

# 跑 JS 测试（示例：core 套件；或指定若干用例）
./.venv-py3/bin/python buildscripts/resmoke.py \
  --suites=core --continueOnFailure --jobs=2
```

前提：仓库中已包含本次对构建脚本 / SCons 3.1.2 / resmoke 的改动。

---

## 8. resmoke Python 3 改动要点

| 类别 | 处理 |
|------|------|
| 语法 | `long`→`int`，`xrange`→`range`，`print` 语句→函数，`basestring`→`str` |
| 标准库 | `Queue`→`queue`（保留 Py2 fallback），`execfile`→`exec(compile(...))`，`generator.next()`→`next(...)` |
| 注册机制 | Fixture / Hook / TestCase：`__metaclass__ = ...` → `metaclass=...`（否则 Py3 下注册表为空，无法创建 `MongoDFixture` / `js_test`） |
| 路径 | `utils.rmtree`：Py3 直接用 `str`，bytes 则 decode |
| 依赖 | `PyYAML>=5.4`；`pymongo>=3,<4`；`requests` |

**验证**：`--help` / `--listSuites` / `--dryRun=tests` 通过；`basic1.js` / `basic2.js` / `basic4.js`（含 ValidateCollections）在 Py3 下全部通过。
