#!/usr/bin/env python3
"""解析授予记录 PDF，输出结构化数据（awards.json + 4 份 CSV + fulltext/）。

数据管线第一步：只做 PDF → 结构化，不产生任何可视化产物。

用法：
    python3 scripts/extract_from_pdfs.py --pdfs ~/awards_pdf --out .work [--txt-cache <dir>]

支持三类文书：
  - Dola Share Award Agreement（豆包股授予协议，文件名形如 GrantRecord_DLPS*.pdf）
  - Notice of Stock Option Award（期权授予通知，文件名形如 GrantRecord_ESOP*.pdf）
  - Deed of Amendment（契约修订，文件名形如 SigningRecord_*.pdf）
若输出目录里存在 system_award_list.csv（系统授予列表导出），会用来补充中文类型标签。

依赖：pypdf、pdfplumber（pip install pypdf pdfplumber）。
"""
import csv
import glob
import hashlib
import json
import os
import re

import pdfplumber
from pypdf import PdfReader

import argparse

SRC = TXT = OUT = ""   # 由 main() 用命令行参数填充


# --------------------------------------------------------------------------- helpers

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tight(s):
    return re.sub(r"\s+", " ", (s or "").replace("_", " ")).strip()


def squeeze(s):
    return re.sub(r"[\s_]+", "", s or "")


CJK = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"


def norm_text(s):
    """Normalise spacing: drop spaces inserted inside CJK runs and Latin words."""
    s = tight(s)
    s = re.sub(rf"(?<=[{CJK}])\s+(?=[{CJK}])", "", s)
    s = re.sub(r"(?<=[A-Za-z0-9@.])\s+(?=[A-Za-z0-9@.])", "", s) if "@" in s else s
    return s


def norm_address(s):
    """Addresses render with a space between every form-field character."""
    s = norm_text(s)
    s = re.sub(rf"(?<=[{CJK}])\s+(?=[0-9])", "", s)
    s = re.sub(rf"(?<=[0-9])\s+(?=[{CJK}])", "", s)
    return s


def value(s):
    """Clean a form-field value captured from the text layer."""
    if s is None:
        return None
    s = tight(s)
    if not s or squeeze(s).lower() in {"datesignhere", "n/a", ""}:
        return None
    return norm_text(s)


def int_of(s):
    return int(s.replace(",", "")) if s else None


def float_of(s):
    return float(s) if s else None


PAGE_RE = re.compile(r"^=== PAGE (\d+) ===$", re.M)


def dump_text(path):
    """Text layer of a PDF, with '=== PAGE n ===' markers (cached in TXT)."""
    os.makedirs(TXT, exist_ok=True)
    cached = os.path.join(TXT, os.path.basename(path) + ".txt")
    if os.path.exists(cached):
        return open(cached).read()
    parts = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            parts.append(f"\n=== PAGE {i} ===\n{page.extract_text() or ''}")
    text = "".join(parts)
    open(cached, "w").write(text)
    return text


def split_pages(text):
    marks = list(PAGE_RE.finditer(text))
    pages = {}
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        pages[int(m.group(1))] = text[m.end():end]
    return pages


HEADING_RE = re.compile(
    r"^\s*(?:(?:EXHIBIT|Exhibit|APPENDIX|Appendix|SCHEDULE|Schedule)\b[^\n]*"
    r"|(?:\d{1,2})\.\s+[A-Z][A-Za-z0-9 ,\-&/“”'()]{2,80}\.?)\s*$",
    re.M,
)


def section_index(pages):
    idx, seen = [], set()
    for pno in sorted(pages):
        for m in HEADING_RE.finditer(pages[pno]):
            head = tight(m.group(0)).rstrip(".")
            if len(head) > 100 or head in seen:
                continue
            seen.add(head)
            idx.append({"heading": head, "page": pno})
    return idx


def parse_ascii_tables(text):
    """These PDFs draw tables as literal ASCII art in the text layer."""
    lines = text.split("\n")
    tables, buf = [], []
    for line in lines:
        raw = line.rstrip()
        s = raw.strip()
        if s.startswith("+") and s.endswith("+") and set(s) <= set("+-"):
            buf.append(s)
            continue
        s = re.sub(r"\+[-+]+\+", "|", s)  # separators embedded inside a row
        if buf and s.startswith("|"):
            buf.append(s)
            continue
        if buf:
            tables.append(buf)
            buf = []
    if buf:
        tables.append(buf)
    out = []
    for tbl in tables:
        rows = []
        for line in tbl:
            if line.startswith("|"):
                rows.append([c.strip() or None for c in line.strip("|").split("|")])
        if rows:
            out.append(rows)
    return out


