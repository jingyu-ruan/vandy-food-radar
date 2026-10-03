# Vandy Food Radar 标识

餐叉与餐匙构成字母 V，圆弧同时表达餐盘与雷达，独立金色圆点表达发现。黑色 `#1C1C1C` 与金色 `#CFAE70` 取自范德堡官方品牌配色。原创图形使用简洁几何结构与圆润线条。

## 文件用途

| 文件 | 用途 |
| --- | --- |
| `vfr-logo.svg` | 浅色背景上的完整网页标识，透明背景，字标转为矢量路径 |
| `vfr-logo-dark.svg` | 深色背景上的完整网页标识，透明背景 |
| `vfr-mark.svg` / `vfr-mark-dark.svg` | 独立图形，适合网页页眉或单色品牌位置 |
| `vfr-icon.svg` | 黑金圆角方形图标，适合 48 px 及以上尺寸 |
| `favicon.svg` | 针对 16–32 px 简化与加粗的标签页图标 |
| `favicon.ico` | 16、32、48 px 浏览器兼容文件 |
| `apple-touch-icon.png` | 180 px 主屏幕快捷方式图标 |
| `preview.html` | 浅色、深色及实际小尺寸预览 |

标签页图标与完整 logo 共用 V、圆弧和发现点。小尺寸图标去除餐具的细节，以保持辨识度。

## 接入

将 `favicon.svg` 和 `favicon.ico` 放入站点 public 目录；网页标识放在 `/static/brand/`。Next metadata 的现有 `/favicon.svg` 路径可以继续使用。

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
```

`outline-wordmark.swift` 使用 macOS CoreText 导出字标轮廓；运行 `swift outline-wordmark.swift <本目录绝对路径>` 可重建字标。SVG 成品无需运行该脚本。

## 设计参考

- [Apple 图标设计指南](https://developer.apple.com/design/human-interface-guidelines/app-icons)：简洁形状、一致的识别符号与小尺寸辨识度。
- [Vanderbilt 品牌配色](https://brand.vanderbilt.edu/color/)：Flat Gold 和 Black。
