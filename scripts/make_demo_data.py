#!/usr/bin/env python3
"""生成仓库自带的脱敏 demo 数据。

设计原则：**不转化真实数值，而是按"形态模板"重新合成** ——
只借用抽象形状（每笔多少期、月度还是季度、有没有契约修订、是否拟授予），
日期、数量、节奏、标签全部重新随机生成，因此无法从 demo 反推任何真实授予。

    python3 scripts/make_demo_data.py --out demo-data.json [--seed 2026]

产物覆盖全部可视化形态，零数据也能体验：
  一次性归属 / 月度节奏 / 季度节奏 / 契约修订（灰顶分片 + 已取消行）/
  6 天内相邻两期（触发合并气泡）/ 拟授予（未生效）
"""
import argparse
import json
import random
from datetime import date, timedelta

# (类别, 期数, 节奏, 标签, 是否拟授予, 特殊形态)；cadence: once / m / q
SHAPES = [
    ("option", 13, "q", "入职授予（示例）", False, {"amended": True}),
    ("dola", 15, "q", "始终创业激励（示例）", False, {"tight_pair": True}),
    ("dola", 22, "m", "豆包股授予（示例）", False, {}),
    ("dola", 1, "once", "豆包股授予（示例 B）", False, {}),
    ("option", 5, "m", "期权授予（示例）", False, {"tight_pair": True}),
    ("dola", 16, "q", "追加授予（示例）", True, {}),
    ("option", 12, "q", "始终创业激励（示例 B）", True, {}),
    ("dola", 16, "q", "追加授予（示例 B）", True, {}),
    ("dola", 8, "m", "豆包股授予（示例 C）", True, {}),
]

ANCHOR_DAYS = [1, 15, 25]
NOTE = (
    "合成示例数据：仅借用「每月/每季 N 期、含修订、含拟授予」等抽象形状，"
    "日期、数量、标签均为随机生成，与任何真实授予无关。"
)


def add_months(d, n):
    y, m = divmod((d.year * 12 + d.month - 1) + n, 12)
    return date(y, m + 1, min(d.day, 28))


def allocate(total, weights):
    """按权重分配整数（最大余额法），保证合计 == total。"""
    s = sum(weights) or 1
    raw = [total * w / s for w in weights]
    out = [int(x) for x in raw]
    order = sorted(range(len(raw)), key=lambda i: raw[i] - out[i], reverse=True)
    for i in order[:total - sum(out)]:
        out[i] += 1
    return out


def make_award(rnd, cat, n, cadence, label, proposed, special, aid, grant):
    units = rnd.randrange(1200, 15000, 7) if cat == "dola" else rnd.randrange(60, 900, 3)
    weights = [rnd.uniform(0.6, 1.4) for _ in range(n)]
    if special.get("amended"):
        for i in range(n // 3, n):
            weights[i] *= rnd.uniform(0.15, 0.35)
    amounts = allocate(units, weights)

    if cadence == "once":
        dates = [grant]
    else:
        step = 1 if cadence == "m" else 3
        first = grant if rnd.random() < 0.5 else add_months(grant, step)
        dates = [add_months(first, step * i) + timedelta(days=rnd.randint(-2, 2)) for i in range(n)]
    if special.get("tight_pair") and len(dates) > 1:
        dates[1] = dates[0] + timedelta(days=rnd.choice([4, 5, 6]))

    award = {
        "label": label,
        "cat": cat,
        "units": sum(amounts),
        "grant": grant.isoformat(),
        "exp": add_months(grant, 120).isoformat(),
    }
    if proposed:
        award["proposed"] = True

    rows = [[dates[i].isoformat(), aid, cat, amounts[i], "ptranche" if proposed else "tranche"]
            for i in range(n)]
    orig_plan = {}
    if special.get("amended"):
        award["amended"] = "示例：契约修订后取消部分未归属单位，存续部分改按新节奏归属"
        for i, (d, amount) in enumerate(zip(dates, amounts)):
            if i < n // 3:
                continue
            planned = round(max(amount * rnd.uniform(1.8, 3.2), amount + 5), 2)
            orig_plan["%s|%s" % (aid, d.isoformat())] = planned
            if i == n // 3:                       # 用一条 cancel 记录演示"被取消"
                rows.append([d.isoformat(), aid, cat, int((planned - amount) * 0.7), "cancel"])
        # 授予总量包含已取消部分，存续归属量 = 授予总量 - 取消量。
        award["units"] += sum(row[3] for row in rows if row[4] == "cancel")
    return award, rows, orig_plan


def main():
    ap = argparse.ArgumentParser(description="合成脱敏 demo 数据（不转化真实数值）")
    ap.add_argument("--out", default="demo-data.json")
    ap.add_argument("--seed", type=int, default=2026)
    args = ap.parse_args()

    rnd = random.Random(args.seed)
    awards, tranches, order, orig_plan = {}, [], [], {}
    seq = {"dola": 0, "option": 0}

    for cat, n, cadence, label, proposed, special in SHAPES:
        seq[cat] += 1
        aid = "%s-%02d" % ("PHR" if cat == "dola" else "OPT", seq[cat])
        grant = date(rnd.randint(2024, 2026), rnd.randint(1, 12), rnd.choice(ANCHOR_DAYS))
        award, rows, op = make_award(rnd, cat, n, cadence, label, proposed, special, aid, grant)
        if any(r[0] < award["grant"] for r in rows if r[4] != "cancel"):
            continue
        awards[aid] = award
        order.append(aid)
        tranches.extend(rows)
        orig_plan.update(op)

    tranches.sort(key=lambda t: (t[0], t[1]))
    demo = {
        "generated_at": date.today().isoformat(),
        "note": NOTE,
        "prices": {"option": 120, "dola": 10},
        "awards": awards,
        "order": order,
        "tranches": tranches,
        "orig_plan": orig_plan,
    }
    json.dump(demo, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    kinds = {}
    for t in tranches:
        kinds[t[4]] = kinds.get(t[4], 0) + 1
    bad = [aid for aid, a in awards.items()
           if sum(t[3] for t in tranches if t[1] == aid) != a["units"]]
    print("写出 %s：授予 %d 笔（拟授予 %d 笔、含修订 %d 笔）、期次 %d 期 %s，校验 %s"
          % (args.out, len(awards),
             sum(1 for a in awards.values() if a.get("proposed")),
             sum(1 for a in awards.values() if a.get("amended")),
             len(tranches), kinds, "全部一致 ✓" if not bad else "不一致 ✗ %s" % bad))


if __name__ == "__main__":
    main()
