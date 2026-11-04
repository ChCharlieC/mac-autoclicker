"""AutoClicker 的手机遥控网页服务。

由主程序（AutoClicker.js）用 NSTask 启动：

  python3 remote.py serve <端口> <密码> <状态文件> <命令文件> <信息文件> <主程序 PID> [语言 zh/en]

- 在局域网里开一个小网页（只用 Python 自带的库）。手机打开 http://电脑名.local:端口/?key=密码
- 主程序每 0.5 秒把状态写进状态文件；网页每秒读一次显示出来。
- 手机上按"开始 / 停止"，这里把命令写进命令文件，主程序读到后执行。
- 密码不对一律拒绝；主程序退出后这里自动结束。
- 端口被占用时依次尝试后面 9 个端口；实际用的端口、电脑名和 IP 写进信息文件。
"""

import hmac
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def write_json_atomic(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    os.replace(tmp, path)


def local_host_name():
    """电脑在局域网里的名字（Bonjour），换 Wi-Fi 也不变。"""
    try:
        name = subprocess.run(["/usr/sbin/scutil", "--get", "LocalHostName"],
                              capture_output=True, text=True, timeout=3).stdout.strip()
        if name:
            return name + ".local"
    except Exception:
        pass
    return socket.gethostname()


def local_ip():
    """本机在局域网里的 IP（只是借 UDP 查路由，不会真的发数据）。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.168.0.1", 9))
        return sock.getsockname()[0]
    except Exception:
        return ""
    finally:
        sock.close()


PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>AutoClicker 遥控</title>
<style>
:root{--bg:#f2f2f7;--card:#fff;--text:#1c1c1e;--sub:#6e6e73;--line:#e5e5ea;--green:#28a745;--red:#d93025;--orange:#e67e22}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#f2f2f7;--sub:#98989d;--line:#2c2c2e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;padding:16px 16px 32px}
h1{font-size:20px;margin:4px 0 12px}.card{background:var(--card);border-radius:14px;padding:14px 16px;margin-bottom:12px}
.status{font-size:22px;font-weight:700}.sub{color:var(--sub);font-size:14px;margin-top:6px;line-height:1.5}
.row{display:flex;justify-content:space-between;padding:7px 0;border-top:1px solid var(--line);font-size:15px}.row:first-child{border-top:0}
.row b{font-variant-numeric:tabular-nums}.ok{color:var(--green)}.err{color:var(--red)}.warn{color:var(--orange)}
.buttons{display:flex;gap:12px;margin-bottom:12px}
button{flex:1;font-size:20px;font-weight:700;padding:18px 0;border:0;border-radius:14px;color:#fff}
#start{background:var(--green)}#stop{background:var(--red)}button:disabled{opacity:.35}
.hide{display:none}
</style></head><body>
<h1>AutoClicker 遥控</h1>
<div class="card"><div class="status" id="status">连接中…</div><div class="sub" id="detail"></div></div>
<div class="buttons"><button id="start">▶ 开始</button><button id="stop">■ 停止</button></div>
<div class="card" id="info"></div>
<div class="card hide" id="images"></div>
<div class="sub" id="foot"></div>
<script>
var key = new URLSearchParams(location.search).get("key") || "";
function esc(t){return String(t).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function row(k,v,cls){return '<div class="row"><span>'+esc(k)+'</span><b class="'+(cls||"")+'">'+esc(v)+'</b></div>';}
function send(cmd){
  fetch("/cmd?key="+encodeURIComponent(key)+"&c="+cmd,{method:"POST"}).then(function(r){return r.json();})
  .then(function(j){document.getElementById("foot").textContent=j.ok?"已发送："+(cmd=="start"?"开始":"停止"):"发送失败："+j.error;})
  .catch(function(){document.getElementById("foot").textContent="发送失败，连不上电脑";});
}
document.getElementById("start").onclick=function(){send("start");};
document.getElementById("stop").onclick=function(){send("stop");};
function refresh(){
  fetch("/status?key="+encodeURIComponent(key)).then(function(r){return r.json();}).then(function(s){
    var st=document.getElementById("status"),d=document.getElementById("detail");
    if(s.error){st.textContent=s.error;st.className="status err";return;}
    var stale=s.age>5000;
    st.textContent=stale?"AutoClicker 没有响应":s.statusText;
    st.className="status "+(stale?"err":s.state=="running"?"ok":s.state=="countdown"?"warn":"");
    d.innerHTML=esc(s.modeName)+(s.dryRun?" · 演练模式（不点击）":"")+(s.activity?"<br>"+esc(s.activity):"")+(s.error?'<br><span class="err">'+esc(s.error)+"</span>":"");
    document.getElementById("start").disabled=stale||s.state!="idle"||!s.canStart;
    document.getElementById("stop").disabled=stale||s.state=="idle";
    var h="";
    if(s.remaining)h+=row("剩余时间",s.remaining);
    if(s.idleLeft)h+=row("没识别到就停止，还剩",s.idleLeft);
    if(s.eye)h+=row("识别进程（眼睛）",s.eye);
    var info=document.getElementById("info");
    info.innerHTML=h;
    info.classList.toggle("hide",!h);
    var im=document.getElementById("images");
    if(s.images&&s.images.length){
      im.classList.remove("hide");
      im.innerHTML=s.images.map(function(i){return row(i.name+"（门槛 "+i.threshold.toFixed(2)+"）",i.score==null?"—":i.score.toFixed(2)+(i.found?" ✓":""),i.found?"ok":"");}).join("");
    } else im.classList.add("hide");
    document.getElementById("foot").textContent="更新于 "+new Date().toLocaleTimeString();
  }).catch(function(){var st=document.getElementById("status");st.textContent="连不上电脑（同一个 Wi-Fi 吗？）";st.className="status err";});
}
refresh();setInterval(refresh,1000);
</script></body></html>"""


# 英文界面：把网页和提示里的中文按这张表换掉。长的放前面，避免被短的先换掉一部分。
EN = [
    ('lang="zh-CN"', 'lang="en"'),
    ("AutoClicker 遥控", "AutoClicker Remote"),
    ("连不上电脑（同一个 Wi-Fi 吗？）", "Can't reach the computer (same Wi-Fi?)"),
    ("发送失败，连不上电脑", "Send failed: can't reach the computer"),
    ("发送失败：", "Send failed: "),
    ("已发送：", "Sent: "),
    ("连接中…", "Connecting…"),
    ("▶ 开始", "▶ Start"),
    ("■ 停止", "■ Stop"),
    ('?"开始":"停止"', '?"Start":"Stop"'),
    ("AutoClicker 没有响应", "AutoClicker isn't responding"),
    ("演练模式（不点击）", "Dry run (no clicks)"),
    ("剩余时间", "Time left"),
    ("没识别到就停止，还剩", "Stops with no match in"),
    ("识别进程（眼睛）", "Recognition process"),
    ("（门槛 ", " (min "),
    ('"）"', '")"'),
    ("更新于 ", "Updated "),
    ("密码不对，请在电脑上重新扫码", "Wrong password. Scan the QR code on the computer again"),
    ("密码不对，请在电脑上的“手机遥控”里重新扫码。", "Wrong password. Scan the QR code under “Phone remote” on the computer again."),
    ("还没有收到 AutoClicker 的状态", "No status from AutoClicker yet"),
    ("密码不对", "Wrong password"),
    ("未知命令", "Unknown command"),
]
LANGUAGE = "zh"


def localize(text):
    if LANGUAGE != "en":
        return text
    for chinese, english in EN:
        text = text.replace(chinese, english)
    return text


def make_handler(key, status_path, command_path):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # 不往 stderr 刷访问日志
            pass

        def _send(self, code, body, content_type):
            data = localize(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _json(self, code, payload):
            self._send(code, json.dumps(payload, ensure_ascii=False), "application/json; charset=utf-8")

        def _authorized(self, query):
            given = (query.get("key") or [""])[0]
            return hmac.compare_digest(given.encode("utf-8"), key.encode("utf-8"))

        def do_GET(self):
            url = urlparse(self.path)
            query = parse_qs(url.query)
            if not self._authorized(query):
                if url.path == "/status":
                    self._json(403, {"error": "密码不对，请在电脑上重新扫码"})
                else:
                    self._send(403, "<meta charset='utf-8'><h2>密码不对，请在电脑上的“手机遥控”里重新扫码。</h2>",
                               "text/html; charset=utf-8")
                return
            if url.path == "/":
                self._send(200, PAGE, "text/html; charset=utf-8")
            elif url.path == "/status":
                try:
                    with open(status_path, "r", encoding="utf-8") as handle:
                        status = json.load(handle)
                    status["age"] = int(time.time() * 1000) - int(status.get("ts", 0))
                except Exception:
                    status = {"error": "还没有收到 AutoClicker 的状态"}
                self._json(200, status)
            else:
                self._send(404, "not found", "text/plain; charset=utf-8")

        def do_POST(self):
            url = urlparse(self.path)
            query = parse_qs(url.query)
            if not self._authorized(query):
                self._json(403, {"ok": False, "error": "密码不对"})
                return
            if url.path != "/cmd":
                self._json(404, {"ok": False, "error": "not found"})
                return
            command = (query.get("c") or [""])[0]
            if command not in ("start", "stop"):
                self._json(400, {"ok": False, "error": "未知命令"})
                return
            write_json_atomic(command_path, {"id": "%d-%d" % (time.time() * 1000, os.getpid()),
                                             "cmd": command, "ts": int(time.time() * 1000)})
            self._json(200, {"ok": True})

    return Handler


def parent_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def command_serve(port, key, status_path, command_path, info_path, parent_pid):
    handler = make_handler(key, status_path, command_path)
    server = None
    last_error = None
    for candidate in range(port, port + 10):
        try:
            server = ThreadingHTTPServer(("0.0.0.0", candidate), handler)
            break
        except OSError as error:
            last_error = error
    if server is None:
        write_json_atomic(info_path, {"ok": False, "error": "端口都被占用：%s" % last_error})
        return 2
    server.daemon_threads = True
    actual_port = server.server_address[1]
    write_json_atomic(info_path, {"ok": True, "port": actual_port, "host": local_host_name(),
                                  "ip": local_ip(), "pid": os.getpid()})

    def watch_parent():
        while parent_alive(parent_pid):
            time.sleep(1)
        server.shutdown()

    threading.Thread(target=watch_parent, daemon=True).start()
    server.serve_forever(poll_interval=0.5)
    return 0


def main(argv):
    if len(argv) >= 7 and argv[0] == "serve":
        global LANGUAGE
        LANGUAGE = argv[7] if len(argv) >= 8 else "zh"
        return command_serve(int(argv[1]), argv[2], argv[3], argv[4], argv[5], int(argv[6]))
    sys.stderr.write(__doc__)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
