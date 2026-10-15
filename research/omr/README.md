# 纯视觉 OMR 实验：LEGATO 与 homr 基线

目标：图片（钢琴谱）→ 乐谱，在你自己的测试集上量化比较，并找出最常见的错误类型。

| 模型 | 输出 | 环境 | 备注 |
|---|---|---|---|
| **LEGATO**（ICLR 2026，首选） | ABC | Python 3.12、PyTorch 2.6、CUDA 12.4，全精度约 20 GB+ 显存，`--fp16` 更省 | Hugging Face 仓库需申请；视觉编码器来自 Llama 3.2，要接受其许可 |
| **homr**（基线） | MusicXML | Python 3.10，CPU 可跑，CUDA 可选 | TrOMR 衍生，作者说明只识别音高和节奏，其他符号不管 |

## 0. 准备数据

```
research/omr/
  pages/   待识别的整页图片（.jpg/.jpeg/.png，文件夹里不要放别的）
  truth/   同名（不含后缀）的参考答案：MusicXML / MIDI / ABC，
           或网页编辑器「导出 .json」并校对后的文件
```

- 图片尽量是清晰的整页扫描或 PDF 渲染（200–300 dpi），再加一批手机拍照的图，分开放，方便按质量分组比较。
- 答案可以从 MuseScore/IMSLP 的 MusicXML 来；没有的话，用识别结果在网页编辑器里改对后导出 JSON。

## 1. 跑 LEGATO（GPU 机器）

```bash
# 一次性准备
git clone https://github.com/guang-yng/legato ~/legato
conda create -n legato python=3.12 && conda activate legato
pip install -r ~/legato/requirements.txt
huggingface-cli login            # 先在网页上同意 guangyangmusic/legato 和 meta-llama/Llama-3.2-11B-Vision 的条款

# 识别（默认调用官方 scripts/inference.py；--api 则直接用 Python 接口）
python run_legato.py --legato-repo ~/legato --images pages --out out/legato --fp16
```

产物：`out/legato/<页名>.abc`。官方脚本的输出布局没有文档，`run_legato.py` 会兼容常见几种；
若报「unrecognised prediction file layout」，打开它找到的 `test_predictions.json`，把 `normalise()` 改成对应格式即可。

## 2. 跑 homr 基线

```bash
pip install homr                 # 或按 github.com/liebharc/homr 的说明用 Poetry
python run_homr.py --images pages --out out/homr
```

产物：`out/homr/<页名>.musicxml`。

## 3. 评测

```bash
pip install -r requirements.txt

# 音符级 F1（音高 + 起音；再算一个带时值的）：会自动搜索整体平移，处理弱起/多出的休止小节
python evaluate.py --pred-dir out/legato --ref-dir truth
python evaluate.py --pred-dir out/homr   --ref-dir truth

# 不需要答案的自检：每个小节每个声部的总时值是否等于拍号
python measure_check.py out/legato/*.abc out/homr/*.musicxml
```

- `F1` 是平移后的最佳值，`unshifted F1` 是不平移的值；两者差很多说明主要问题是小节对齐。
- 解析失败的文件（模型输出的 ABC/XML 不合法）会单独列出，应当计入失败率。

## 4. 建议的错误分析

对每个 F1 低的页，把预测放进网页编辑器或 MuseScore 对照，按类别记录：
谱号/调号、升降号、连梁时值、附点、和弦、跨谱表、装饰音、八度记号。统计哪几类占了大部分错误，
再决定做哪一个改进（如约束解码、后处理校验）。

## 说明

- 这些脚本里，`evaluate.py`、`measure_check.py`、`scorelib.py` 已在本地用小例子验证过；
  **`run_legato.py`、`run_homr.py` 没有机会在有 GPU 的环境里跑过**，LEGATO 的 Python 接口部分按模型卡的描述写成，
  如果签名不同，以 `scripts/inference.py` 为准。
- 评测指标是音符级的近似，不等同于论文里的 OMR-NED / TEDn；要对标论文请使用 LEGATO 仓库自带的评测脚本。
