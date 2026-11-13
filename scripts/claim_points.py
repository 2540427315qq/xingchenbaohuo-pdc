# -*- coding: utf-8 -*-
"""teleagent-dashboard 积分领取脚本（UIA COM Invoke 通道，2026-11-13 实测验证）

流程：找主窗口 → 关更新通知 → 打开账户菜单 → 读积分状态 → 领取/确认已领 → 复核
输出：最后一行 RESULT: {json}（status: claimed / already_claimed / failed_*）
依赖：uiautomation comtypes pywin32（本机已装）
"""
import json
import re
import sys
import time

sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.dont_write_bytecode = True

try:
    import uiautomation as auto
    import comtypes.gen.UIAutomationClient as UIAC
except Exception as e:
    print("RESULT: " + json.dumps({"status": "failed_dep", "error": str(e)}))
    sys.exit(2)

MAIN_KEY = "星辰超级智能体"
KW_MENU = ("积分", "福利", "领取", "已领", "签到", "累计", "账户", "个人", "天数", "余额")
INVOKE_ID = 10000

result = {"status": "failed_unknown", "days": None, "total": None, "balance": None, "verified": False}


def find_window():
    for w in auto.GetRootControl().GetChildren():
        try:
            if w.Name and MAIN_KEY in w.Name:
                return w
        except Exception:
            pass
    return None


def walk_all(el, depth=0):
    if depth > 40:
        return
    try:
        kids = el.GetChildren()
    except Exception:
        return
    for k in kids:
        yield k
        yield from walk_all(k, depth + 1)


def find_by_name(root, name):
    for el in walk_all(root):
        try:
            if (el.Name or "") == name:
                return el
        except Exception:
            pass
    return None


def com_invoke(ctrl):
    el = ctrl.Element
    pat = el.GetCurrentPattern(INVOKE_ID)
    if not pat:
        return False
    pat.QueryInterface(UIAC.IUIAutomationInvokePattern).Invoke()
    return True


def menu_hits(win):
    hits = []
    for el in walk_all(win):
        try:
            n = el.Name or ""
        except Exception:
            continue
        if n and any(kw in n for kw in KW_MENU):
            try:
                r = el.BoundingRectangle
                hits.append((el, n, (r.left, r.top, r.right, r.bottom)))
            except Exception:
                hits.append((el, n, None))
    return hits


def read_menu_numbers(win):
    """从菜单读余额/已领天数/累计（同排数值控件启发式）"""
    nums = []
    for el in walk_all(win):
        try:
            n = (el.Name or "").strip()
        except Exception:
            continue
        if re.fullmatch(r"[\d,]+\.?\d*", n):
            try:
                r = el.BoundingRectangle
                nums.append((n, (r.left, r.top, r.right, r.bottom)))
            except Exception:
                pass
    return nums


def open_account_menu(win):
    """打开左下角账户菜单：头像文本的父级 GroupControl Invoke（实测有效）"""
    # 1) 已开？菜单有关键词即视为打开
    if menu_hits(win):
        return True
    # 2) 找左下角头像（单字符文本控件，位于窗口底部）
    try:
        wr = win.BoundingRectangle
        bottom_strip = (wr.bottom - int((wr.bottom - wr.top) * 0.12), wr.bottom)
        cands = []
        for el in walk_all(win):
            try:
                n = el.Name or ""
                r = el.BoundingRectangle
            except Exception:
                continue
            if n and len(n) <= 2 and bottom_strip[0] <= r.top < wr.bottom and r.left < wr.left + 120:
                if el.ControlTypeName == "TextControl":
                    cands.append(el)
        for avatar in cands:
            chain = []
            p = avatar
            for _ in range(4):
                try:
                    p = p.GetParentControl()
                except Exception:
                    break
                if p is None:
                    break
                chain.append(p)
            for ctrl in chain:
                try:
                    if com_invoke(ctrl):
                        time.sleep(1.5)
                        w2 = find_window()
                        if w2 and menu_hits(w2):
                            return True
                except Exception:
                    pass
    except Exception:
        pass
    return False


def parse_state(win):
    """读积分菜单数值：积分余额/已领天数/累计"""
    hits = {n: r for _, n, r in menu_hits(win)}
    nums = read_menu_numbers(win)
    balance = days = total = None
    # 余额：与「积分余额」同行、在其右侧的数值
    base = hits.get("积分余额")
    if base:
        for n, r in nums:
            if r and abs(r[1] - base[1]) < 12 and r[0] > base[2]:
                balance = n
                break
    # 已领 X 天 / 累计 X
    text_all = [n for _, n, _ in menu_hits(win)]
    for i, n in enumerate(text_all):
        if n.startswith("已领"):
            m = re.search(r"(\d+)", n + "".join(text_all[i + 1:i + 3]))
            if m:
                days = m.group(1)
        if n.startswith("累计"):
            for nn, _r in nums:
                m = re.search(r"\d+", nn)
                if m:
                    total = m.group(0)
                    break
    return balance, days, total


def main():
    win = find_window()
    if not win:
        result["status"] = "failed_no_window"
        return
    # 更新通知（若在屏上则关闭，避免遮挡）
    ign = find_by_name(win, "忽略")
    if ign:
        try:
            com_invoke(ign)
            time.sleep(1.2)
            win = find_window() or win
        except Exception:
            pass
    # 打开账户菜单
    if not open_account_menu(win):
        result["status"] = "failed_open_menu"
        return
    win = find_window()
    balance, days, total = parse_state(win)
    result.update({"days": days, "total": total, "balance": balance})
    # 判断领取按钮
    btn = find_by_name(win, "立即领取")
    if not btn:
        if find_by_name(win, "今日已领"):
            result["status"] = "already_claimed"
            return
        result["status"] = "failed_missing_button"
        return
    # 点击领取
    try:
        if not com_invoke(btn):
            result["status"] = "failed_invoke"
            return
    except Exception as e:
        result["status"] = "failed_invoke"
        result["error"] = str(e)
        return
    time.sleep(2.5)
    # 复核：重新打开菜单看「今日已领」
    w2 = find_window()
    if w2 and open_account_menu(w2):
        w2 = find_window()
        if find_by_name(w2, "今日已领"):
            result["status"] = "claimed"
            result["verified"] = True
            b2, d2, t2 = parse_state(w2)
            result.update({"days": d2 or days, "total": t2 or total, "balance": b2 or balance})
            return
    result["status"] = "failed_verify"


try:
    main()
except Exception as e:
    result["status"] = "failed_exception"
    result["error"] = str(e)

print("RESULT: " + json.dumps(result, ensure_ascii=False))