def prior_award_table(text):
    """Return {'columns': [...], 'rows': [...]} for the prior-award schedule."""
    for tbl in parse_ascii_tables(text):
        for row in tbl:
            if row and any(c and "Grant No" in c for c in row):
                header_idx = tbl.index(row)
                header = [c for c in tbl[header_idx] if c]
                body = []
                for r in tbl[header_idx + 1:]:
                    cells = [c for c in r if c]
                    if not cells:
                        continue
                    if any("Number of Units" in c for c in cells):
                        continue
                    body.append(cells)
                return {"columns": header, "rows": body}
    return None


def signature_fields(path):
    out = []
    reader = PdfReader(path)
    root = reader.trailer["/Root"]
    if "/AcroForm" in root:
        for f in root["/AcroForm"].get("/Fields", []):
            o = f.get_object()
            v = o.get("/V")
            d = v.get_object() if v is not None else {}
            out.append({
                "field_name": str(o.get("/T")),
                "field_type": str(o.get("/FT")),
                "signed_by": d.get("/Name"),
                "signing_time": d.get("/M"),
                "reason": d.get("/Reason"),
            })
    return out


# --------------------------------------------------------------------------- Dola

DOLA_VEST_RE = re.compile(r"(\d[\d,]*)\s*Dola\s*Shares\s*shall\s*time\s*vest\s*on\s*(\d{2}/\d{2}/\d{4})")


