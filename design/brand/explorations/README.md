# Free Bites 标识方向草案

四个由 Codex 绘制的 SVG 方案：餐盘与餐叉、一口好味、餐叉信标、餐点坐标。
采用独立图形表达食物发现，保留黑金配色作为比较基准。

每个目录包含 `icon.svg`、`favicon.svg`、`mark.svg` 和 `mark-dark.svg`。
图标画布为 64 × 64，专用标签页画布为 32 × 32。标签页省略部分细节。

`preview.html` 内嵌全部 SVG，可离线打开，并支持切换网页示意方案和深浅背景。
页面采用紧凑标题布局，活动卡片明确标注为版式示意。正式网站采用其中的餐叉信标方案，生产资源位于 `sites/public/static/brand/` 与 `public/static/brand/`。其他方案保留用于设计比较。

执行 `python3 design/brand/explorations/build-preview.py` 可以根据目录中的 SVG 与 `concepts.json` 重建预览。
