// AutoClicker 独立看门狗
//
// 由主程序通过 NSTask 启动，是一个独立进程，不依赖主程序的事件循环。
// 用法：osascript -l JavaScript watchdog.js <主程序 PID> <状态文件> <看门狗日志> <强制退出标记文件>
//
// 规则：
//   1. 主程序状态为倒计时/运行中时，如果 Esc 被按住 ≥ 500 ms 仍未回到空闲，强制退出主程序。
//   2. 按下 Esc 时主程序正在运行，600 ms 后仍是同一轮运行且未停止，强制退出主程序。
//   3. 主程序心跳超过 3 秒没有更新（主线程可能无响应），并且 Esc 被按住 ≥ 1.5 秒，强制退出主程序。
//   4. 主程序进程消失后看门狗自动退出。

ObjC.import("Foundation");
ObjC.import("ApplicationServices");
ObjC.import("signal");

var ESCAPE_KEY_CODE = 53;
var POLL_INTERVAL = 0.04;
var HOLD_TO_KILL_MS = 500;
var PENDING_STOP_MS = 600;
var STALE_HEARTBEAT_MS = 3000;
var HOLD_TO_KILL_STALE_MS = 1500;

var logHandle = null;

function js(value) {
    try { return ObjC.unwrap(value); } catch (error) { return value; }
}

function pad(number, width) {
    var text = String(number);
    while (text.length < (width || 2)) text = "0" + text;
    return text;
}

function stamp() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
        "." + pad(d.getMilliseconds(), 3);
}

function openLog(path) {
    var fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(path)) fm.createFileAtPathContentsAttributes(path, $(), $());
    logHandle = $.NSFileHandle.fileHandleForWritingAtPath(path);
    if (logHandle && !logHandle.isNil()) {
        var size = Number(js(logHandle.seekToEndOfFile));
        if (size > 1024 * 1024) logHandle.truncateFileAtOffset(0);
    }
}

function log(message) {
    if (!logHandle || logHandle.isNil()) return;
    try {
        logHandle.writeData($(stamp() + " [watchdog] " + message + "\n")
            .dataUsingEncoding($.NSUTF8StringEncoding));
    } catch (error) {}
}

function readState(path) {
    var text = $.NSString.stringWithContentsOfFileEncodingError(
        path, $.NSUTF8StringEncoding, $()
    );
    if (!text || text.isNil()) return null;
    try {
        var parsed = JSON.parse(js(text));
        return (parsed && typeof parsed === "object") ? parsed : null;
    } catch (error) {
        return null;
    }
}

// 用 kill(pid, 0) 判断存活；NSRunningApplication 在没有事件循环的 osascript 进程里会误报已退出。
function processAlive(pid) {
    return Number($.kill(pid, 0)) === 0;
}

function escapeIsDown() {
    return Boolean(js($.CGEventSourceKeyState(
        $.kCGEventSourceStateCombinedSessionState,
        ESCAPE_KEY_CODE
    )));
}

function writeKillMarker(path, reason) {
    var payload = JSON.stringify({ reason: reason, time: stamp() });
    $(payload).writeToFileAtomicallyEncodingError(
        path, true, $.NSUTF8StringEncoding, $()
    );
}

function run(argv) {
    var pid = Number(argv[0]);
    var statePath = String(argv[1]);
    var logPath = String(argv[2]);
    var killMarkerPath = String(argv[3]);

    openLog(logPath);
    log("启动，监视 PID " + pid + "，状态文件 " + statePath);

    var keyStateError = null;
    try { escapeIsDown(); } catch (error) { keyStateError = String(error); }
    if (keyStateError) {
        log("CGEventSourceKeyState 不可用：" + keyStateError + "，看门狗无法检测 Esc");
    } else {
        log("CGEventSourceKeyState 可调用");
    }

    var escapeSince = null;
    var pendingDeadline = null;
    var pendingGeneration = null;
    var killed = false;
    var lastLoggedState = null;

    function kill(reason) {
        killed = true;
        log("强制退出主程序：" + reason);
        writeKillMarker(killMarkerPath, reason);
        var result = Number($.kill(pid, $.SIGKILL));
        log("kill(SIGKILL) 返回 " + result);
    }

    while (true) {
        if (!processAlive(pid)) {
            log("主程序已退出，看门狗结束");
            break;
        }

        var now = Date.now();
        var state = readState(statePath);
        var stateName = state ? String(state.state) : "unknown";
        if (stateName !== lastLoggedState) {
            log("主程序状态：" + stateName +
                (state ? "（第 " + state.generation + " 轮）" : ""));
            lastLoggedState = stateName;
        }

        var active = state && (stateName === "running" || stateName === "countdown");
        var stale = !state || (now - Number(state.ts) > STALE_HEARTBEAT_MS);

        var down = false;
        if (!keyStateError) {
            try {
                down = escapeIsDown();
            } catch (error) {
                keyStateError = String(error);
                log("CGEventSourceKeyState 失败：" + keyStateError);
            }
        }
        if (down) {
            if (escapeSince === null) {
                escapeSince = now;
                log("检测到 Esc 按下，主程序状态=" + stateName);
                if (active) {
                    pendingDeadline = now + PENDING_STOP_MS;
                    pendingGeneration = state.generation;
                }
            }
            var held = now - escapeSince;
            if (!killed && active && held >= HOLD_TO_KILL_MS) {
                kill("Esc 已按住 " + held + " ms，主程序仍处于“" + stateName + "”");
            } else if (!killed && stale && held >= HOLD_TO_KILL_STALE_MS) {
                kill("Esc 已按住 " + held + " ms，主程序心跳超过 " +
                    STALE_HEARTBEAT_MS + " ms 未更新");
            }
        } else if (escapeSince !== null) {
            log("Esc 松开，按住 " + (now - escapeSince) + " ms");
            escapeSince = null;
        }

        if (!killed && pendingDeadline !== null && now >= pendingDeadline) {
            pendingDeadline = null;
            var latest = readState(statePath);
            if (latest && (latest.state === "running" || latest.state === "countdown") &&
                latest.generation === pendingGeneration) {
                kill("按下 Esc " + PENDING_STOP_MS + " ms 后主程序仍未停止");
            } else {
                log("Esc 后主程序已停止（状态=" +
                    (latest ? latest.state : "unknown") + "）");
            }
        }

        $.NSThread.sleepForTimeInterval(POLL_INTERVAL);
    }
}