def parse_dola(text, pages, filename):
    p1, flat = pages.get(1, ""), squeeze(pages.get(1, ""))
    doc = {
        "document_type": "dola_share_award_agreement",
        "title": "BYTEDANCE LTD. — DOLA SHARE AWARD AGREEMENT",
        "participant": {}, "grant": {}, "vesting": {}, "signature_block": {}, "schedules": {},
    }

    m = re.search(r"\(the“Company”\)and(.+?)\(the", flat)
    if m:
        doc["participant"]["name"] = value(m.group(1))

    m = re.search(r"([\d,]+)DolaShares,eachofwhich", flat)
    if m:
        doc["grant"]["number_of_dola_shares"] = int_of(m.group(1))
    # the Staff-ID value sits on the line after the share count
    lines = [l for l in p1.split("\n") if l.strip()]
    numeric = [squeeze(l) for l in lines if squeeze(l).isdigit()]
    if numeric:
        doc["grant"]["staff_id"] = numeric[0]
    m = re.search(r"GrantDate:(\d{2}/\d{2}/\d{4})VestingCommencementDate:(\d{2}/\d{2}/\d{4})", flat)
    if m:
        doc["grant"]["grant_date"], doc["grant"]["vesting_commencement_date"] = m.group(1), m.group(2)

    doc["grant"]["award_number"] = filename.split("_")[1].replace(".pdf", "")
    doc["grant"]["award_number_source"] = "file name (the Dola award agreement itself carries no award number)"
    doc["grant"]["instrument"] = ("Dola Shares — phantom shares over the BU, granted under the Bytedance Ltd. "
                                  "Amended and Restated 2012 Stock Incentive Plan")
    doc["grant"]["expiration_date_rule"] = ("Earlier of (i) the date on which settlement of all vested Dola Shares "
                                            "granted occurs or (ii) the 7-year anniversary of the Grant Date.")
    doc["grant"]["agreement_signature_date_field"] = None
    doc["grant"]["agreement_signature_date_note"] = "the agreement carries a 'DateSignHere' placeholder with no value"

    whole = squeeze(text)
    flow = tight(PAGE_RE.sub(" ", text))  # keeps word spacing, drops page markers
    sched = [{"date": m.group(2), "shares": int_of(m.group(1))} for m in DOLA_VEST_RE.finditer(whole)]
    doc["vesting"]["time_vesting_schedule"] = sched
    doc["vesting"]["form"] = "absolute share tranches"
    doc["vesting"]["vesting_basis"] = "Continuous BU Service"
    doc["vesting"]["time_vesting_total"] = sum(x["shares"] for x in sched)
    doc["vesting"]["time_vesting_matches_grant"] = doc["vesting"]["time_vesting_total"] == doc["grant"].get("number_of_dola_shares")
    doc["vesting"]["time_based_condition"] = "The Dola Shares time-vest in accordance with the schedule above, subject to Continuous BU Service through each vesting date."

    m = re.search(r"2\. Performance-Based Condition: (.*?)Dola Shares will only vest", flow)
    if m:
        doc["vesting"]["performance_based_condition"] = value(m.group(1))
    m = re.search(r"“BU Break-Even Event” shall mean (.*?) For the purpose", flow)
    if m:
        doc["vesting"]["bu_break_even_event_definition"] = value(m.group(1)).rstrip(".") + "."
    m = re.search(r"“BU” means (.+?); and", flow)
    if m:
        doc["vesting"]["bu_definition"] = value(m.group(1))
    m = re.search(r"“Eligible Group” means (.*?)(?:For the avoidance of doubt, the Committee)", flow)
    if m:
        doc["vesting"]["eligible_group"] = value(m.group(1)).rstrip(".")
    m = re.search(r"“Continuous BU Service” means (.*?);", flow)
    if m:
        doc["vesting"]["continuous_bu_service"] = value(m.group(1))
    doc["vesting"]["dual_condition"] = ("Dola Shares vest only if both the Time-Based Condition and the "
                                        "Performance-Based Condition are satisfied on or before the Expiration Date.")
    doc["vesting"]["value_per_dola_share"] = ("Determined by the Committee in its reasonable discretion based on the "
                                              "then fair value of the BU as of the applicable determination date.")
    doc["vesting"]["settlement"] = "Section 3 of the Terms and Conditions (may be settled in BD Shares, depositary shares or, at the Company's discretion, cash)."

    # signature block on page 4
    p4 = tight(pages.get(4, ""))
    sig = {}
    if re.search(r"Name:\s*Rubo Liang", p4):
        sig["company"] = {"entity": "Bytedance Ltd.", "signatory": "Rubo Liang",
                          "title": "Authorized Signatory", "date": None}
    participant = re.search(r"Name:\s*([A-Za-z\u4e00-\u9fff ]{1,30}?)\s+(?=(?:Title|Address):)", p4)
    addr = re.search(r"Address:\s*(.+?)(?:\s+\d{1,3})?\s*$", p4)
    sig["participant"] = {
        "name": value(participant.group(1)) if participant else None,
        "address": norm_address(addr.group(1)) if addr else None,
        "date": None,
        "note": "signature lines are blank in the unsigned record",
    }
    doc["signature_block"] = sig

    tbl = prior_award_table(text)
    if tbl:
        doc["schedules"]["list_of_prior_award_agreements"] = tbl
    return doc


# --------------------------------------------------------------------------- ESOP

ESOP_VEST_SHARES_RE = re.compile(
    r"(\d[\d,]*)\s*Shares\s*subject\s*to\s*the\s*Option\s*shall\s*vest\s*on\s*(\d{2}/\d{2}/\d{4})")
ESOP_VEST_PCT_RE = re.compile(
    r"(\d+(?:\.\d+)?)%\s*(\d{1,2})(?:st|nd|rd|th)\s*Month\*?\s*following\s*the\s*Vesting\s*Commencement\s*Date")


