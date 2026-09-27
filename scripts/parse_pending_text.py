#!/usr/bin/env python3
"""解析系统里"拟授予详情"的粘贴文本，输出逐期归属明细 CSV。

文本来源（让用户操作）：
  飞书 → 期权激励 → 授予详情 → 点开某条「拟授予」记录 → 详情页全选复制 → 存成 .txt
  多条记录依次复制、贴在同一个文件里即可。

输出列：award_number, category, award_type, grant_class, grant_date, expiration_date,
        exercise_price_usd, units_granted, tranche_index, vesting_date, planned_units

用法：
    python3 scripts/parse_pending_text.py --text ~/pending.txt --out .work/proposed_award_schedules.csv
"""
import argparse
import csv
import re


def parse(text):
    awards = []
    blocks = [b for b in re.split(r"(?=期权详情|豆包股详情)", text) if b.strip()]
    for b in blocks:
        m = re.search(r"授予编号\s*\n+([A-Za-z]+\d+)", b)
        if not m:
            continue
        aid = m.group(1)

        def field(name):
            mm = re.search(name + r"\s*\n+([^\n|]+)", b)
            return mm.group(1).strip() if mm else None

        tranches = [(d, int(u.replace(",", ""))) for d, u in re.findall(
            r"\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*\d+\s*\|\s*待归属\s*\|\s*([\d,]+)\s*\|", b)]
        if not tranches:
            continue
        awards.append({
            "award_number": aid,
            "category": "dola" if aid.upper().startswith("DLPS") else "option",
            "award_type": field("授予类型") or "",
            "grant_class": field("授予分类") or "",
            "grant_date": field("授予日期") or "",
            "expiration_date": field("过期日期") or "",
            "exercise_price_usd": (field("行权价") or "").replace("(USD)", "").strip(),
            "units": int((field("授予数量") or "0").replace(",", "")),
            "tranches": tranches,
        })
    return awards


def main():
    ap = argparse.ArgumentParser(description="拟授予详情文本 → 逐期归属 CSV")
    ap.add_argument("--text", required=True, help="粘贴文本文件")
    ap.add_argument("--out", required=True, help="输出 CSV 路径")
    args = ap.parse_args()

    awards = parse(open(args.text, encoding="utf-8").read())
    if not awards:
        raise SystemExit("没有解析到任何「详情」块——确认文本是从系统详情页整段复制过来的。")

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["award_number", "category", "award_type", "grant_class", "grant_date",
                    "expiration_date", "exercise_price_usd", "units_granted",
                    "tranche_index", "vesting_date", "planned_units"])
        for a in awards:
            for i, (d, u) in enumerate(a["tranches"], 1):
                w.writerow([a["award_number"], a["category"], a["award_type"], a["grant_class"],
                            a["grant_date"], a["expiration_date"], a["exercise_price_usd"],
                            a["units"], i, d, u])

    print("解析到 %d 笔拟授予：" % len(awards))
    for a in awards:
        total = sum(u for _, u in a["tranches"])
        flag = "✓" if total == a["units"] else "✗ 与授予数量不一致"
        print("  %-14s %-20s %5s 股 / %2d 期  %s" % (a["award_number"], a["award_type"], a["units"], len(a["tranches"]), flag))
    print("已写出", args.out)


if __name__ == "__main__":
    main()
