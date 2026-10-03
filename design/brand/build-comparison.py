from pathlib import Path
import base64
import html
import re
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
FIVE = '--five' in sys.argv
FOUR = '--four' in sys.argv or FIVE
THREE = '--three' in sys.argv or FOUR
SOURCE = Path('/Users/ruanjingyu/.codex/attachments/142cf043-faa9-4ad9-94f6-bf8f8a334fcf/Pasted text.txt')
original = SOURCE.read_text()
svgs = re.findall(r'<svg\b[^>]*>.*?</svg>', original, re.S)
assert len(svgs) == 3
for svg in svgs:
    ET.fromstring(svg)
(ROOT / 'gemini-original.html').write_text(original)
(ROOT / 'gemini-icon.svg').write_text(svgs[0])
(ROOT / 'gemini-favicon.svg').write_text(svgs[2])

def data(content, mime='image/svg+xml'):
    return f'data:{mime};base64,' + base64.b64encode(content.encode()).decode()

assets = {
    'codexIcon': data((ROOT / 'vfr-icon.svg').read_text()),
    'codexFav': data((ROOT / 'favicon.svg').read_text()),
    'geminiIcon': data(svgs[0]),
    'geminiFav': data(svgs[2]),
}
if THREE:
    assets['kiroIcon'] = data((ROOT / 'kiro/kiro-icon.svg').read_text())
    assets['kiroFav'] = data((ROOT / 'kiro/kiro-favicon.svg').read_text())
if FOUR:
    assets['freshIcon'] = data((ROOT/'claude-original-prompt/icon.svg').read_text())
    assets['freshFav'] = data((ROOT/'claude-original-prompt/favicon.svg').read_text())
if FIVE:
    assets['serifIcon'] = data((ROOT/'codex-serif/icon.svg').read_text())
    assets['serifFav'] = data((ROOT/'codex-serif/favicon.svg').read_text())
codex_original = (ROOT / 'preview.html').read_text()
for name in ['vfr-icon.svg', 'vfr-logo.svg', 'vfr-logo-dark.svg', 'favicon.svg']:
    codex_original = codex_original.replace(f'src="{name}"', f'src="{data((ROOT / name).read_text())}"')

def img(key, cls='', size=None, alt=''):
    wh = f' width="{size}" height="{size}"' if size else ''
    return f'<img src="{assets[key]}" class="{cls}"{wh} alt="{html.escape(alt)}">'

def column(name, prefix, description):
    sizes = ''.join(f'<div class="size-item">{img(prefix+"Fav", size=s, alt=f"{name} {s} 像素标签页图标")}<span>{s} px</span></div>' for s in [16,24,32,48])
    return f'''
    <article class="proposal"><header class="proposal-head"><h2>{name}</h2><p>{description}</p></header>
      <div class="surface icon-stage">{img(prefix+'Icon', 'main-icon', 160, name+' 应用图标')}<span class="caption">160 × 160 px</span></div>
      <div class="section-heading">网页页眉</div><div class="surface navigation-demo">{img(prefix+'Icon',size=32,alt=name+' 页眉图标')}<span>Vandy Food Radar</span></div>
      <div class="section-heading">浏览器标签页，实际 16 px</div><div class="surface browser-demo"><div class="tab-strip"><div class="active-tab">{img(prefix+'Fav',size=16,alt=name+' 16 像素标签页图标')}<span>Vandy Food Radar</span><span class="close" aria-hidden="true">×</span></div></div><div class="browser-content"></div></div>
      <div class="section-heading">标签页图标的尺寸对比</div><div class="surface size-rail">{sizes}</div>
    </article>'''

template = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vandy Food Radar 标识方案对比</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:#1c1c1c;background:#f5f5f7;--surface:#fff;--preview-ink:#1c1c1c;--muted:#6e6e73;--chrome:#e9e9ed;--tab:#fff;--rule:#e8e8ec}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:44px 32px 56px}.kicker{font-size:11px;font-weight:600;letter-spacing:.09em;color:#86868b;margin:0 0 10px}h1{font-size:32px;font-weight:600;letter-spacing:-.035em;margin:0 0 12px}.intro{font-size:14px;line-height:1.8;color:#6e6e73;margin:0;max-width:730px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:26px 0 20px}.control-label{font-size:12px;color:#6e6e73}.segmented{display:inline-flex;padding:3px;background:#e8e8ed;border-radius:10px;gap:3px}button{font:inherit;cursor:pointer;border:0;background:transparent;border-radius:7px;color:#515154;padding:9px 15px;font-size:12px;min-height:36px}button[aria-pressed="true"]{background:#fff;color:#1c1c1c;box-shadow:0 1px 4px #0000000c}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #0071e3;outline-offset:3px}.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.proposal{min-width:0;background:#fff;border-radius:22px;padding:24px}.proposal-head h2{font-size:20px;letter-spacing:-.02em;margin:0 0 8px;font-weight:600}.proposal-head p{font-size:13px;line-height:1.6;color:#6e6e73;margin:0 0 20px;min-height:21px}.surface{background:var(--surface);color:var(--preview-ink);border:1px solid var(--rule);border-radius:14px;transition:background-color .15s,color .15s}.icon-stage{height:252px;display:flex;flex-direction:column;gap:18px;align-items:center;justify-content:center}.main-icon{width:160px;height:160px}.caption{font-size:11px;color:var(--muted)}.section-heading{font-size:11px;color:#86868b;margin:20px 0 10px}.navigation-demo{min-height:68px;display:flex;align-items:center;gap:12px;padding:16px 18px;font-size:17px;letter-spacing:-.025em;font-weight:600}.navigation-demo img{flex-shrink:0}.browser-demo{overflow:hidden;border-radius:12px}.tab-strip{padding:8px 8px 0;background:var(--chrome)}.active-tab{background:var(--tab);display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px 8px 0 0;max-width:255px;font-size:11px;height:38px}.active-tab img{flex-shrink:0}.active-tab .close{margin-left:auto;font-size:15px;color:var(--muted)}.browser-content{height:20px;background:var(--tab)}.size-rail{min-height:102px;display:flex;align-items:flex-end;justify-content:center;gap:34px;padding:18px}.size-item{display:flex;align-items:center;flex-direction:column;gap:10px}.size-item span{font-size:11px;white-space:nowrap;color:var(--muted)}.note{font-size:12px;line-height:1.8;color:#86868b;margin:16px 0 32px}.inspection{background:#fff;border-radius:22px;padding:24px;margin-top:20px}.inspection h2,.facts h2{font-size:19px;font-weight:600;letter-spacing:-.02em;margin:0 0 14px}.inspection-controls{display:flex;align-items:center;gap:20px;flex-wrap:wrap;font-size:12px;color:#6e6e73;margin-bottom:18px}.inspection-controls .field{display:flex;align-items:center;gap:9px}select{font:inherit;border:1px solid #d2d2d7;border-radius:8px;padding:7px 10px;background:#fff;color:#1c1c1c;min-height:36px}input[type="range"]{width:180px;accent-color:#1c1c1c}output{color:#1c1c1c;min-width:44px;font-variant-numeric:tabular-nums}.inspect-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.inspect-frame{min-height:160px;display:flex;align-items:center;justify-content:center;padding:16px;flex-direction:column;gap:16px}.inspect-frame img{width:48px;height:48px}.inspect-frame span{font-size:11px;color:var(--muted)}.facts{margin:32px 0}.table-scroll{overflow:auto;border:1px solid #e5e5e9;border-radius:14px;background:#fff}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.8;text-align:left}th,td{padding:15px 20px;vertical-align:top;border-bottom:1px solid #ededf0}tr:last-child td{border-bottom:0}th{font-weight:600;background:#fafafa}td:first-child{width:18%;color:#6e6e73}th:first-child{width:18%}.originals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}details{min-width:0;border:1px solid #e0e0e5;border-radius:14px;background:#fff;overflow:hidden}summary{padding:18px 20px;font-size:13px;cursor:pointer}iframe{width:100%;height:720px;display:block;border:0;border-top:1px solid #ededf0}footer{font-size:12px;color:#86868b;line-height:1.8;margin-top:24px}.download-row{display:flex;flex-wrap:wrap;gap:18px;margin-top:12px}a{color:#0066cc;text-decoration:none;font-size:12px}a:hover{text-decoration:underline}
body[data-background="dark"]{--surface:#1c1c1c;--preview-ink:#f5f5f7;--muted:#a1a1a6;--chrome:#303033;--tab:#1c1c1c;--rule:#39393c}body[data-background="checker"] .surface{background-image:conic-gradient(#ededf0 25%,#fff 0 50%,#ededf0 0 75%,#fff 0);background-size:16px 16px}
@media(max-width:760px){main{padding:28px 16px 40px}h1{font-size:26px}.toolbar{align-items:flex-start;flex-direction:column;gap:10px}.originals{grid-template-columns:minmax(0,1fr)}.proposal{padding:20px}.size-rail{gap:clamp(14px,5vw,34px)}.inspection{padding:20px}.inspect-grid{gap:10px}.inspection-controls{gap:14px}.inspection-controls .field{flex-wrap:wrap}.inspect-frame{padding:12px}.navigation-demo{font-size:16px}.table-scroll table{min-width:580px}th,td{padding:12px 16px}.note{margin-bottom:24px}iframe{height:600px}}@media(max-width:620px){.comparison{grid-template-columns:minmax(0,1fr)}}@media(max-width:400px){.inspect-grid{grid-template-columns:minmax(0,1fr)}}@media(prefers-reduced-motion:reduce){.surface{transition:none}}
@@EXTRA_CSS@@
</style></head><body class="@@VARIANT@@" data-background="light"><main>
<p class="kicker">VANDY FOOD RADAR</p><h1>标识方案对比</h1>
<p class="intro">@@INTRO@@</p>
<div class="toolbar"><span class="control-label">切换展示背景</span><div class="segmented" role="group" aria-label="展示背景"><button type="button" data-background="light" aria-pressed="true">浅色</button><button type="button" data-background="dark" aria-pressed="false">深色</button><button type="button" data-background="checker" aria-pressed="false">透明底检查</button></div></div>
<div class="comparison">@@COLUMNS@@</div>
<p class="note">应用图标按原始正方形画布等尺寸展示，保留各自的留白。页眉采用相同字体与字号，仅用于比较图标。标签页使用各方案原有的 favicon，按实际 CSS 像素显示。</p>
<section class="inspection"><h2>调整尺寸，查看细节</h2><div class="inspection-controls"><div class="field"><label for="kind">图标类型</label><select id="kind"><option value="Fav">标签页图标</option><option value="Icon">应用图标</option></select></div><div class="field"><label for="size">显示尺寸</label><input id="size" type="range" min="16" max="128" step="8" value="48"><output id="size-output" for="size">48 px</output></div></div><div class="inspect-grid">@@INSPECTS@@</div></section>
<section class="facts"><h2>图形与文件的差异</h2><div class="table-scroll"><table><thead><tr><th scope="col">比较项目</th><th scope="col">Codex</th><th scope="col">Gemini</th></tr></thead><tbody>
<tr><td>核心图形</td><td>餐叉与餐匙组成 V，外侧为开放圆弧和发现点。</td><td>餐盘盖上方放置信号圆弧，中央嵌入 V。</td></tr>
<tr><td>色彩处理</td><td>单一金色 #CFAE70，配合黑色 #1C1C1C。</td><td>金色从 #FCEBAF 过渡至 #8A610A，底板也使用深色渐变。</td></tr>
<tr><td>小尺寸处理</td><td>保留黑色底板，去除餐具细节，加粗 V 与圆弧。</td><td>使用透明背景，通过 viewBox 裁剪放大主图形，保留餐盘盖、V 和两条信号圆弧。</td></tr>
<tr><td>渲染检查</td><td>餐具、圆弧和发现点均显示。</td><td>源码中的餐盘底线，在原始页面与本页的浏览器渲染中均未显示。</td></tr>
<tr><td>原始交付</td><td>提供完整字标、独立图形、深浅色版本与 favicon。</td><td>提供应用图标和透明背景 favicon；所给 HTML 中的名称使用页面文字。</td></tr>
</tbody></table></div></section>
<div class="originals"><details><summary>查看 Codex 原始展示页面</summary><iframe loading="lazy" sandbox title="Codex 原始展示页面" src="@@CODEX_ORIGINAL@@"></iframe></details><details><summary>查看 Gemini 原始展示页面</summary><iframe loading="lazy" sandbox title="Gemini 原始展示页面" src="@@GEMINI_ORIGINAL@@"></iframe></details></div>
<footer>本文件内嵌@@COUNT@@版 SVG 和原始展示页面，可以离线打开。对比图保留原始路径、渐变和 viewBox。<div class="download-row">@@DOWNLOADS@@</div></footer>
</main><script>
const assetMap=@@ASSETS@@;
document.querySelectorAll('button[data-background]').forEach(button=>button.addEventListener('click',()=>{document.body.dataset.background=button.dataset.background;document.querySelectorAll('button[data-background]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));}));
const sizeControl=document.getElementById('size');const kindControl=document.getElementById('kind');
const labels=@@LABELS@@;
function updateInspection(){const size=Number(sizeControl.value);document.getElementById('size-output').value=size+' px';for(const prefix of @@PREFIXES@@){const image=document.getElementById(prefix+'-inspection');image.src=assetMap[prefix+kindControl.value];image.style.width=size+'px';image.style.height=size+'px';image.alt=labels[prefix]+' '+size+' 像素'+(kindControl.value==='Fav'?'标签页图标':'应用图标');}}
sizeControl.addEventListener('input',updateInspection);kindControl.addEventListener('change',updateInspection);
</script></body></html>'''

import json
schemes = [('Codex','codex','餐具 V、雷达圆弧与发现点。'),('Gemini','gemini','餐盘盖、字母 V 与信号圆弧。')]
if THREE:
    schemes.append(('Claude 加粗版' if FOUR else 'Kiro','kiro','Claude Sonnet 5，餐具 V 加粗版。'))
if FOUR:
    schemes.append(('Claude 原始提示词','fresh','Claude Sonnet 5，按原始提示词设计。'))
if FIVE:
    schemes.append(('Codex 衬线版','serif','尖底 V 与外张衬线，保留餐具和雷达结构。'))
result = template.replace('@@COLUMNS@@', ''.join(column(*scheme) for scheme in schemes))
inspect = ''.join('<div class="surface inspect-frame">'+img(prefix+'Fav',alt=name+' 48 像素标签页图标').replace('<img ', f'<img id="{prefix}-inspection" ')+f'<span>{name}</span></div>' for name,prefix,_ in schemes)
result = result.replace('@@INSPECTS@@',inspect).replace('@@PREFIXES@@',json.dumps([s[1] for s in schemes])).replace('@@LABELS@@',json.dumps({s[1]:s[0] for s in schemes}))
result = result.replace('@@VARIANT@@','three four five' if FIVE else 'three four' if FOUR else 'three' if THREE else 'two').replace('@@COUNT@@','五' if FIVE else '四' if FOUR else '三' if THREE else '两')
intro = '依次展示 Codex 原版、Gemini 和 Kiro 中 Claude Sonnet 5 生成的加粗版本。三版图形使用相同尺寸和背景，重点比较 V 的笔画、比例与小尺寸显示。' if THREE else '左侧为 Codex，右侧为 Gemini。两版图形使用相同的显示尺寸和背景，可以同时检查应用图标、网页页眉与浏览器标签页。'
if FOUR:
    intro='依次展示 Codex、Gemini、Claude 加粗版与 Claude 原始提示词版。两个 Claude 版本均通过 Kiro 调用 Claude Sonnet 5，分别使用定向修改要求和所提供的原始提示词。'
if FIVE:
    intro='新增第五个方案 Codex 衬线版。它在原版餐具 V 的基础上增加外张衬线与尖底，并加粗字母笔画。五版采用相同尺寸和背景，支持检查页眉与实际标签页效果。'
result = result.replace('@@INTRO@@',intro)
extra = '''.three main{max-width:1360px}.three .comparison,.three .inspect-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.three .proposal{padding:20px}.three .proposal-head p{min-height:42px}.three .size-rail{gap:10px;padding:12px}.three .navigation-demo{padding:14px 12px;font-size:13px;gap:8px}.three .table-scroll table{min-width:760px}.three .notes{margin:0;padding:0 20px 20px;font-family:inherit;font-size:13px;line-height:1.8;white-space:pre-wrap}.three .originals{grid-template-columns:repeat(3,minmax(0,1fr))}@media(max-width:900px){.three .proposal{padding:14px}.three .active-tab{gap:6px;font-size:10px;padding:10px 8px}.three .originals{grid-template-columns:minmax(0,1fr)}}@media(max-width:680px){.three .comparison{grid-template-columns:minmax(0,1fr)}}@media(max-width:560px){.three .inspect-grid{grid-template-columns:minmax(0,1fr)}}'''
if FOUR:
    extra+='''.four main{max-width:1440px}.four .comparison,.four .inspect-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.four .proposal-head h2{font-size:16px;line-height:24px;min-height:24px}.four .proposal-head p{font-size:12px;min-height:58px}.four .main-icon{width:min(160px,100%);height:auto;aspect-ratio:1}.four .table-scroll table{min-width:1000px}.four .originals{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:900px){.four .proposal{padding:10px}.four .size-rail{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:14px 8px}.four .navigation-demo{flex-direction:column;text-align:center}.four .inspect-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.four .active-tab span:not(.close){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.four .active-tab{gap:5px;padding:10px 6px}}@media(max-width:620px){.four .comparison{grid-template-columns:repeat(2,minmax(0,1fr))}.four .proposal-head h2{min-height:40px}}@media(max-width:420px){.four .comparison,.four .inspect-grid,.four .originals{grid-template-columns:minmax(0,1fr)}.four .size-rail{display:flex;gap:20px}.four .navigation-demo{flex-direction:row;text-align:left}}'''
if FIVE:
    extra+='''.five main{max-width:1600px}.five .comparison,.five .inspect-grid{grid-template-columns:repeat(5,minmax(0,1fr));gap:16px}.five .proposal{padding:16px}.five .proposal:last-child{box-shadow:0 0 0 2px #cfae70}.five .proposal-head p{min-height:58px}.five .icon-stage{height:230px}.five .table-scroll table{min-width:1240px}.five .size-rail{gap:12px}.five .navigation-demo{padding:14px 10px;font-size:12px}.focus-comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:26px;background:#fff;border-radius:22px;padding:24px}.focus-comparison h2{font-size:15px;font-weight:600;margin:0 0 20px}.focus-item{display:flex;flex-direction:column;align-items:center;text-align:center}.focus-item img{width:192px;height:192px}.focus-item p{font-size:12px;color:#6e6e73;line-height:1.7;margin:18px 0 0}.five .section-title{font-size:19px;font-weight:600;margin:28px 0 18px}@media(max-width:1100px){.five .comparison{grid-template-columns:repeat(3,minmax(0,1fr))}.five .inspect-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.five .navigation-demo{flex-direction:row;text-align:left}.five .size-rail{display:flex;gap:16px}.five .proposal-head p{min-height:42px}}@media(max-width:720px){.five .comparison,.five .inspect-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.five .proposal{padding:14px}.five .navigation-demo{flex-direction:column;text-align:center}.five .size-rail{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.focus-comparison{padding:20px 12px;gap:12px}.focus-item img{width:min(192px,100%);height:auto;aspect-ratio:1}}@media(max-width:420px){.five .comparison,.five .inspect-grid{grid-template-columns:minmax(0,1fr)}.five .navigation-demo{flex-direction:row;text-align:left}.five .size-rail{display:flex;gap:20px}.focus-comparison{gap:16px;padding:16px 12px}.focus-comparison h2{font-size:13px}.focus-item p{font-size:11px}}'''
result = result.replace('@@EXTRA_CSS@@',extra if THREE else '')
result = result.replace('@@ASSETS@@',json.dumps(assets)).replace('@@CODEX_ORIGINAL@@',data(codex_original,'text/html')).replace('@@GEMINI_ORIGINAL@@',data(original,'text/html'))
downloads = ''.join(f'<a download="{prefix}-{kind.lower()}.svg" href="{assets[prefix+kind]}">{name} {label}</a>' for name,prefix,_ in schemes for kind,label in [('Icon','应用图标 SVG'),('Fav','标签页 SVG')])
result = result.replace('@@DOWNLOADS@@',downloads)
if THREE:
    # Append a third cell to each existing table row while retaining the two source designs.
    cells = ['Claude 加粗版' if FOUR else 'Kiro（Claude Sonnet 5）','@@KIRO_CORE@@','黑金配色与 Codex 原版一致，采用单一金色。','专用 favicon 保留加粗 V，并简化餐具细节。','@@KIRO_RENDER@@','通过 Kiro CLI 调用 Claude Sonnet 5，提供新图标、favicon 与独立图形。']
    matches = list(re.finditer(r'<tr>(.*?)</tr>',result,re.S))
    assert len(matches) == len(cells)
    for index in range(len(matches)-1,-1,-1):
        match=matches[index]
        tag='th' if index==0 else 'td'
        attrs=' scope="col"' if index==0 else ''
        replacement='<tr>'+match.group(1)+f'<{tag}{attrs}>'+cells[index]+f'</{tag}></tr>'
        result=result[:match.start()]+replacement+result[match.end():]
    notes=html.escape((ROOT/'kiro/design-notes.md').read_text())
    result=result.replace('</iframe></details></div>','</iframe></details><details><summary>查看 Kiro 设计说明</summary><pre class="notes">'+notes+'</pre></details></div>')
    # These descriptions are filled from the generated files after visual review.
    result=result.replace('@@KIRO_CORE@@','沿用餐具 V、开放圆弧与发现点，增加 V 的视觉重量。').replace('@@KIRO_RENDER@@','加粗图形按原始 SVG 渲染。')
if FOUR:
    cells=['Claude 原始提示词','@@FRESH_CORE@@','@@FRESH_COLOR@@','@@FRESH_FAV@@','按独立生成的 HTML 与其中的 SVG 渲染。','使用用户原始提示词，独立输出 HTML，未读取前三版设计文件。']
    matches=list(re.finditer(r'<tr>(.*?)</tr>',result,re.S))
    assert len(matches)==len(cells)
    for index in range(len(matches)-1,-1,-1):
        match=matches[index];tag='th' if index==0 else 'td';attrs=' scope="col"' if index==0 else ''
        result=result[:match.start()]+'<tr>'+match.group(1)+f'<{tag}{attrs}>'+cells[index]+f'</{tag}></tr>'+result[match.end():]
    fresh_page=(ROOT/'claude-original-prompt/design.html').read_text()
    fresh_details='<details><summary>查看 Claude 原始提示词版本的 HTML</summary><iframe loading="lazy" sandbox title="Claude 原始提示词版本" src="'+data(fresh_page,'text/html')+'"></iframe></details>'
    result=result.replace('</pre></details></div>','</pre></details>'+fresh_details+'</div>')
    prompt=html.escape((ROOT/'claude-original-prompt/user-prompt.txt').read_text())
    prompt_details='<details><summary>查看测试使用的原始提示词</summary><pre class="notes">'+prompt+'</pre></details>'
    result=result.replace('<footer>',prompt_details+'<footer>')
    # Filled after inspecting the model's independently generated HTML artwork.
    facts_path=ROOT/'claude-original-prompt/observed-facts.json'
    facts=json.loads(facts_path.read_text())
    result=result.replace('@@FRESH_CORE@@',html.escape(facts['core'])).replace('@@FRESH_COLOR@@',html.escape(facts['color'])).replace('@@FRESH_FAV@@',html.escape(facts['favicon']))
    result=result.replace('160 × 160 px','等尺寸预览')
if FIVE:
    cells=['Codex 衬线版','餐具与雷达结构源自 Codex 原版，V 改为填充字形，增加外张衬线及尖底。','采用原版黑金配色，金色 #CFAE70 与黑色 #1C1C1C。','采用专用简化字形，保留衬线、尖底、雷达圆弧和发现点。','应用图标与 favicon 分别检查 16、24、32、48 像素显示。','新增应用图标、专用 favicon、独立标记与完整矢量字标。']
    matches=list(re.finditer(r'<tr>(.*?)</tr>',result,re.S))
    assert len(matches)==len(cells)
    for index in range(len(matches)-1,-1,-1):
        match=matches[index];tag='th' if index==0 else 'td';attrs=' scope="col"' if index==0 else ''
        result=result[:match.start()]+'<tr>'+match.group(1)+f'<{tag}{attrs}>'+cells[index]+f'</{tag}></tr>'+result[match.end():]
    focus='<section class="focus-comparison" aria-label="Codex 原版与衬线版对比">'
    for name,prefix,description in [('Codex 原版','codex','圆头笔画，餐具组成柔和的 V。'),('Codex 衬线版','serif','外张衬线、内侧曲线与尖底，增加字母的厚度。')]:
        focus+='<div class="focus-item"><h2>'+name+'</h2>'+img(prefix+'Icon',size=192,alt=name+' 放大图标')+'<p>'+description+'</p></div>'
    focus+='</section><h2 class="section-title">五版完整对比</h2>'
    result=result.replace('<div class="comparison">',focus+'<div class="comparison">')
    result=result.replace('<footer>','<details><summary>查看 Codex 衬线版的设计说明</summary><pre class="notes">'+html.escape((ROOT/'codex-serif/README.md').read_text())+'</pre></details><footer>')
assert '@@' not in result
output='comparison-five.html' if FIVE else 'comparison-four.html' if FOUR else 'comparison-three.html' if THREE else 'comparison.html'
(ROOT/output).write_text(result)
print(f'Created standalone {output} ({len(result.encode())} bytes) and original Gemini files.')