def parse_esop(text, pages, filename):
    p1 = pages.get(1, "")
    flat = squeeze(p1)
    doc = {
        "document_type": "stock_option_award",
        "title": "BYTEDANCE LTD. — NOTICE OF STOCK OPTION AWARD (Amended and Restated 2012 Stock Incentive Plan)",
        "participant": {}, "grant": {}, "vesting": {}, "signature_block": {}, "schedules": {},
    }
    m = re.search(r"Name(.+?)ResidenceAddress(.+?)MobileNumber(.+?)EmailAddress(.+?)You\(the", flat)
    if m:
        doc["participant"] = {
            "name": value(m.group(1)),
            "residence_address": value(m.group(2)),
            "mobile_number": value(m.group(3)),
            "email_address": value(m.group(4)),
        }
    m = re.search(r"AwardNumber(.+?)GrantDate(\d{2}/\d{2}/\d{4})", flat)
    if m:
        doc["grant"]["award_number"] = value(m.group(1))
        doc["grant"]["grant_date"] = m.group(2)
    m = re.search(r"GrantDate\d{2}/\d{2}/\d{4}(\d{2}/\d{2}/\d{4})VestingCommencementDate", flat) \
        or re.search(r"VestingCommencementDate(\d{2}/\d{2}/\d{4})", flat)
    if m:
        doc["grant"]["vesting_commencement_date"] = m.group(1)
    m = re.search(r"ExercisePriceperShareUS\$([\d.]+)", flat)
    if m:
        doc["grant"]["exercise_price_per_share_usd"] = float_of(m.group(1))
    m = re.search(r"TotalNumberofShares([\d,]+)SubjecttotheOption", flat) or re.search(r"SubjecttotheOption([\d,]+)", flat)
    if m:
        doc["grant"]["total_shares_subject_to_option"] = int_of(m.group(1))
    m = re.search(r"TotalExercisePriceUS\$([\d.]+)", flat)
    if m:
        doc["grant"]["total_exercise_price_usd"] = float_of(m.group(1))
    m = re.search(r"ExpirationDate:(\d{2}/\d{2}/\d{4})", flat)
    if m:
        doc["grant"]["expiration_date"] = m.group(1)
    m = re.search(r"Post-TerminationExercisePeriod:(.+?)VestingSchedule:", flat)
    if m:
        doc["grant"]["post_termination_exercise_period"] = value(m.group(1))
    doc["grant"]["instrument"] = "Option over Class A ordinary shares (or securities representing economic interests in them)"

    shares_sched = [{"date": m.group(2), "shares": int_of(m.group(1))}
                    for m in ESOP_VEST_SHARES_RE.finditer(squeeze(text))]
    pct_sched = [{"month_after_vesting_commencement": int(m.group(2)), "percentage": float(m.group(1))}
                 for m in ESOP_VEST_PCT_RE.finditer(squeeze(text))]
    if shares_sched:
        doc["vesting"] = {
            "form": "absolute share tranches",
            "time_vesting_schedule": shares_sched,
            "time_vesting_total": sum(x["shares"] for x in shares_sched),
            "time_vesting_matches_grant": sum(x["shares"] for x in shares_sched) == doc["grant"].get("total_shares_subject_to_option"),
        }
    if pct_sched:
        doc["vesting"] = {
            "form": "percentage of the Option vesting in the Nth month after the Vesting Commencement Date",
            "time_vesting_schedule": pct_sched,
            "schedule_total_percentage": round(sum(x["percentage"] for x in pct_sched), 6),
        }
    doc["vesting"]["vesting_basis"] = ("Continuous Service" if re.search(r"continuousemploymentservice", squeeze(p1)) else "Continuous BU Service")

    doc["signature_block"] = {"grantee": {"signature": None, "date": None,
                                          "note": "the record ends with a blank 'Signature of Grantee: / Date:' block"}}

    tbl = prior_award_table(text)
    if tbl:
        doc["schedules"]["list_of_prior_award_agreements"] = tbl

    m = re.search(r"EXHIBITB(.*?)INVESTMENTREPRESENTATIONSTATEMENT(.*?)(?:1\.|Inconnectionwiththepurchase)", squeeze(text), re.S)
    if m:
        block = m.group(2)
        fields = {}
        for label in ["GRANTEE", "COMPANY", "SECURITY", "AMOUNT", "DATE"]:
            mm = re.search(label + r":([^:]{0,80}?)(?=[A-Z]{4,}|$)", block)
            fields[label.lower()] = value(mm.group(1)) if mm else None
        doc["schedules"]["exhibit_b_investment_representation"] = fields
    if "EXERCISENOTICE" in squeeze(text):
        doc["schedules"]["exhibit_a"] = "Exercise Notice (blank form; effective-date line and grantee signature left blank)"
    return doc


# --------------------------------------------------------------------------- Deed

DEED_CLAUSE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\.\s+([A-Z][^.\n]{2,70}\.)", re.M)


