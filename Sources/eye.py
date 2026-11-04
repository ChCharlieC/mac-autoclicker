"""AutoClicker 的"眼睛"：独立的图像识别进程。

由主程序（AutoClicker.js）用 NSTask 启动，三种用法：

  python3 eye.py run <配置文件> <结果文件> <主程序 PID>
      按配置的频率（默认每秒 4 次）截取扫描范围，在里面找每一张图片，把结果写进结果文件。
      配置文件变化（修改时间变了）就重新读取；主程序退出后自动结束。

  python3 eye.py grab <x> <y> <宽> <高> <输出 PNG>
      截取一块屏幕区域保存成图片（取样用），成功时 stdout 输出一行 JSON。

  python3 eye.py import <图片路径> <输出 PNG>
      把用户上传的图片转成 PNG 保存，成功时 stdout 输出一行 JSON。

  python3 eye.py check
      检查依赖是否齐全，stdout 输出一行 JSON。

坐标约定：全部使用"点"（point）为单位、左上角为原点的全局屏幕坐标，和主程序发送鼠标点击用的
CoreGraphics 坐标一致。Retina 屏截图的像素数是点数的 2 倍，这里统一缩放回点的分辨率再识别，
所以取样图片和扫描画面的比例永远一致，识别出的位置也直接就是点击坐标。

上传的图片（配置里 auto = true）大小不一定和屏幕一致，由 AutoScale 在运行时自己找：
轮流试不同的缩放比例，同一个比例连续 CONFIRM_FRAMES 帧达到门槛才记住。

结果文件格式（每次整体替换，主程序轮询读取）：
  {"ts": 毫秒时间戳, "seq": 帧序号, "ms": 本帧耗时, "region": {...},
   "images": {"<图片 id>": {"score": 0.93, "x": 中心 x, "y": 中心 y}}, "error": "..."}
上传的图片还可能带：scale（已记住的比例）、pending（还没确认，不算看到）、
unknown（第一轮还没试完，既不算看到也不算没看到）。
"""

import json
import os
import sys
import time

DEFAULT_RATE = 4              # 每秒扫描次数（配置里的 rate 优先）
COARSE_MIN_AREA = 400_000     # 扫描画面超过这么多像素时，先在半分辨率上粗找再精确确认
COARSE_MIN_TEMPLATE = 24      # 图片边长小于这个值时不做粗找（缩小后细节太少）
CONFIRM_FRAMES = 3            # 上传的图片：同一个比例连续这么多帧达到门槛才记住
MIN_SCALED_SIDE = 12          # 缩放后边长小于这个值就不试（太小容易认错）
RESEARCH_EVERY = 2            # 已记住比例但没看到时，每隔这么多帧试一个别的比例（窗口大小可能变了）
SEARCH_BUDGET_MIN = 0.03      # 还没找到比例时，每帧最多花这么多秒试比例（按扫描间隔的 35%，限制在这两个值之间）
SEARCH_BUDGET_MAX = 0.12


def build_scales():
    """要试的比例：Mac 截图通常是 2 倍大，所以 0.5 最先试；其余从 0.25 到 2 大约每隔 6% 一个。"""
    scales = [0.5, 1.0, 0.75, 1.5, 0.67, 1.25, 2.0, 0.33]
    value = 0.25
    while value <= 2.0:
        if all(abs(value - s) / s > 0.03 for s in scales):
            scales.append(round(value, 3))
        value *= 1.06
    return scales


SCALES = build_scales()


