#!/usr/bin/env python3
"""一条命令跑完整数据管线：授予记录 PDF + 拟授予详情文本 → 页面数据 JSON。

    python3 scripts/prepare.py --pdfs ~/awards_pdf --pending ~/pending.txt \
        [--labels system_award_list.csv] [--out data/awards-timeline.json] [--work .work] [--txt-cache <dir>] [--standalone out.html]

产物（默认）：
    .work/awards.json                     PDF 解析出的结构化数据
    .work/proposed_award_schedules.csv    拟授予逐期明细
    data/awards-timeline.json             页面直接读取的数据（data/ 已被 .gitignore 忽略，切勿提交）
    <--standalone 指定的单文件 HTML>       可选：数据内嵌的单文件版本

跑完后按提示起 HTTP 服务即可：
    python3 -m http.server 8000     → http://localhost:8000/
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def run(cmd):
    print("\n$ " + " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=ROOT)


def main():
    ap = argparse.ArgumentParser(description="PDF + 拟授予文本 → 页面数据")
    ap.add_argument("--pdfs", required=True, help="授予记录 PDF 目录")
    ap.add_argument("--pending", help="拟授予详情粘贴文本（可选）")
    ap.add_argument("--labels", help="系统授予列表导出 CSV（可选，用来补充中文类型标签）")
    ap.add_argument("--out", default="data/awards-timeline.json", help="页面数据输出路径")
    ap.add_argument("--work", default=".work", help="中间产物目录")
    ap.add_argument("--txt-cache", help="PDF 文本层缓存目录（复用可加速重复运行）")
    ap.add_argument("--standalone", help="同时产出数据内嵌的单文件 HTML 到该路径")
    args = ap.parse_args()

    work = args.work if os.path.isabs(args.work) else os.path.join(ROOT, args.work)
    out = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
    os.makedirs(work, exist_ok=True)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    if args.labels and os.path.exists(args.labels):
        # 提取脚本会从 --out 目录读取 system_award_list.csv 补充标签
        import shutil
        shutil.copy(args.labels, os.path.join(work, "system_award_list.csv"))
        print("已复制标签文件到", os.path.join(work, "system_award_list.csv"))

    awards_json = os.path.join(work, "awards.json")
    cmd = [sys.executable, os.path.join(HERE, "extract_from_pdfs.py"),
           "--pdfs", os.path.abspath(args.pdfs), "--out", work]
    if args.txt_cache:
        cmd += ["--txt-cache", os.path.abspath(args.txt_cache)]
    run(cmd)

    proposed_csv = None
    if args.pending:
        proposed_csv = os.path.join(work, "proposed_award_schedules.csv")
        run([sys.executable, os.path.join(HERE, "parse_pending_text.py"),
             "--text", os.path.abspath(args.pending), "--out", proposed_csv])

    cmd = [sys.executable, os.path.join(HERE, "build_timeline_data.py"),
           "--awards", awards_json, "--out", out]
    if proposed_csv:
        cmd += ["--proposed", proposed_csv]
    if args.labels and os.path.exists(args.labels):
        cmd += ["--labels", os.path.abspath(args.labels)]
    run(cmd)

    data = json.load(open(out, encoding="utf-8"))
    bad = []
    for aid, a in data["awards"].items():
        rows = [t for t in data["tranches"] if t[1] == aid]
        cancelled = sum(t[3] for t in rows if t[4] == "cancel")
        total = sum(t[3] for t in rows if t[4] != "cancel")
        if total != a["units"] - cancelled:
            bad.append((aid, total, a["units"] - cancelled))
    print("\n=== 校验 ===")
    print("授予 %d 笔，期次 %d 期" % (len(data["awards"]), len(data["tranches"])))
    print("期次合计 vs（授予数量 − 已取消）：" + ("全部一致 ✓" if not bad else "存在不一致 ✗ %s" % bad))
    effective = [t for t in data["tranches"] if t[4] == "tranche"]
    pending = [t for t in data["tranches"] if t[4] == "ptranche"]
    print("已生效 %d 期 / 拟授予 %d 期" % (len(effective), len(pending)))

    if args.standalone:
        run([sys.executable, os.path.join(HERE, "build_standalone.py"),
             "--data", out, "--out", os.path.abspath(args.standalone)])

    print("\n=== 下一步 ===")
    print("  cd %s" % ROOT)
    print("  python3 -m http.server 8000     # 打开 http://localhost:8000/")
    print("（远程开发机：本地浏览器用 ssh -L 8000:127.0.0.1:8000 <host> 转发）")
    print("真实数据请勿提交：data/、.work/ 与 *.private.json 已被 .gitignore 忽略。")


if __name__ == "__main__":
    main()