def parse_deed(text, pages, path, filename):
    doc = {
        "document_type": "deed_of_amendment",
        "title": "DEED OF AMENDMENT — cancellation of part of the awards and amendment of the Award Agreement(s)",
        "parties": {}, "effective_date": None, "recitals": [], "clauses": [],
        "signatures": [], "schedules": {},
    }
    p1 = tight(pages.get(1, ""))
    m = re.search(r"between Bytedance Ltd\.,(.+?)\(the “Company”\), and (.+?)\(the “Grantee”\), effective as of (.+?)\(the “Effective Date”\)", p1, re.S)
    if m:
        doc["parties"]["company"] = "Bytedance Ltd., an exempted company formed under the laws of the Cayman Islands"
        doc["parties"]["grantee"] = value(m.group(2))
        doc["effective_date"] = squeeze(m.group(3))
    for m in re.finditer(r"WHEREAS,(.+?)(?:;\s*and|;?\s*NOW,)", p1, re.S):
        doc["recitals"].append(tight(m.group(1)))

    seen_clause = set()
    for pno in sorted(pages):
        for m in DEED_CLAUSE_RE.finditer(pages[pno]):
            num, title = m.group(1), tight(m.group(2))
            if num in seen_clause or "with respect to" in title.lower():
                continue
            seen_clause.add(num)
            doc["clauses"].append({"number": num, "heading": title.rstrip(".") + ".", "page": pno})

    # Schedule 1 — cancelled awards
    s1 = re.search(r"Details of Cancelled Awards(.+)", text, re.S)
    if s1:
        body = s1.group(1)
        rows = []
        for m in re.finditer(r"\|\s*(\d{2}/\d{2}/\d{4})\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|", body):
            rows.append({"grant_date": m.group(1), "grant_no": m.group(2), "award_type": m.group(3),
                         "cancelled_time_unvested_awards": int(m.group(4)),
                         "surviving_time_unvested_awards": int(m.group(5))})
        total = re.search(r"\|\s*Total\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|", body)
        doc["schedules"]["schedule_1_details_of_cancelled_awards"] = {
            "rows": rows,
            "total_cancelled": int(total.group(1)) if total else None,
            "total_surviving": int(total.group(2)) if total else None,
        }

    # Schedule 2 — amended vesting
    s2 = re.search(r"Schedule 2\s*Amended Time-vesting Schedule(.+)", text, re.S)
    if s2:
        block = tight(s2.group(1))
        tranches = [{"units": int_of(m.group(1)), "date": m.group(2)}
                    for m in re.finditer(r"(\d[\d,]*)\s*units shall time vest on (\d{2}/\d{2}/\d{4})", block)]
        g = re.search(r"Grant No \[?(\w+)\]?", block)
        doc["schedules"]["schedule_2_amended_time_vesting_schedule"] = {
            "grant_no": g.group(1) if g else None,
            "tranches": tranches,
            "tranche_total": sum(t["units"] for t in tranches),
            "text": block,
        }

    # signatures: map each signing widget to its role by matching the widget position
    # against the on-page placeholder labels (PleaseSignHere / WitnessSignHere / CompanySignHere)
    reader = PdfReader(path)
    page = reader.pages[4]
    height = float(page.mediabox.height)
    widgets = []
    for annot in page.get("/Annots") or []:
        o = annot.get_object()
        if str(o.get("/Subtype")) != "/Widget":
            continue
        rect = [float(x) for x in o.get("/Rect")]
        val = o.get("/V")
        d = val.get_object() if val is not None else {}
        widgets.append({
            "field_name": str(o.get("/T")),
            "top": height - rect[3],
            "x0": rect[0],
            "signed_by": d.get("/Name"),
            "signing_time": d.get("/M"),
            "reason": d.get("/Reason"),
        })
    with pdfplumber.open(path) as pdf:
        words = pdf.pages[4].extract_words()
    labels = {w["text"]: (w["top"], w["x0"]) for w in words
              if w["text"] in {"PleaseSignHere", "WitnessSignHere", "CompanySignHere"}}
    label_roles = {"PleaseSignHere": "Grantee", "WitnessSignHere": "Witness", "CompanySignHere": "Company"}
    for wd in sorted(widgets, key=lambda x: x["top"]):
        best, best_dist = None, 9e9
        for label, role in label_roles.items():
            pos = labels.get(label)
            if not pos:
                continue
            dist = abs(pos[0] - wd["top"])
            if dist < best_dist:
                best, best_dist = role, dist
        doc["signatures"].append({
            "role": best,
            "signed_by": wd["signed_by"],
            "signing_time": wd["signing_time"],
            "reason": wd["reason"],
            "field_name": wd["field_name"],
        })
    doc["signature_block"] = {
        "company": {"entity": "Bytedance Ltd.", "signatory": "Rubo Liang", "title": "Authorized Signatory"},
        "grantee": value(doc["parties"].get("grantee")),
        "witness": next((s["signed_by"] for s in doc["signatures"] if s["role"] == "Witness"), None),
    }
    return doc


