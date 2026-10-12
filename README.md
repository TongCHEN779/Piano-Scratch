# Piano Scratch

上传一段音频 → 自动转成钢琴五线谱（粗分左右手）→ 在谱面上交互编辑。纯静态页面，无需构建，所有处理都在浏览器本地完成。

- 转谱：[Spotify Basic Pitch](https://github.com/spotify/basic-pitch)（TensorFlow.js，首次使用从 CDN 加载模型）
- 谱面：自写 SVG 大谱表渲染器，字体 Bravura（SIL OFL，见 `assets/fonts/`）
- 编辑：拖动改音高/位置、改时值、切换左右手、增删音符、撤销重做、播放、导出 JSON / MIDI / 打印

## 本地运行

```bash
python3 -m http.server 8000   # 然后打开 http://localhost:8000
```

## 部署到 GitHub Pages

仓库 Settings → Pages → Source 选 `main` 分支 `/ (root)` 即可。
