#!/usr/bin/env python3
"""把结构化授予数据转换成可视化用的数据文件（timeline JSON）。

输入（都可来自你自己的私有数据源，本脚本不含任何真实数据）：
  --awards   awards.json        结构化授予数据，形如：
              {"documents": [
                 {"document_type": "stock_option_award" | "dola_share_award_agreement" | "deed_of_amendment",
                  "grant": {"award_number": ..., "grant_date": "MM/DD/YYYY", "vesting_commencement_date": ...,
                            "expiration_date".. | "expiration_date_rule".., "total_shares_subject_to_option"|"number_of_dola_shares"..},
                  "vesting": {"time_vesting_schedule": [{"date": "MM/DD/YYYY", "shares": N} | {"month_after_vesting_commencement": M, "percentage": P}]},
                  "schedules": {"schedule_1_details_of_cancelled_awards": {...},
                                "schedule_2_amended_time_vesting_schedule": {"tranches": [{"date": "MM/DD/YYYY", "units": N}]}}}]}
  --proposed  拟授予逐期明细 CSV（列：award_number, category, award_type, grant_date, expiration_date, units_granted,
              tranche_index, vesting_date, planned_units）
  --labels    系统页面导出的授予列表 CSV（列含 award_label_zh, grand_date, units, status, matched_award_number）
  --out       输出文件路径

输出格式见 README.md「数据格式」一节。
"""
import argparse
import csv
import json
from datetime import date


def iso(mm_dd_yyyy):
    m, d, y = mm_dd_yyyy.split("/")
    return f"{y}-{m}-{d}"


def pdate(mm_dd_yyyy):
    m, d, y = (int(x) for x in mm_dd_yyyy.split("/"))
    return date(y, m, d)


def month_offset(vcd, months, day_cap=28):
    y = vcd.year + (vcd.month - 1 + months) // 12
    m = (vcd.month - 1 + months) % 12 + 1
    return date(y, m, min(vcd.day, day_cap))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--awards", required=True)
    ap.add_argument("--proposed")
    ap.add_argument("--labels")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    docs = json.load(open(args.awards))["documents"]
    labels = {}
    if args.labels:
        for r in csv.DictReader(open(args.labels)):
            if r.get("matched_award_number"):
                labels[r["matched_award_number"]] = r

    awards, tranches, orig_plan, order = {}, [], {}, []
    deed = next((d for d in docs if d["document_type"] == "deed_of_amendment"), None)
    s1 = (deed or {}).get("schedules", {}).get("schedule_1_details_of_cancelled_awards")
    s2 = (deed or {}).get("schedules", {}).get("schedule_2_amended_time_vesting_schedule")
    effective = iso(deed["effective_date"]) if deed and deed.get("effective_date") else None
    amended_award = None
    if s1 and s2:
        amended_award = s2.get("grant_no")

    for doc in docs:
        g, v = doc.get("grant", {}), doc.get("vesting", {})
        aid = g.get("award_number")
        if not aid:                      # 契约修订文档没有授予编号
            continue
        cat = "dola" if doc["document_type"] == "dola_share_award_agreement" else "option"
        units = g.get("number_of_dola_shares") or g.get("total_shares_subject_to_option")
        row = labels.get(aid, {})
        awards[aid] = {
            # 中文类型标签优先取系统导出（system_award_list.csv）；没有就按类别给个中性名称
            "label": row.get("award_label_zh") or ("豆包股授予" if cat == "dola" else "期权授予"),
            "cat": cat,
            "units": units,
            "grant": iso(g["grant_date"]),
        }
        if g.get("expiration_date"):
            awards[aid]["exp"] = iso(g["expiration_date"])
        if doc.get("system_metadata", {}).get("status") == "拟授予":
            awards[aid]["proposed"] = True
        order.append(aid)

        sched = v.get("time_vesting_schedule") or []
        if sched and "date" in sched[0]:
            for t in sched:
                tranches.append([iso(t["date"]), aid, cat, t["shares"], "tranche"])
        elif sched and "month_after_vesting_commencement" in sched[0]:
            # 百分比表：按累计取整（与系统口径一致）；被契约修订覆盖的期次跳过，
            # 但生效日之前已经归属的历史期次必须保留。
            vcd = pdate(g["vesting_commencement_date"])
            cum = prev = 0.0
            for t in sched:
                cum += units * t["percentage"] / 100
                d = month_offset(vcd, t["month_after_vesting_commencement"])
                floor_delta = int(cum) - int(prev)
                prev = cum
                if amended_award == aid and s2:
                    if effective and d.isoformat() <= effective:
                        tranches.append([d.isoformat(), aid, cat, floor_delta, "tranche"])
                    elif effective:
                        # 该期被契约修订覆盖：记录"原计划额度"，供页面画灰顶分片（被取消部分）
                        orig_plan["%s|%s" % (aid, d.isoformat())] = round(units * t["percentage"] / 100, 2)
                    continue
                tranches.append([d.isoformat(), aid, cat, floor_delta, "tranche"])

    if amended_award and s1 and s2:
        a = awards[amended_award]
        for t in s2["tranches"]:
            tranches.append([iso(t["date"]), amended_award, a["cat"], t["units"], "tranche"])
        if effective and s1.get("total_cancelled"):
            tranches.append([effective, amended_award, a["cat"], s1["total_cancelled"], "cancel"])
        a["amended"] = (f"契约修订（{effective} 生效）：未归属的 "
                        f"{s1['total_cancelled'] + s1['total_surviving']} 股中取消 {s1['total_cancelled']} 股、"
                        f"存续 {s1['total_surviving']} 股并改按新节奏归属")

    if args.proposed:
        seen = set()
        for r in csv.DictReader(open(args.proposed)):
            aid = r["award_number"]
            if aid not in seen:
                seen.add(aid)
                awards[aid] = {
                    "label": r["award_type"], "cat": r["category"], "units": int(r["units_granted"]),
                    "grant": r["grant_date"], "exp": r["expiration_date"], "proposed": True,
                }
                order.append(aid)
            tranches.append([r["vesting_date"], aid, r["category"], int(r["planned_units"]), "ptranche"])

    tranches.sort(key=lambda t: (t[0], t[1]))
    json.dump({"as_of": date.today().isoformat(), "awards": awards, "order": order,
               "tranches": tranches, "orig_plan": orig_plan},
              open(args.out, "w"), ensure_ascii=False, indent=2)
    print(f"写出 {args.out}：授予 {len(awards)} 笔，期次 {len(tranches)} 期")


if __name__ == "__main__":
    main()