# --------------------------------------------------------------------------- main

def flatten_award(doc):
    g, p, v = doc.get("grant", {}), doc.get("participant", {}), doc.get("vesting", {})
    sig = doc.get("signature_block", {})
    address = p.get("residence_address") or (sig.get("participant") or {}).get("address") if isinstance(sig.get("participant"), dict) else p.get("residence_address")
    return {
        "file_name": doc["source"]["file_name"],
        "document_type": doc["document_type"],
        "award_number": g.get("award_number"),
        "instrument": "Dola Share" if doc["document_type"] == "dola_share_award_agreement" else ("Option" if doc["document_type"] == "stock_option_award" else None),
        "participant_name": p.get("name") or doc.get("parties", {}).get("grantee"),
        "staff_id": g.get("staff_id"),
        "email_address": p.get("email_address"),
        "residence_address": address,
        "grant_date": g.get("grant_date"),
        "vesting_commencement_date": g.get("vesting_commencement_date"),
        "expiration_date": g.get("expiration_date") or g.get("expiration_date_rule"),
        "units_granted": g.get("number_of_dola_shares") or g.get("total_shares_subject_to_option"),
        "exercise_price_per_share_usd": g.get("exercise_price_per_share_usd"),
        "total_exercise_price_usd": g.get("total_exercise_price_usd"),
        "post_termination_exercise_period": g.get("post_termination_exercise_period"),
        "vesting_form": v.get("form"),
        "vesting_tranches": len(v.get("time_vesting_schedule") or []),
        "source_pages": doc["source"]["pages"],
        "source_sha256": doc["source"]["sha256"],
    }


def main():
    ap = argparse.ArgumentParser(description="解析授予记录 PDF → 结构化数据")
    ap.add_argument("--pdfs", required=True, help="存放授予记录 PDF 的目录")
    ap.add_argument("--out", required=True, help="输出目录（awards.json / CSV / fulltext 写到这里）")
    ap.add_argument("--txt-cache", help="文本层缓存目录（默认 <out>/.textcache）")
    args = ap.parse_args()

    global SRC, TXT, OUT
    SRC, OUT = os.path.abspath(args.pdfs), os.path.abspath(args.out)
    TXT = os.path.abspath(args.txt_cache) if args.txt_cache else os.path.join(OUT, ".textcache")
    os.makedirs(TXT, exist_ok=True)
    print("读取 PDF 目录：%s" % SRC)
    print("输出目录：%s" % OUT)
    _run()