def write_json_atomic(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    os.replace(tmp, path)


def now_ms():
    return int(time.time() * 1000)


def import_libs():
    import cv2  # noqa: F401
    import mss  # noqa: F401
    import numpy  # noqa: F401
    return cv2, mss, numpy


def new_screenshotter(mss):
    # mss 10 起推荐 mss.MSS，旧版本只有 mss.mss
    factory = getattr(mss, "MSS", None) or mss.mss
    return factory()


def grab_gray(sct, cv2, np, region):
    """截取 region（点坐标），返回缩放到点分辨率的灰度图。"""
    monitor = {
        "left": int(round(region["x"])),
        "top": int(round(region["y"])),
        "width": max(1, int(round(region["w"]))),
        "height": max(1, int(round(region["h"]))),
    }
    shot = np.array(sct.grab(monitor))
    gray = cv2.cvtColor(shot, cv2.COLOR_BGRA2GRAY)
    if gray.shape[1] != monitor["width"] or gray.shape[0] != monitor["height"]:
        gray = cv2.resize(gray, (monitor["width"], monitor["height"]), interpolation=cv2.INTER_AREA)
    return gray, monitor


def find_template(cv2, frame, template):
    """在 frame 里找 template，返回 (相似度, 左上角 x, 左上角 y)。"""
    fh, fw = frame.shape[:2]
    th, tw = template.shape[:2]
    if th > fh or tw > fw:
        return 0.0, 0, 0

    use_coarse = fh * fw >= COARSE_MIN_AREA and min(th, tw) >= COARSE_MIN_TEMPLATE
    if not use_coarse:
        result = cv2.matchTemplate(frame, template, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(result)
        return float(score), loc[0], loc[1]

    # 粗找：画面和图片都缩小一半，速度约快 4 倍，只用来确定大概位置
    small_frame = cv2.resize(frame, (fw // 2, fh // 2), interpolation=cv2.INTER_AREA)
    small_tpl = cv2.resize(template, (tw // 2, th // 2), interpolation=cv2.INTER_AREA)
    result = cv2.matchTemplate(small_frame, small_tpl, cv2.TM_CCOEFF_NORMED)
    _, _, _, loc = cv2.minMaxLoc(result)

    # 精确确认：回到原分辨率，只在粗找位置周围一小块里再找一次，得到准确的相似度和位置
    margin = 8
    x0 = max(0, loc[0] * 2 - margin)
    y0 = max(0, loc[1] * 2 - margin)
    x1 = min(fw, loc[0] * 2 + tw + margin)
    y1 = min(fh, loc[1] * 2 + th + margin)
    roi = frame[y0:y1, x0:x1]
    if roi.shape[0] < th or roi.shape[1] < tw:
        return 0.0, 0, 0
    result = cv2.matchTemplate(roi, template, cv2.TM_CCOEFF_NORMED)
    _, score, _, fine = cv2.minMaxLoc(result)
    return float(score), x0 + fine[0], y0 + fine[1]


class AutoScale:
    """一张上传图片的自动找大小状态。眼睛进程活着就一直保留，配置重新读取也不丢。"""

    def __init__(self, template, scale):
        self.template = template
        self.cache = {}
        self.locked = scale if scale else None
        self.candidate = None
        self.streak = 0
        self.next_index = 0
        self.pass_done = bool(scale)  # 记住过比例，或者所有比例都试过一轮
        self.frames = 0

    def scaled(self, cv2, scale):
        if scale not in self.cache:
            th, tw = self.template.shape[:2]
            size = (max(1, int(round(tw * scale))), max(1, int(round(th * scale))))
            interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
            self.cache[scale] = self.template if scale == 1 else cv2.resize(self.template, size, interpolation=interpolation)
        return self.cache[scale]

    def attempt(self, cv2, frame, scale):
        """按这个比例找一次，返回 (相似度, 左上角 x, 左上角 y, 宽, 高)。"""
        template = self.scaled(cv2, scale)
        th, tw = template.shape[:2]
        if min(th, tw) < MIN_SCALED_SIDE:
            return 0.0, 0, 0, tw, th
        score, left, top = find_template(cv2, frame, template)
        return score, left, top, tw, th

    def search_step(self, cv2, frame, threshold, budget):
        """接着上次的位置试后面的比例，时间用完或碰到达标的比例就停，返回这一轮最像的结果。"""
        started = time.time()
        best = None
        while True:
            scale = SCALES[self.next_index]
            self.next_index += 1
            if self.next_index >= len(SCALES):
                self.next_index = 0
                self.pass_done = True
            found = self.attempt(cv2, frame, scale)
            if best is None or found[0] > best[0]:
                best = found
            if found[0] >= threshold and scale != self.locked:
                self.candidate, self.streak = scale, 1
                return best
            if self.next_index == 0 or time.time() - started >= budget:
                return best

    def scan(self, cv2, frame, threshold, budget):
        """返回要写进结果的字段：score, left, top, tw, th, 以及状态标记。"""
        self.frames += 1
        locked_result = self.attempt(cv2, frame, self.locked) if self.locked else None
        if locked_result and locked_result[0] >= threshold:
            self.candidate, self.streak = None, 0
            return self.report(locked_result)

        result = None
        if self.candidate:
            found = self.attempt(cv2, frame, self.candidate)
            if found[0] >= threshold:
                self.streak += 1
                if self.streak >= CONFIRM_FRAMES:
                    self.locked, self.candidate, self.streak = self.candidate, None, 0
                    self.pass_done = True
                    return self.report(found)
                result = found
            else:
                self.candidate, self.streak = None, 0

        if result is None:
            if self.locked:
                if self.frames % RESEARCH_EVERY == 0:
                    self.search_step(cv2, frame, threshold, 0)
            else:
                result = self.search_step(cv2, frame, threshold, budget)
        return self.report(locked_result if self.locked else result)

    def report(self, found):
        score, left, top, tw, th = found
        info = {"score": score, "left": left, "top": top, "tw": tw, "th": th}
        if self.locked:
            info["scale"] = self.locked
        else:
            info["pending"] = True
            if not self.pass_done or self.candidate:
                info["unknown"] = True
        return info


def parent_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def load_config(path, cv2):
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    templates = []
    for image in config.get("images", []):
        templates.append((image, cv2.imread(image["path"], cv2.IMREAD_GRAYSCALE)))
    return config, templates


def command_run(config_path, result_path, parent_pid):
    try:
        cv2, mss, np = import_libs()
    except Exception as error:  # 依赖缺失：写一次错误结果后退出，主程序会提示怎么安装
        write_json_atomic(result_path, {"ts": now_ms(), "seq": 0, "fatal": True,
                                        "error": "缺少 Python 依赖 / Missing Python package: %s" % error})
        return 2

    cv2.setNumThreads(2)
    sct = new_screenshotter(mss)
    config, templates, config_mtime = None, [], None
    auto_scales = {}
    interval = 1.0 / DEFAULT_RATE
    seq = 0

    while parent_alive(parent_pid):
        started = time.time()
        payload = {"ts": now_ms(), "seq": seq, "images": {}}
        try:
            mtime = os.path.getmtime(config_path)
            if mtime != config_mtime:
                config, templates = load_config(config_path, cv2)
                config_mtime = mtime
                interval = 1.0 / max(1, float(config.get("rate") or DEFAULT_RATE))
            region = config["region"]
            frame, monitor = grab_gray(sct, cv2, np, region)
            payload["region"] = region
            budget = min(SEARCH_BUDGET_MAX, max(SEARCH_BUDGET_MIN, interval * 0.35))
            for image, template in templates:
                image_id = image["id"]
                if template is None:
                    payload["images"][image_id] = {"score": 0.0, "missing": True}
                    continue
                if image.get("auto"):
                    if image_id not in auto_scales:
                        auto_scales[image_id] = AutoScale(template, image.get("scale"))
                    found = auto_scales[image_id].scan(cv2, frame, float(image.get("threshold", 0.85)), budget)
                    entry = {
                        "score": round(found["score"], 4),
                        "x": round(monitor["left"] + found["left"] + found["tw"] / 2.0, 1),
                        "y": round(monitor["top"] + found["top"] + found["th"] / 2.0, 1),
                    }
                    for flag in ("scale", "pending", "unknown"):
                        if flag in found:
                            entry[flag] = found[flag]
                    payload["images"][image_id] = entry
                    continue
                score, left, top = find_template(cv2, frame, template)
                th, tw = template.shape[:2]
                payload["images"][image_id] = {
                    "score": round(score, 4),
                    "x": round(monitor["left"] + left + tw / 2.0, 1),
                    "y": round(monitor["top"] + top + th / 2.0, 1),
                }
        except Exception as error:
            payload["error"] = "%s: %s" % (type(error).__name__, error)

        payload["ms"] = int((time.time() - started) * 1000)
        payload["ts"] = now_ms()
        try:
            write_json_atomic(result_path, payload)
        except OSError:
            pass
        seq += 1
        time.sleep(max(0.01, interval - (time.time() - started)))
    return 0


def command_grab(x, y, w, h, out_path):
    cv2, mss, np = import_libs()
    # 取样保存彩色原图（缩放到点分辨率），识别时再转灰度
    with new_screenshotter(mss) as sct:
        monitor = {"left": int(round(x)), "top": int(round(y)),
                   "width": max(1, int(round(w))), "height": max(1, int(round(h)))}
        shot = np.array(sct.grab(monitor))
    image = cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)
    if image.shape[1] != monitor["width"] or image.shape[0] != monitor["height"]:
        image = cv2.resize(image, (monitor["width"], monitor["height"]), interpolation=cv2.INTER_AREA)
    if not cv2.imwrite(out_path, image):
        raise RuntimeError("无法写入 %s" % out_path)
    # 整块颜色几乎一样（例如没有屏幕录制权限时只截到纯色），提醒主程序
    flat = float(image.std()) < 2.0
    print(json.dumps({"ok": True, "w": monitor["width"], "h": monitor["height"], "flat": flat}))
    return 0


def command_import(source, out_path):
    cv2, _, _ = import_libs()
    image = cv2.imread(source, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("读不出这张图片，请换 PNG 或 JPG 格式")
    if not cv2.imwrite(out_path, image):
        raise RuntimeError("无法写入 %s" % out_path)
    print(json.dumps({"ok": True, "w": image.shape[1], "h": image.shape[0], "flat": float(image.std()) < 2.0}))
    return 0


def command_check():
    try:
        cv2, mss, np = import_libs()
        print(json.dumps({"ok": True, "python": sys.version.split()[0], "cv2": cv2.__version__,
                          "numpy": np.__version__, "mss": getattr(mss, "__version__", "?")}))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "python": sys.version.split()[0], "error": str(error)}))
        return 2


def main(argv):
    if len(argv) >= 4 and argv[0] == "run":
        return command_run(argv[1], argv[2], int(argv[3]))
    if len(argv) >= 6 and argv[0] == "grab":
        try:
            return command_grab(float(argv[1]), float(argv[2]), float(argv[3]), float(argv[4]), argv[5])
        except Exception as error:
            print(json.dumps({"ok": False, "error": "%s: %s" % (type(error).__name__, error)}))
            return 2
    if len(argv) >= 3 and argv[0] == "import":
        try:
            return command_import(argv[1], argv[2])
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}))
            return 2
    if argv and argv[0] == "check":
        return command_check()
    sys.stderr.write(__doc__)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
