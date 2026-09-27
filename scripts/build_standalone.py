#!/usr/bin/env python3
"""把 index.html + app.js + 一份数据打包成单个 HTML 文件。

用途：需要一个"双击就能看"或"任意静态服务都能跑"的文件时使用（不依赖 fetch，数据内嵌）。
注意：内嵌的数据会写进产物里，含真实数据的产物不要提交到仓库。

用法：
    python3 scripts/build_standalone.py --data ../private/awards-timeline.json --out ../private/timeline.html
    python3 scripts/build_standalone.py --demo --out timeline-demo.html
"""
import argparse
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", help="数据文件（JSON）")
    ap.add_argument("--demo", action="store_true", help="改用项目自带的 demo-data.json")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    data_path = ROOT / "demo-data.json" if args.demo else pathlib.Path(args.data)
    data = json.loads(data_path.read_text(encoding="utf-8"))

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")

    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    inline = f'<script id="inline-data" type="application/json">{payload}</script>\n'
    html = html.replace('<script src="app.js"></script>', inline + "<script>\n" + app + "</script>")
    html = html.replace("<title>", "<!-- 单文件构建：数据已内嵌 -->\n<title>")
    out = pathlib.Path(args.out)
    out.write_text(html, encoding="utf-8")
    size = out.stat().st_size
    print(f"写出 {out}（{size/1024:.0f} KB）｜数据源 {data_path.name}｜授予 {len(data.get('awards', {}))} 笔")


if __name__ == "__main__":
    main()