def _run():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, "fulltext"), exist_ok=True)
    docs = []
    for path in sorted(glob.glob(os.path.join(SRC, "*.pdf"))):
        name = os.path.basename(path)
        if name.startswith("._"):
            continue
        text = dump_text(path)
        open(os.path.join(OUT, "fulltext", name + ".txt"), "w").write(text)
        pages = split_pages(text)
        with pdfplumber.open(path) as pdf:
            npages = len(pdf.pages)
            box = pdf.pages[0].mediabox
            size = [float(box[2] - box[0]), float(box[3] - box[1])]
        if name.startswith("GrantRecord_DLPS"):
            body = parse_dola(text, pages, name)
        elif name.startswith("GrantRecord_ESOP"):
            body = parse_esop(text, pages, name)
        else:
            if not name.startswith("SigningRecord"):
                print("  警告：无法识别的文书类型，按契约修订解析：%s（建议按 GrantRecord_DLPS*.pdf / "
                      "GrantRecord_ESOP*.pdf / SigningRecord*.pdf 命名）" % name)
            body = parse_deed(text, pages, path, name)
        body["source"] = {
            "file_name": name,
            "path": path,
            "sha256": sha256(path),
            "bytes": os.path.getsize(path),
            "pages": npages,
            "page_size_pt": size,
            "pdf_metadata": dict(PdfReader(path).metadata or {}),
            "full_text_file": f"fulltext/{name}.txt",
            "full_text_chars": len(text),
        }
        body["section_index"] = section_index(pages)
        if not body.get("signatures"):
            body["digital_signature_fields"] = signature_fields(path)
        docs.append(body)
        print("parsed", name)

    payload = {
        "source_directory": SRC,
        "document_count": len(docs),
        "extraction_notes": [
            "All PDFs have a real text layer; no OCR was required.",
            "Tables are rendered as literal ASCII art inside the text layer, so they were parsed from text.",
            "Dola award agreements do not carry an award number internally; the number is taken from the file name "
            "and can be corroborated by the 'List of Prior Award Agreements' schedule that later records carry.",
            "Form-field values were captured with underscores removed and internal CJK spacing normalised.",
        ],
        "documents": docs,
    }

    # attach the Chinese award labels shown in the system UI, when the transcription exists
    syscsv = os.path.join(OUT, "system_award_list.csv")
    if os.path.exists(syscsv):
        labels = {r["matched_award_number"]: r for r in csv.DictReader(open(syscsv))
                  if r.get("matched_award_number")}
        for d in docs:
            num = d.get("grant", {}).get("award_number")
            r = labels.get(num)
            if r:
                d["system_metadata"] = {
                    "award_label_zh": r["award_label_zh"],
                    "category": r["category"],
                    "status": r["status"],
                    "progress_pct": int(r["progress_pct"] or 0),
                    "next_vest_date": r["next_vest_date"] or None,
                    "next_vest_units": int(r["next_vest_units"]) if r["next_vest_units"] else None,
                    "unvested_cancelled": int(r["unvested_cancelled"] or 0),
                    "vesting_by_year": {y: int(r[f"year_{y}"]) for y in (2025, 2026, 2027, 2028)
                                        if r.get(f"year_{y}")},
                }

    json.dump(payload, open(os.path.join(OUT, "awards.json"), "w"), ensure_ascii=False, indent=2)

    # ---------------- CSVs ----------------
    awards = [flatten_award(d) for d in docs if d["document_type"] != "deed_of_amendment"]
    for a, d in zip(awards, [x for x in docs if x["document_type"] != "deed_of_amendment"]):
        a["system_label_zh"] = (d.get("system_metadata") or {}).get("award_label_zh")
        a["system_status"] = (d.get("system_metadata") or {}).get("status")
    with open(os.path.join(OUT, "awards_summary.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(awards[0].keys()))
        w.writeheader()
        w.writerows(awards)

    with open(os.path.join(OUT, "vesting_schedule.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["source_file", "award_number", "instrument", "tranche_index", "vesting_date",
                    "units_vesting", "percentage", "months_after_vesting_commencement"])
        for d in docs:
            v = d.get("vesting") or {}
            for i, t in enumerate(v.get("time_vesting_schedule") or [], 1):
                w.writerow([d["source"]["file_name"], d.get("grant", {}).get("award_number"),
                            flatten_award(d)["instrument"], i, t.get("date") or "",
                            t.get("shares") or "", t.get("percentage") or "",
                            t.get("month_after_vesting_commencement") or ""])

    with open(os.path.join(OUT, "prior_awards.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["source_file", "row_index", "type", "grant_no", "grant_date", "units_granted_originally", "raw_cells"])
        for d in docs:
            tbl = (d.get("schedules") or {}).get("list_of_prior_award_agreements")
            if not tbl:
                continue
            for i, r in enumerate(tbl["rows"], 1):
                cells = (r + [None] * 4)[:4]
                w.writerow([d["source"]["file_name"], i, cells[0], cells[1], cells[2], cells[3], " | ".join(x or "" for x in r)])

    with open(os.path.join(OUT, "signatures.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["source_file", "context", "role", "signed_by", "signing_time", "reason_or_note"])
        for d in docs:
            for s in d.get("signatures") or []:
                w.writerow([d["source"]["file_name"], "deed of amendment", s["role"], s["signed_by"],
                            s["signing_time"], s.get("reason")])
            for sf in d.get("digital_signature_fields") or []:
                w.writerow([d["source"]["file_name"], "award agreement", "signature field",
                            sf.get("signed_by"), sf.get("signing_time"), "no value (unsigned record)"])
            sb = d.get("signature_block") or {}
            for role, blk in sb.items():
                if isinstance(blk, dict):
                    w.writerow([d["source"]["file_name"], "execution block", role,
                                blk.get("signatory") or blk.get("name"), blk.get("date"), blk.get("note", "")])
    print("wrote JSON + 4 CSVs")
    return docs


if __name__ == "__main__":
    main()
