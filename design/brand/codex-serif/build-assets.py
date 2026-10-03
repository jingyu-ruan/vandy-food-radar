"""Derive transparent marks and outlined wordmarks from the new icon."""
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent
icon = (ROOT / 'icon.svg').read_text()
body = icon[icon.index('  <path'):icon.rindex('</svg>')]
for name, color in [('mark.svg', '#1C1C1C'), ('mark-dark.svg', '#F5F5F7')]:
    mark = body.replace(' opacity=".8"', '')
    dot = mark.index('  <circle')
    mark = mark[:dot].replace('#CFAE70', color) + mark[dot:]
    (ROOT / name).write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" '
        'viewBox="0 0 64 64" fill="none">\n'
        '<title>Vandy Food Radar — serif mark</title>\n' + mark + '</svg>\n'
    )
for source, name, mark in [
    ('vfr-logo.svg', 'logo.svg', 'mark.svg'),
    ('vfr-logo-dark.svg', 'logo-dark.svg', 'mark-dark.svg'),
]:
    original = (SOURCE / source).read_text()
    wordmark = original[original.index('<g', original.index('<circle')):]
    symbol = (ROOT / mark).read_text()
    symbol = symbol[symbol.index('  <path'):symbol.rindex('</svg>')]
    header = original[:original.index('  <g')].replace(
        'V-shaped cutlery and radar symbol', 'Serif V-shaped cutlery and radar symbol'
    )
    (ROOT / name).write_text(header + symbol + wordmark)
for svg in ROOT.glob('*.svg'):
    ET.fromstring(svg.read_text())
print('Validated six SVG assets.')
