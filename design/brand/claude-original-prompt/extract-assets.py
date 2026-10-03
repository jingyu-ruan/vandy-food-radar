from pathlib import Path
import json
import math
import re
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parent
source=(ROOT/'design.html').read_text()
svgs=re.findall(r'<svg\b[^>]*>.*?</svg>',source,re.S)
for svg in svgs:
    ET.fromstring(svg)

# Preserve the model's actual application-icon composition, including its
# CSS background, 22.5% corners and 68% inner artwork size, as portable SVG.
large=re.search(r'<div class="app-icon-shape tile-120">\s*(<svg\b[^>]*>.*?</svg>)',source,re.S).group(1)
inner=re.sub(r'<svg\b([^>]*)>',r'<svg\1 x="16" y="16" width="68" height="68">',large,count=1)
angle=math.radians(160)
dx,dy=math.sin(angle),-math.cos(angle)
length=100*(abs(dx)+abs(dy))
x1,y1=50-dx*length/2,50-dy*length/2
x2,y2=50+dx*length/2,50+dy*length/2
icon=f'''<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
<title>Claude original-prompt application icon</title>
<desc>Extracted from the generated HTML, retaining its CSS tile proportions and background.</desc>
<defs><linearGradient id="tile-bg" gradientUnits="userSpaceOnUse" x1="{x1:.4f}" y1="{y1:.4f}" x2="{x2:.4f}" y2="{y2:.4f}"><stop offset="0" stop-color="#15151a"/><stop offset=".62" stop-color="#000000"/></linearGradient></defs>
<rect width="100" height="100" rx="22.5" fill="url(#tile-bg)"/>
{inner}
</svg>'''
favicon=re.search(r'<span class="tab-mock">\s*(<svg\b[^>]*>.*?</svg>)',source,re.S).group(1)
hero=re.search(r'<div class="hero-mark-card">.*?(<svg\b[^>]*>.*?</svg>)',source,re.S).group(1)
for name,svg in [('icon.svg',icon),('favicon.svg',favicon),('mark.svg',hero)]:
    ET.fromstring(svg)
    (ROOT/name).write_text(svg)

facts={
 'core':'同心雷达圆环与三齿餐叉指针，加入金色扫描扇形和蓝色信号点。',
 'color':'黑白图形、金棕色 #866D4B 与浅金色 #CFB991，配合蓝色信号点。',
 'favicon':'采用原始 HTML 标签页模拟中的透明底图标；图内加粗圆环和餐叉，保留蓝色中心点。',
}
(ROOT/'observed-facts.json').write_text(json.dumps(facts,ensure_ascii=False,indent=2)+'\n')
(ROOT/'extraction-notes.md').write_text('''# 提取说明

原始生成内容保存在 design.html。应用图标取自 120 px 展示格，保留 HTML 中 22.5% 圆角、160 度深色渐变、68% 图形占比，将外部 CSS 底板转换为 SVG 内部元素。标签页图标取自浏览器标签页模拟区域，保留透明背景。独立图形取自页面顶部展示区域。

图形路径、描边、颜色和透明度来自 Claude 的原始 HTML。对比页页眉使用统一文字排版；模型输出的字标文字可在原始 HTML 中查看。
''')
print(f'Validated {len(svgs)} inline SVGs; extracted icon, favicon and mark.')
