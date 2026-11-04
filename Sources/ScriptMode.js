// ===========================================================================
// 脚本模式（第二阶段）
//
// 构建时 build-app.sh 把这个文件拼接在 AutoClicker.js 后面一起编译，所以这里可以直接使用
// 主文件里的函数（log、jsString、scheduleOnce……）和 AutoClicker 控制器，并给它加方法。
//
// 结构：
//   "眼睛" = 独立的 Python 进程（Contents/Resources/eye.py），按设置的频率（默认每秒 4 次）截图找图，结果写进 eye-result.json
//   "大脑" = 这里的 scriptScanTick：按同样的频率读结果，从上往下检查规则，执行第一条成立的规则
//   "手"   = 只有一个：规则动作执行时先停住默认连点，过完冷却时间再恢复，两者绝不同时发点击
//
// 坐标：点位存的是"相对扫描范围原点"的坐标（rx, ry）。整个屏幕 / 区域的原点是 (0, 0)，
// 窗口的原点是窗口左上角，所以窗口移动后点位跟着动。运行时绝对坐标 = 原点 + 相对坐标。
// 所有坐标都是 CoreGraphics 全局坐标（点为单位、左上角为原点），和发送点击用的坐标一致。
// ===========================================================================

var SCRIPT_TOOLBAR_WIDTH = 780;
var SCRIPT_TOOLBAR_HEIGHT = 668;
var DEFAULT_SCAN_RATE = 4;               // 每秒扫描次数
var MAX_SCAN_RATE = 20;
var SCRIPT_POINT_ID_BASE = 100000;       // 脚本点位的 id 从这里开始，和点击模式的点位区分开
var MAX_SCRIPT_IMAGES = 30;
var MAX_SCRIPT_POINTS = 30;
var MAX_RULES = 30;
var MAX_CONDITIONS = 5;
var MAX_NAME_LENGTH = 20;
var DEFAULT_THRESHOLD = 0.85;
var DEFAULT_COOLDOWN = 1.5;
var DEFAULT_IDLE_STOP_MINUTES = 15;
var MAX_IDLE_STOP_MINUTES = 600;
var EYE_STALE_MS = 1500;                 // 识别结果超过这么久没更新，就当作"没对上任何规则"
var EYE_STARTUP_GRACE_MS = 5000;         // 刚启动时最多等这么久第一帧结果，期间不做默认连点
var EYE_RESTART_GAP_MS = 2000;           // 眼睛进程崩溃后，至少隔这么久再重启
var WINDOW_TRACK_MS = 1000;              // 每秒查一次窗口位置
var COOLDOWN_CHOICES = [0.5, 1, 1.5, 2, 3, 5, 10];
var WAIT_CHOICES = [0.5, 1, 2, 3, 5, 10, 15, 30, 60];
var MAX_TIMES = 9999;                            // 规则点击次数上限；0 表示"一直点，直到……"
var MIN_GAP_MS = 50;                             // 连续点击之间的间隔（毫秒）
var MAX_GAP_MS = 60000;
var DEFAULT_GAP = 0.3;                           // 秒
var MAX_UNTIL_SECONDS = 300;                     // "一直点直到…"最多点这么久，防止永远停不下来
var ACTION_TYPES = [
    { type: "clickPoint", label: tr("点击点位") },
    { type: "runLayout", label: tr("运行点击方案") },
    { type: "wait", label: tr("等待") }
];
var IMAGES_DIR = "";
var EYE_CONFIG_PATH = "";
var EYE_RESULT_PATH = "";
var EYE_STDERR_PATH = "";

// CGPreflightScreenCaptureAccess / CGRequestScreenCaptureAccess 没有被 JXA 自动桥接，手动绑定。
try {
    ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
    ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]);
} catch (error) {}

function setupScriptPaths() {
    IMAGES_DIR = SUPPORT_DIR + "/images";
    EYE_CONFIG_PATH = SUPPORT_DIR + "/eye-config.json";
    EYE_RESULT_PATH = SUPPORT_DIR + "/eye-result.json";
    EYE_STDERR_PATH = SUPPORT_DIR + "/eye-stderr.log";
    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
        IMAGES_DIR, true, $(), $()
    );
}

function screenCaptureAllowed() {
    try { return Boolean($.CGPreflightScreenCaptureAccess()); } catch (error) { return true; }
}

function formatSeconds(value) {
    return (Math.round(value * 10) / 10) + tr(" 秒");
}

function cleanName(text) {
    return String(text || "").replace(/[\r\n\t]/g, " ").trim();
}

function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
}

// 所有屏幕合起来的范围（CG 坐标）
function allScreensCGRect() {
    var screens = $.NSScreen.screens;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < jsNumber(screens.count); i += 1) {
        var f = screens.objectAtIndex(i).frame;
        var topLeft = appKitPointToCG(Number(f.origin.x), Number(f.origin.y) + Number(f.size.height));
        minX = Math.min(minX, topLeft.x);
        minY = Math.min(minY, topLeft.y);
        maxX = Math.max(maxX, topLeft.x + Number(f.size.width));
        maxY = Math.max(maxY, topLeft.y + Number(f.size.height));
    }
    if (!isFinite(minX)) return { x: 0, y: 0, w: 1440, h: 900 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// 把一个 CG 矩形换成 AppKit 窗口 frame（左下角原点）
function cgRectToAppKitFrame(rect) {
    var bottomLeft = cgPointToAppKit(rect.x, rect.y + rect.h);
    return $.NSMakeRect(bottomLeft.x, bottomLeft.y, rect.w, rect.h);
}

function rectsIntersect(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// 在不进入嵌套事件循环的前提下同步运行一个命令（只用于很快结束的命令：检查依赖、取样截图）。
// 不用 waitUntilExit：它会运行当前 run loop，让定时器在这里重入执行。
function runTaskSync(launchPath, args, timeoutSeconds) {
    var task = $.NSTask.alloc.init;
    task.launchPath = launchPath;
    task.arguments = $(args);
    var pipe = $.NSPipe.pipe;
    task.standardOutput = pipe;
    task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    try {
        task.launch;
    } catch (error) {
        return { status: -1, text: "", error: String(error) };
    }
    var deadline = Date.now() + timeoutSeconds * 1000;
    while (jsBoolean(task.running) && Date.now() < deadline) {
        $.NSThread.sleepForTimeInterval(0.02);
    }
    if (jsBoolean(task.running)) {
        task.terminate;
        return { status: -1, text: "", error: tr("超时") };
    }
    var data = pipe.fileHandleForReading.readDataToEndOfFile;
    var text = jsString($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    return { status: jsNumber(task.terminationStatus), text: text };
}

function parseLastJSONLine(text) {
    var lines = String(text || "").split("\n");
    for (var i = lines.length - 1; i >= 0; i -= 1) {
        var line = lines[i].trim();
        if (line.charAt(0) !== "{") continue;
        try { return JSON.parse(line); } catch (error) {}
    }
    return null;
}

// ---------------------------------------------------------------------------
// ObjC 子类
// ---------------------------------------------------------------------------

// 脚本模式的所有按钮、下拉菜单共用一个 action，命令写在控件的 identifier 里（例如 "rule.up:3"）。
ObjC.registerSubclass({
    name: "AutoClickerScriptTarget",
    superclass: "NSObject",
    methods: {
        "scriptCommand:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (!appController) return;
                try {
                    appController.handleScriptCommand(jsString(sender.identifier), sender);
                } catch (error) {
                    log("脚本命令出错 [" + jsString(sender.identifier) + "]：" + error);
                }
            }
        }
    }
});

// 规则卡片左上角的"≡"拖动把手：按住上下拖动，松开后把整条规则移到新位置。tag = 规则序号。
ObjC.registerSubclass({
    name: "AutoClickerRuleHandle",
    superclass: "NSButton",
    methods: {
        "mouseDown:": {
            types: ["void", ["id"]],
            implementation: function (event) { if (appController) appController.ruleHandleMouse("down", jsNumber(this.tag), event); }
        },
        "mouseDragged:": {
            types: ["void", ["id"]],
            implementation: function (event) { if (appController) appController.ruleHandleMouse("drag", jsNumber(this.tag), event); }
        },
        "mouseUp:": {
            types: ["void", ["id"]],
            implementation: function (event) { if (appController) appController.ruleHandleMouse("up", jsNumber(this.tag), event); }
        }
    }
});

// 框选用的全屏半透明遮罩：无边框窗口默认不能成为 key window（收不到 Esc），这里打开。
ObjC.registerSubclass({
    name: "AutoClickerOverlayPanel",
    superclass: "NSPanel",
    methods: {
        "canBecomeKeyWindow": {
            types: ["bool", []],
            implementation: function () { return true; }
        },
        "cancelOperation:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.finishRegionSelection(null);
            }
        }
    }
});

ObjC.registerSubclass({
    name: "AutoClickerOverlayView",
    superclass: "NSView",
    methods: {
        "acceptsFirstMouse:": {
            types: ["bool", ["id"]],
            implementation: function (event) { return true; }
        },
        "mouseDown:": {
            types: ["void", ["id"]],
            implementation: function (event) { if (appController) appController.overlayMouse("down"); }
        },
        "mouseDragged:": {
            types: ["void", ["id"]],
            implementation: function (event) { if (appController) appController.overlayMouse("drag"); }
        },
        "mouseUp:": {
            types: ["void", ["id"]],
            implementation: function (event) { if (appController) appController.overlayMouse("up"); }
        },
        "rightMouseDown:": {
            types: ["void", ["id"]],
            implementation: function (event) { if (appController) appController.finishRegionSelection(null); }
        }
    }
});

// ---------------------------------------------------------------------------
// 数据：当前脚本（点位单独放在 this.scriptPoints，带圆点窗口）
// ---------------------------------------------------------------------------

function emptyScript() {
    return {
        scope: { type: "screen", window: null, region: null },
        images: [],
        rules: [],
        defaultAction: "none",    // 以上都没对上时："none" 什么都不做 / "points" 连点脚本点位 / "layout" 循环运行点击方案
        defaultPoints: [],
        defaultLayout: null,
        idleStopMinutes: DEFAULT_IDLE_STOP_MINUTES,
        scanRate: DEFAULT_SCAN_RATE
    };
}

function normalizeCondition(raw, index) {
    return {
        join: index > 0 && raw && raw.join === "or" ? "or" : "and",
        neg: Boolean(raw && raw.neg),
        image: raw && raw.image ? String(raw.image) : null
    };
}

// 点击模式方案的副本：{ name, markers: [{x, y, delayMs}], ref: {x, y, window} }
// ref 是选这个方案时扫描窗口的左上角；运行时窗口挪了，就把整套点击跟着平移。
function normalizeLayoutCopy(raw) {
    if (!raw || !raw.name || !Array.isArray(raw.markers)) return null;
    var markers = [];
    for (var i = 0; i < raw.markers.length && markers.length < MAX_MARKERS; i += 1) {
        var m = raw.markers[i];
        if (!m || !isFinite(Number(m.x)) || !isFinite(Number(m.y))) continue;
        markers.push({ x: Number(m.x), y: Number(m.y), delayMs: clamp(Math.round(Number(m.delayMs) || DEFAULT_INTERVAL), MIN_INTERVAL, MAX_INTERVAL) });
    }
    if (!markers.length) return null;
    var ref = raw.ref || {};
    return {
        name: String(raw.name),
        markers: markers,
        ref: { x: Number(ref.x) || 0, y: Number(ref.y) || 0, window: Boolean(ref.window) }
    };
}

function normalizeRule(raw) {
    var rule = {
        name: raw && raw.name ? cleanName(raw.name).slice(0, MAX_NAME_LENGTH) : "",
        conds: [],
        action: { type: "clickPoint", point: null, seconds: 1, times: 1, gap: DEFAULT_GAP, untilNeg: false, untilImage: null, layout: null },
        cooldown: DEFAULT_COOLDOWN
    };
    var conds = raw && Array.isArray(raw.conds) ? raw.conds : [];
    for (var i = 0; i < conds.length && i < MAX_CONDITIONS; i += 1) rule.conds.push(normalizeCondition(conds[i], i));
    if (!rule.conds.length) rule.conds.push(normalizeCondition(null, 0));
    var action = (raw && raw.action) || {};
    var known = ACTION_TYPES.map(function (t) { return t.type; });
    if (known.indexOf(action.type) >= 0) rule.action.type = action.type;
    if (action.point !== undefined && action.point !== null) rule.action.point = Number(action.point);
    if (WAIT_CHOICES.indexOf(Number(action.seconds)) >= 0) rule.action.seconds = Number(action.seconds);
    var times = Number(action.times);
    if (isFinite(times) && times >= 0) rule.action.times = clamp(Math.round(times), 0, MAX_TIMES);
    var gap = Number(action.gap);
    if (isFinite(gap) && gap > 0) rule.action.gap = clamp(gap, MIN_GAP_MS / 1000, MAX_GAP_MS / 1000);
    if (action.untilNeg === true) rule.action.untilNeg = true;
    rule.action.layout = normalizeLayoutCopy(action.layout);
    if (action.untilImage) rule.action.untilImage = String(action.untilImage);
    if (COOLDOWN_CHOICES.indexOf(Number(raw && raw.cooldown)) >= 0) rule.cooldown = Number(raw.cooldown);
    return rule;
}

// 把保存的 JSON 整理成干净的脚本数据（字段缺失或越界时用默认值）
function normalizeScript(raw) {
    var script = emptyScript();
    if (!raw || typeof raw !== "object") return { script: script, points: [] };

    var scope = raw.scope || {};
    if (scope.type === "window" && scope.window && scope.window.owner) {
        script.scope.type = "window";
        script.scope.window = {
            owner: String(scope.window.owner),
            name: String(scope.window.name || ""),
            number: Number(scope.window.number) || 0,
            lastBounds: scope.window.lastBounds || null
        };
    } else if (scope.type === "region" && scope.region && Number(scope.region.w) > 0) {
        script.scope.type = "region";
        script.scope.region = {
            x: Number(scope.region.x), y: Number(scope.region.y),
            w: Number(scope.region.w), h: Number(scope.region.h)
        };
    }

    var images = Array.isArray(raw.images) ? raw.images : [];
    for (var i = 0; i < images.length && script.images.length < MAX_SCRIPT_IMAGES; i += 1) {
        var image = images[i];
        if (!image || !image.id || !image.file) continue;
        var threshold = Number(image.threshold);
        script.images.push({
            id: String(image.id),
            name: cleanName(image.name).slice(0, MAX_NAME_LENGTH) || tr("图片"),
            file: String(image.file),
            threshold: isFinite(threshold) ? clamp(threshold, 0.5, 0.99) : DEFAULT_THRESHOLD,
            w: Number(image.w) || 0,
            h: Number(image.h) || 0,
            uploaded: Boolean(image.uploaded),
            scale: Number(image.scale) > 0 ? Number(image.scale) : 0
        });
    }

    var points = [];
    var rawPoints = Array.isArray(raw.points) ? raw.points : [];
    for (var j = 0; j < rawPoints.length && points.length < MAX_SCRIPT_POINTS; j += 1) {
        var p = rawPoints[j];
        if (!p || !isFinite(Number(p.rx)) || !isFinite(Number(p.ry))) continue;
        points.push({
            id: Number(p.id) || 0,
            name: cleanName(p.name).slice(0, MAX_NAME_LENGTH) || (tr("点位 ") + (points.length + 1)),
            rx: Number(p.rx),
            ry: Number(p.ry),
            delayMs: clamp(Math.round(Number(p.delayMs) || DEFAULT_INTERVAL), MIN_INTERVAL, MAX_INTERVAL)
        });
    }

    var rules = Array.isArray(raw.rules) ? raw.rules : [];
    for (var k = 0; k < rules.length && script.rules.length < MAX_RULES; k += 1) {
        script.rules.push(normalizeRule(rules[k]));
    }

    script.defaultLayout = normalizeLayoutCopy(raw.defaultLayout);
    // 旧数据没有这个字段：一律当作"什么都不做"
    if (raw.defaultAction === "points") script.defaultAction = "points";
    else if (raw.defaultAction === "layout" && script.defaultLayout) script.defaultAction = "layout";
    if (Array.isArray(raw.defaultPoints)) {
        script.defaultPoints = raw.defaultPoints.map(Number).filter(function (n) { return isFinite(n); });
    }
    var minutes = Number(raw.idleStopMinutes);
    if (isFinite(minutes) && minutes >= 1) script.idleStopMinutes = clamp(Math.round(minutes), 1, MAX_IDLE_STOP_MINUTES);
    var rate = Number(raw.scanRate);
    if (isFinite(rate) && rate >= 1) script.scanRate = clamp(Math.round(rate), 1, MAX_SCAN_RATE);
    return { script: script, points: points };
}

AutoClicker.prototype.initScriptMode = function () {
    setupScriptPaths();
    this.scriptTarget = $.AutoClickerScriptTarget.alloc.init;
    this.script = emptyScript();
    this.scriptPoints = [];
    this.nextScriptPointID = SCRIPT_POINT_ID_BASE + 1;
    this.scriptLayouts = [];
    this.scriptDryRun = jsBoolean(this.defaults.boolForKey("scriptDryRun"));
    this.scriptToolbar = null;
    this.scriptEditTimer = null;
    this.scriptEditControls = [];
    this.imageScoreLabels = {};
    this.ruleBoxes = [];
    this.scopeWindowBounds = null;
    this.windowCandidates = [];
    this.overlay = null;
    this.overlayStart = null;
    this.overlayCallback = null;
    this.pythonPath = null;

    // 运行状态
    this.scriptRunActive = false;
    this.scriptScanTimer = null;
    this.scriptClickTimer = null;
    this.scriptClickingActive = false;
    this.scriptClickIndex = 0;
    this.handBusyUntil = 0;
    this.ruleBurst = null;
    this.lastMatchTime = 0;
    this.lastWindowCheck = 0;
    this.scriptRunStartedAt = 0;
    this.eyeReady = false;
    this.eyeTask = null;
    this.eyeRestarts = 0;
    this.eyeLastStart = 0;
    this.eyeLastSeq = -1;
    this.eyeLastFrameMs = 0;
    this.eyeStatus = tr("未启动");
    this.lastConfigText = "";
    this.currentRuleIndex = -1;
    this.scriptActivity = "";

    this.loadScriptModels();
    this.loadScriptLayouts();
};

AutoClicker.prototype.loadScriptModels = function () {
    var raw = jsString(this.defaults.stringForKey("scriptJSON"));
    var parsed = null;
    if (raw) {
        try { parsed = JSON.parse(raw); } catch (error) { log("脚本数据解析失败：" + error); }
    }
    this.applyScriptData(normalizeScript(parsed), false);
};

// 用整理好的数据替换当前脚本（载入方案时也走这里）。createWindows=true 时立即创建圆点窗口。
AutoClicker.prototype.applyScriptData = function (normalized, createWindows) {
    for (var i = 0; i < this.scriptPoints.length; i += 1) {
        if (this.scriptPoints[i].panel) this.scriptPoints[i].panel.orderOut(null);
    }
    this.script = normalized.script;
    this.scriptPoints = [];
    var idMap = {};
    for (var j = 0; j < normalized.points.length; j += 1) {
        var p = normalized.points[j];
        var id = this.nextScriptPointID;
        this.nextScriptPointID += 1;
        idMap[p.id] = id;
        this.scriptPoints.push({
            id: id, name: p.name, rx: p.rx, ry: p.ry, delayMs: p.delayMs,
            x: 0, y: 0, panel: null, view: null, script: true
        });
    }
    // 点位 id 重新编号了，规则和默认连点里的引用也跟着换
    for (var k = 0; k < this.script.rules.length; k += 1) {
        var action = this.script.rules[k].action;
        if (action.point !== null) action.point = idMap[action.point] !== undefined ? idMap[action.point] : null;
    }
    this.script.defaultPoints = this.script.defaultPoints
        .map(function (old) { return idMap[old]; })
        .filter(function (n) { return n !== undefined; });

    this.scopeWindowBounds = null;
    this.refreshScopeOrigin(true);
    if (createWindows) {
        for (var m = 0; m < this.scriptPoints.length; m += 1) this.createMarkerWindow(this.scriptPoints[m]);
        this.renumberScriptMarkers();
    }
};

AutoClicker.prototype.serializeScript = function () {
    var data = deepCopy(this.script);
    data.points = this.scriptPoints.map(function (p) {
        return { id: p.id, name: p.name, rx: p.rx, ry: p.ry, delayMs: p.delayMs };
    });
    return data;
};

AutoClicker.prototype.saveScript = function () {
    this.defaults.setObjectForKey(JSON.stringify(this.serializeScript()), "scriptJSON");
    this.defaults.synchronize;
};

AutoClicker.prototype.imageByID = function (id) {
    for (var i = 0; i < this.script.images.length; i += 1) {
        if (this.script.images[i].id === id) return this.script.images[i];
    }
    return null;
};

AutoClicker.prototype.scriptPointByID = function (id) {
    for (var i = 0; i < this.scriptPoints.length; i += 1) {
        if (this.scriptPoints[i].id === id) return this.scriptPoints[i];
    }
    return null;
};

AutoClicker.prototype.imagePath = function (image) {
    return IMAGES_DIR + "/" + image.file;
};

// ---------------------------------------------------------------------------
// 扫描范围与窗口跟踪
// ---------------------------------------------------------------------------

AutoClicker.prototype.listWindows = function () {
    var result = [];
    try {
        var ref = $.CGWindowListCopyWindowInfo(
            $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0
        );
        var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
        var myPid = jsNumber($.NSProcessInfo.processInfo.processIdentifier);
        for (var i = 0; i < list.length; i += 1) {
            var w = list[i];
            var b = w.kCGWindowBounds || {};
            if (w.kCGWindowLayer !== 0 || w.kCGWindowOwnerPID === myPid) continue;
            if (Number(b.Width) < 80 || Number(b.Height) < 60) continue;
            result.push({
                number: Number(w.kCGWindowNumber),
                owner: String(w.kCGWindowOwnerName || tr("未知应用")),
                name: String(w.kCGWindowName || ""),
                bounds: { x: Number(b.X), y: Number(b.Y), w: Number(b.Width), h: Number(b.Height) }
            });
        }
    } catch (error) {
        log("读取窗口列表失败：" + error);
    }
    return result;
};

// 只查一个窗口（kCGWindowListOptionIncludingWindow），比列出全部窗口轻得多，运行中每秒查一次。
AutoClicker.prototype.boundsOfWindowNumber = function (number) {
    if (!number) return null;
    try {
        var ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionIncludingWindow || 8, number);
        var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
        if (!list.length || list[0].kCGWindowIsOnscreen === false) return null;
        var b = list[0].kCGWindowBounds || {};
        return { x: Number(b.X), y: Number(b.Y), w: Number(b.Width), h: Number(b.Height) };
    } catch (error) {
        return null;
    }
};

// 找到当前选定的窗口：先按窗口编号，找不到再按"应用名 + 窗口标题"，最后只按应用名（应用重开后编号会变）。
AutoClicker.prototype.locateScopeWindow = function (fullSearch) {
    var target = this.script.scope.window;
    if (!target) return null;
    var bounds = this.boundsOfWindowNumber(target.number);
    if (bounds || !fullSearch) return bounds;

    var windows = this.listWindows();
    var match = null;
    for (var i = 0; i < windows.length && !match; i += 1) {
        if (windows[i].owner === target.owner && windows[i].name === target.name) match = windows[i];
    }
    for (var j = 0; j < windows.length && !match; j += 1) {
        if (windows[j].owner === target.owner) match = windows[j];
    }
    if (!match) return null;
    if (target.number !== match.number) {
        log("扫描窗口编号变化：" + target.number + " → " + match.number + "（" + match.owner + "）");
        target.number = match.number;
        target.name = match.name;
    }
    return match.bounds;
};

// 重新确定扫描范围的原点；窗口移动了就把点位圆点跟着移过去。返回原点是否变化。
AutoClicker.prototype.refreshScopeOrigin = function (fullSearch) {
    var scope = this.script.scope;
    var before = this.scopeWindowBounds;
    if (scope.type === "window") {
        var bounds = this.locateScopeWindow(fullSearch);
        this.scopeWindowBounds = bounds;
        if (bounds) scope.window.lastBounds = bounds;
    } else {
        this.scopeWindowBounds = null;
    }
    var changed = JSON.stringify(before) !== JSON.stringify(this.scopeWindowBounds);
    this.positionScriptPoints();
    return changed;
};

AutoClicker.prototype.scopeOrigin = function () {
    var scope = this.script.scope;
    if (scope.type === "window") {
        var b = this.scopeWindowBounds || (scope.window && scope.window.lastBounds);
        if (b) return { x: b.x, y: b.y };
    }
    return { x: 0, y: 0 };
};

// 当前扫描区域（CG 坐标），找不到窗口时返回 null
AutoClicker.prototype.scanRegion = function () {
    var scope = this.script.scope;
    if (scope.type === "window") return this.scopeWindowBounds;
    if (scope.type === "region") return scope.region;
    return allScreensCGRect();
};

AutoClicker.prototype.positionScriptPoints = function () {
    var origin = this.scopeOrigin();
    for (var i = 0; i < this.scriptPoints.length; i += 1) {
        var p = this.scriptPoints[i];
        var x = origin.x + p.rx;
        var y = origin.y + p.ry;
        var moved = x !== p.x || y !== p.y;
        p.x = x;
        p.y = y;
        if (moved && p.panel && this.draggingMarkerID !== p.id) {
            var center = cgPointToAppKit(x, y);
            var size = Number(p.panel.frame.size.width);
            p.panel.setFrameOrigin($.NSMakePoint(center.x - size / 2, center.y - size / 2));
        }
    }
};

// 换扫描范围时，点位在屏幕上的位置保持不变，只把相对坐标换算到新的原点。
AutoClicker.prototype.changeScope = function (mutate) {
    var oldOrigin = this.scopeOrigin();
    var absolute = this.scriptPoints.map(function (p) { return { x: oldOrigin.x + p.rx, y: oldOrigin.y + p.ry }; });
    mutate();
    this.scopeWindowBounds = null;
    this.refreshScopeOrigin(true);
    var newOrigin = this.scopeOrigin();
    for (var i = 0; i < this.scriptPoints.length; i += 1) {
        this.scriptPoints[i].rx = absolute[i].x - newOrigin.x;
        this.scriptPoints[i].ry = absolute[i].y - newOrigin.y;
    }
    this.positionScriptPoints();
    this.saveScript();
    this.rebuildScriptPointList();
    this.updateUI();
};

AutoClicker.prototype.scopeDescription = function () {
    var scope = this.script.scope;
    if (scope.type === "window") {
        var w = scope.window;
        if (!w) return tr("还没有选择窗口，点“选一个窗口…”");
        var title = w.owner + (w.name ? " — " + w.name : "");
        var b = this.scopeWindowBounds;
        return tr("窗口：") + title + (b ? tr("（") + Math.round(b.w) + "×" + Math.round(b.h) + tr("，会跟着窗口移动）") : tr("（现在找不到这个窗口）"));
    }
    if (scope.type === "region") {
        var r = scope.region;
        if (!r) return tr("还没有框选区域，点“框选区域…”");
        return tr("区域：从 (") + Math.round(r.x) + ", " + Math.round(r.y) + tr(") 开始 ") + Math.round(r.w) + "×" + Math.round(r.h);
    }
    var all = allScreensCGRect();
    return tr("整个屏幕（") + Math.round(all.w) + "×" + Math.round(all.h) + tr("）");
};

// ---------------------------------------------------------------------------
// 进入 / 离开脚本模式
// ---------------------------------------------------------------------------

AutoClicker.prototype.enterScriptMode = function () {
    log("模式选择：脚本");
    this.mode = "script";
    if (this.modeWindow) this.modeWindow.orderOut(null);
    if (!this.scriptToolbar) this.buildScriptToolbar();
    for (var i = 0; i < this.scriptPoints.length; i += 1) {
        if (!this.scriptPoints[i].panel) this.createMarkerWindow(this.scriptPoints[i]);
    }
    this.refreshScopeOrigin(true);
    this.renumberScriptMarkers();
    this.rebuildScriptLists();
    this.statusNote = "";
    this.startScriptEditTimer();
    this.showToolbar();
    this.updateUI();
};

AutoClicker.prototype.leaveScriptMode = function () {
    this.stopScriptEditTimer();
    if (this.scriptToolbar) this.scriptToolbar.orderOut(null);
};

// 编辑时也每秒跟踪一次窗口位置，让圆点跟着窗口走。
AutoClicker.prototype.startScriptEditTimer = function () {
    if (this.scriptEditTimer) return;
    var self = this;
    this.scriptEditTimer = scheduleRepeating(WINDOW_TRACK_MS / 1000, function (timer) {
        if (self.mode !== "script" || self.isClicking || self.overlay) return;
        if (self.script.scope.type !== "window") return;
        var wasFound = Boolean(self.scopeWindowBounds);
        var changed = self.refreshScopeOrigin(!wasFound);
        if (changed) {
            self.scopeLabel.stringValue = self.scopeDescription();
            if (wasFound !== Boolean(self.scopeWindowBounds)) self.updateUI();
        }
    });
};

AutoClicker.prototype.stopScriptEditTimer = function () {
    if (this.scriptEditTimer) this.scriptEditTimer.invalidate;
    this.scriptEditTimer = null;
};

AutoClicker.prototype.currentToolbar = function () {
    return this.mode === "script" && this.scriptToolbar ? this.scriptToolbar : this.toolbar;
};

// ---------------------------------------------------------------------------
// 脚本工具栏
// ---------------------------------------------------------------------------

AutoClicker.prototype.scriptControl = function (control, command, editable) {
    control.identifier = command;
    control.target = this.scriptTarget;
    control.action = $.NSSelectorFromString("scriptCommand:");
    if (editable !== false) this.scriptEditControls.push(control);
    return control;
};

AutoClicker.prototype.scriptButton = function (title, frame, command, editable) {
    var button = $.NSButton.alloc.initWithFrame(frame);
    button.title = title;
    button.bezelStyle = $.NSBezelStyleRounded;
    return this.scriptControl(button, command, editable);
};

AutoClicker.prototype.smallButton = function (title, frame, command) {
    var button = $.NSButton.alloc.initWithFrame(frame);
    button.title = title;
    button.bezelStyle = $.NSBezelStyleRounded;
    button.controlSize = $.NSControlSizeSmall;
    button.font = $.NSFont.systemFontOfSize(11);
    button.identifier = command;
    button.target = this.scriptTarget;
    button.action = $.NSSelectorFromString("scriptCommand:");
    return button;
};

// 下拉菜单：items 是 [{title, enabled}] 或字符串；逐项添加（addItemsWithTitles 会合并同名项）。
// 每一项都单独设置 target/action（命令写在 identifier、序号写在 tag）：
// 自己加进去的菜单项如果 action 为空，选中后下拉按钮不会发出动作，选择就丢了。
AutoClicker.prototype.makePopup = function (frame, items, selectedIndex, command) {
    var popup = $.NSPopUpButton.alloc.initWithFramePullsDown(frame, false);
    popup.font = $.NSFont.systemFontOfSize(12);
    popup.controlSize = $.NSControlSizeSmall;
    var menu = popup.menu;
    menu.autoenablesItems = false;
    for (var i = 0; i < items.length; i += 1) {
        var spec = typeof items[i] === "string" ? { title: items[i] } : items[i];
        var item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(spec.title, null, "");
        item.tag = i;
        item.identifier = command;
        item.target = this.scriptTarget;
        item.action = $.NSSelectorFromString("scriptCommand:");
        if (spec.enabled === false) item.enabled = false;
        menu.addItem(item);
    }
    if (selectedIndex >= 0 && selectedIndex < items.length) popup.selectItemAtIndex(selectedIndex);
    popup.identifier = command;
    return popup;
};

AutoClicker.prototype.makeScrollList = function (frame) {
    var scroll = $.NSScrollView.alloc.initWithFrame(frame);
    scroll.hasVerticalScroller = true;
    scroll.autohidesScrollers = true;
    scroll.borderType = $.NSBezelBorder;
    scroll.drawsBackground = false;
    return scroll;
};

AutoClicker.prototype.buildScriptToolbar = function () {
    var W = SCRIPT_TOOLBAR_WIDTH, H = SCRIPT_TOOLBAR_HEIGHT;
    var visible = primaryScreenFrame();
    var x = Number(visible.origin.x) + Math.max(20, Number(visible.size.width) - W - 24);
    var y = Number(visible.origin.y) + Math.max(30, (Number(visible.size.height) - H) / 2);

    var panel = $.AutoClickerPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(x, y, W, H),
        $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskUtilityWindow,
        $.NSBackingStoreBuffered,
        false
    );
    panel.title = tr("AutoClicker · 脚本模式");
    panel.releasedWhenClosed = false;
    panel.floatingPanel = true;
    panel.hidesOnDeactivate = false;
    panel.level = $.NSFloatingWindowLevel;
    panel.collectionBehavior =
        $.NSWindowCollectionBehaviorCanJoinAllSpaces |
        $.NSWindowCollectionBehaviorFullScreenAuxiliary;

    var content = $.AutoClickerFlippedView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    panel.contentView = content;
    var secondary = $.NSColor.secondaryLabelColor;
    var L = 16, LW = 360, R = 396, RW = 368;

    // 顶部：标题、模式切换、状态
    content.addSubview(this.makeLabel(tr("脚本模式"), $.NSMakeRect(L, 12, 200, 28), 20, true, $.NSColor.labelColor));
    content.addSubview(this.extraButton(tr("— 最小化"), $.NSMakeRect(W - 16 - 80 - 100 - 96, 12, 92, 28), "mini.minimize",
        tr("收成一条小条，不挡住屏幕")));
    content.addSubview(this.extraButton(tr("📱 手机遥控"), $.NSMakeRect(W - 16 - 80 - 100, 12, 96, 28), "remote.panel",
        tr("用手机看状态、开始和停止")));
    var modeButton = this.scriptButton(tr("⇄ 模式"), $.NSMakeRect(W - 16 - 80, 12, 80, 28), "mode");
    modeButton.toolTip = tr("回到模式选择页");
    content.addSubview(modeButton);
    this.scriptStatusLabel = this.makeLabel(tr("● 已停止"), $.NSMakeRect(L, 44, W - 32, 22), 13, true, secondary);
    content.addSubview(this.scriptStatusLabel);

    // 左栏：扫描范围
    content.addSubview(this.makeLabel(tr("扫描范围"), $.NSMakeRect(L, 76, 120, 20), 12, true, $.NSColor.labelColor));
    // 三个普通按钮（不用下拉菜单：在下拉菜单的回调里再弹出窗口菜单，有时会直接被吞掉）
    this.scopeButtons = {
        screen: this.scriptButton(tr("整个屏幕"), $.NSMakeRect(L, 96, 116, 30), "scope.screen"),
        window: this.scriptButton(tr("选一个窗口…"), $.NSMakeRect(L + 122, 96, 116, 30), "scope.window"),
        region: this.scriptButton(tr("框选区域…"), $.NSMakeRect(L + 244, 96, 116, 30), "scope.region")
    };
    content.addSubview(this.scopeButtons.screen);
    content.addSubview(this.scopeButtons.window);
    content.addSubview(this.scopeButtons.region);
    this.scopeLabel = this.makeLabel("", $.NSMakeRect(L, 128, LW, 32), 11, false, secondary);
    this.scopeLabel.lineBreakMode = $.NSLineBreakByWordWrapping;
    content.addSubview(this.scopeLabel);

    // 左栏：图片
    content.addSubview(this.makeLabel(tr("图片（框选或上传）"), $.NSMakeRect(L, 168, 126, 20), 12, true, $.NSColor.labelColor));
    content.addSubview(this.scriptButton(tr("清空"), $.NSMakeRect(L + LW - 228, 162, 60, 30), "image.clear"));
    content.addSubview(this.scriptButton(tr("上传"), $.NSMakeRect(L + LW - 164, 162, 80, 30), "image.upload"));
    content.addSubview(this.scriptButton(tr("取样"), $.NSMakeRect(L + LW - 80, 162, 80, 30), "image.sample"));
    this.imagesScroll = this.makeScrollList($.NSMakeRect(L, 194, LW, 150));
    content.addSubview(this.imagesScroll);

    // 左栏：点位
    content.addSubview(this.makeLabel(tr("点位"), $.NSMakeRect(L, 356, 60, 20), 12, true, $.NSColor.labelColor));
    content.addSubview(this.scriptButton(tr("清空"), $.NSMakeRect(L + 46, 350, 54, 30), "point.clear"));
    content.addSubview(this.scriptButton(tr("放置"), $.NSMakeRect(L + LW - 256, 350, 60, 30), "point.add"));
    var importButton = this.scriptButton(tr("导入…"), $.NSMakeRect(L + LW - 192, 350, 84, 30), "point.import");
    importButton.toolTip = tr("从点击模式现在的点位，或点击模式保存过的方案导入");
    content.addSubview(importButton);
    content.addSubview(this.scriptButton(tr("圆点大小…"), $.NSMakeRect(L + LW - 104, 350, 104, 30), "point.size"));
    this.scriptPointsScroll = this.makeScrollList($.NSMakeRect(L, 382, LW, 150));
    content.addSubview(this.scriptPointsScroll);

    // 左栏底部：权限、紧急停止、眼睛状态
    this.scriptAxButton = this.scriptButton(tr("辅助功能"), $.NSMakeRect(L, 542, 176, 30), "perm.ax", false);
    content.addSubview(this.scriptAxButton);
    this.scriptScreenButton = this.scriptButton(tr("屏幕录制"), $.NSMakeRect(L + 184, 542, 176, 30), "perm.screen", false);
    content.addSubview(this.scriptScreenButton);
    this.scriptEmergencyLabel = this.makeLabel(tr("紧急停止：按 Esc"), $.NSMakeRect(L, 580, LW, 20), 12, true, $.NSColor.systemRedColor);
    content.addSubview(this.scriptEmergencyLabel);
    this.eyeStatusLabel = this.makeLabel("", $.NSMakeRect(L, 602, LW, 20), 11, false, secondary);
    content.addSubview(this.eyeStatusLabel);

    // 右栏：规则
    content.addSubview(this.makeLabel(tr("规则（从上往下，执行第一条成立的）"), $.NSMakeRect(R, 76, 216, 20), 12, true, $.NSColor.labelColor));
    content.addSubview(this.scriptButton(tr("清空"), $.NSMakeRect(R + RW - 150, 70, 60, 30), "rule.clear"));
    content.addSubview(this.scriptButton(tr("添加规则"), $.NSMakeRect(R + RW - 84, 70, 84, 30), "rule.add"));
    this.activityLabel = this.makeLabel("", $.NSMakeRect(R, 100, RW, 18), 11, true, $.NSColor.systemGreenColor);
    content.addSubview(this.activityLabel);
    this.rulesScroll = this.makeScrollList($.NSMakeRect(R, 120, RW, 268));
    content.addSubview(this.rulesScroll);

    // 右栏：默认规则
    var defaultBox = $.NSBox.alloc.initWithFrame($.NSMakeRect(R, 396, RW, 40));
    defaultBox.boxType = $.NSBoxCustom;
    defaultBox.titlePosition = $.NSNoTitle;
    defaultBox.borderWidth = 1;
    defaultBox.cornerRadius = 6;
    defaultBox.borderColor = $.NSColor.separatorColor;
    defaultBox.fillColor = $.NSColor.quaternaryLabelColor;
    content.addSubview(defaultBox);
    content.addSubview(this.makeLabel(tr("以上都没对上 → 连点"), $.NSMakeRect(R + 10, 406, 150, 20), 12, true, $.NSColor.labelColor));
    this.defaultPointsPopup = $.NSPopUpButton.alloc.initWithFramePullsDown($.NSMakeRect(R + 160, 403, RW - 170, 26), true);
    this.defaultPointsPopup.font = $.NSFont.systemFontOfSize(12);
    this.scriptEditControls.push(this.defaultPointsPopup);
    content.addSubview(this.defaultPointsPopup);

    // 右栏：停止条件与设置
    this.idleStopButton = this.scriptButton("", $.NSMakeRect(R, 444, 216, 30), "idleStop");
    content.addSubview(this.idleStopButton);
    this.scanRateButton = this.scriptButton("", $.NSMakeRect(R + 222, 444, RW - 222, 30), "scanRate");
    this.scanRateButton.toolTip = tr("越高反应越快，也越占 CPU");
    content.addSubview(this.scanRateButton);
    content.addSubview(this.makeLabel(tr("提示：这个时间要比一轮完整流程的时长更长"), $.NSMakeRect(R + 4, 474, RW, 16), 10, false, secondary));
    this.scriptDurationButton = this.scriptButton("", $.NSMakeRect(R, 494, 180, 30), "duration");
    content.addSubview(this.scriptDurationButton);
    this.scriptJitterButton = this.scriptButton("", $.NSMakeRect(R + 188, 494, 180, 30), "jitter");
    content.addSubview(this.scriptJitterButton);

    this.scriptLayoutPopup = $.NSPopUpButton.alloc.initWithFramePullsDown($.NSMakeRect(R, 530, 180, 28), true);
    this.scriptEditControls.push(this.scriptLayoutPopup);
    content.addSubview(this.scriptLayoutPopup);
    this.dryRunBox = $.NSButton.alloc.initWithFrame($.NSMakeRect(R + 190, 532, 178, 24));
    this.dryRunBox.setButtonType($.NSButtonTypeSwitch);
    this.dryRunBox.title = tr("演练（只识别不点击）");
    this.dryRunBox.state = this.scriptDryRun ? 1 : 0;
    this.scriptControl(this.dryRunBox, "dryRun");
    content.addSubview(this.dryRunBox);

    content.addSubview(this.makeAutoMinimizeBox($.NSMakeRect(R, 566, RW, 22)));

    this.scriptStartButton = this.scriptButton(tr("▶ 开始脚本（3 秒后）"), $.NSMakeRect(R, 598, RW, 46), "start", false);
    this.scriptStartButton.bezelStyle = $.NSBezelStyleRegularSquare;
    this.scriptStartButton.font = $.NSFont.boldSystemFontOfSize(15);
    content.addSubview(this.scriptStartButton);

    this.scriptToolbar = panel;
    this.rebuildScriptLayoutMenu();
};

// 换掉列表的内容视图。旧视图里的按钮如果带鼠标悬停提示（toolTip），系统的提示管理器会记着它们；
// 旧视图被 JXA 回收后，下次窗口变成焦点时提示管理器去访问它们就会闪退。
// 所以先把旧视图里所有提示删掉，再把旧视图留一阵子（最多 50 份）不让它立刻被回收。
function removeToolTipsDeep(view) {
    view.removeAllToolTips;
    var subviews = view.subviews;
    for (var i = 0; i < jsNumber(subviews.count); i += 1) removeToolTipsDeep(subviews.objectAtIndex(i));
}

AutoClicker.prototype.replaceListDocument = function (scroll, doc) {
    var old = scroll.documentView;
    if (!isNil(old)) {
        removeToolTipsDeep(old);
        this.retiredListViews = this.retiredListViews || [];
        this.retiredListViews.push(old);
        if (this.retiredListViews.length > 50) this.retiredListViews.shift();
    }
    scroll.documentView = doc;
};

AutoClicker.prototype.rebuildScriptLists = function () {
    if (!this.scriptToolbar) return;
    this.rebuildScriptImageList();
    this.rebuildScriptPointList();
    this.rebuildRuleList();
    this.rebuildDefaultPointsMenu();
};

AutoClicker.prototype.emptyListLabel = function (documentView, text, width) {
    var label = this.makeLabel(text, $.NSMakeRect(10, 50, width - 20, 44), 12, false, $.NSColor.secondaryLabelColor);
    label.alignment = $.NSTextAlignmentCenter;
    label.lineBreakMode = $.NSLineBreakByWordWrapping;
    documentView.addSubview(label);
};

AutoClicker.prototype.rebuildScriptImageList = function () {
    var rowHeight = 32, width = 342;
    var images = this.script.images;
    var editing = !this.isClicking && !this.countdownTimer;
    var doc = $.AutoClickerFlippedView.alloc.initWithFrame($.NSMakeRect(0, 0, width, Math.max(146, images.length * rowHeight + 4)));
    this.imageScoreLabels = {};
    if (!images.length) this.emptyListLabel(doc, tr("点“取样”框住按钮或文字，或者“上传”一张图片"), width);

    for (var i = 0; i < images.length; i += 1) {
        var image = images[i];
        var y = 2 + i * rowHeight;
        var thumb = $.NSImageView.alloc.initWithFrame($.NSMakeRect(4, y + 3, 40, 26));
        var picture = $.NSImage.alloc.initWithContentsOfFile(this.imagePath(image));
        if (!isNil(picture)) thumb.image = picture;
        thumb.imageScaling = $.NSImageScaleProportionallyDown;
        thumb.toolTip = image.w + "×" + image.h + (image.uploaded ? tr("（上传") + (image.scale ? tr("，已记住大小 ") + Math.round(image.scale * 100) + "%" : tr("，运行时自动找大小")) + tr("）") : "");
        doc.addSubview(thumb);

        var nameButton = this.smallButton(image.name, $.NSMakeRect(48, y + 4, 104, 24), "image.rename:" + i);
        nameButton.toolTip = tr("改名");
        nameButton.enabled = editing;
        doc.addSubview(nameButton);

        var thresholdButton = this.smallButton(tr("门槛 ") + image.threshold.toFixed(2), $.NSMakeRect(154, y + 4, 76, 24), "image.threshold:" + i);
        thresholdButton.toolTip = tr("相似度达到这个值才算“看到”");
        thresholdButton.enabled = editing;
        doc.addSubview(thresholdButton);

        var score = this.makeLabel("—", $.NSMakeRect(234, y + 8, 76, 18), 11, true, $.NSColor.secondaryLabelColor);
        score.font = $.NSFont.monospacedDigitSystemFontOfSizeWeight(11, $.NSFontWeightSemibold);
        doc.addSubview(score);
        this.imageScoreLabels[image.id] = score;

        var del = this.smallButton("×", $.NSMakeRect(312, y + 4, 26, 24), "image.delete:" + i);
        del.enabled = editing;
        doc.addSubview(del);
    }
    this.replaceListDocument(this.imagesScroll, doc);
};

AutoClicker.prototype.rebuildScriptPointList = function () {
    if (!this.scriptToolbar) return;
    var rowHeight = 32, width = 342;
    var editing = !this.isClicking && !this.countdownTimer;
    var points = this.scriptPoints;
    var doc = $.AutoClickerFlippedView.alloc.initWithFrame($.NSMakeRect(0, 0, width, Math.max(146, points.length * rowHeight + 4)));
    if (!points.length) this.emptyListLabel(doc, tr("点“放置”添加点位，或“从点击模式导入”"), width);

    for (var i = 0; i < points.length; i += 1) {
        var p = points[i];
        var y = 2 + i * rowHeight;
        if (p.id === this.selectedMarkerID) {
            var gold = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1.0, 0.78, 0.12, 1.0);
            var highlight = $.NSBox.alloc.initWithFrame($.NSMakeRect(1, y, width - 2, rowHeight - 2));
            highlight.boxType = $.NSBoxCustom;
            highlight.titlePosition = $.NSNoTitle;
            highlight.borderWidth = 1;
            highlight.cornerRadius = 6;
            highlight.borderColor = gold;
            highlight.fillColor = gold.colorWithAlphaComponent(0.25);
            doc.addSubview(highlight);
        }
        var number = this.makeLabel(String(i + 1), $.NSMakeRect(2, y + 7, 22, 20), 13, true, $.NSColor.systemGreenColor);
        number.alignment = $.NSTextAlignmentCenter;
        doc.addSubview(number);

        var nameButton = this.smallButton(p.name, $.NSMakeRect(26, y + 4, 100, 24), "point.rename:" + i);
        nameButton.toolTip = tr("改名");
        nameButton.enabled = editing;
        doc.addSubview(nameButton);

        var coords = this.makeLabel(Math.round(p.rx) + ", " + Math.round(p.ry), $.NSMakeRect(130, y + 9, 74, 16), 10, false, $.NSColor.secondaryLabelColor);
        coords.font = $.NSFont.monospacedSystemFontOfSizeWeight(10, $.NSFontWeightRegular);
        coords.toolTip = this.script.scope.type === "window" ? tr("相对窗口左上角的位置") : tr("屏幕坐标");
        doc.addSubview(coords);

        // 盖在编号和坐标上的透明按钮：点这里选中该点（圆点闪烁）
        var select = $.NSButton.alloc.initWithFrame($.NSMakeRect(126, y, 80, rowHeight - 2));
        select.title = "";
        select.bordered = false;
        select.transparent = true;
        select.tag = p.id;
        select.target = this.actionTarget;
        select.action = $.NSSelectorFromString("selectPoint:");
        select.enabled = editing;
        doc.addSubview(select);

        var interval = this.smallButton(p.delayMs + " ms", $.NSMakeRect(208, y + 4, 100, 24), "point.interval:" + i);
        interval.toolTip = tr("默认连点时，点完这个点后等多久再点下一个");
        interval.enabled = editing;
        doc.addSubview(interval);

        var del = this.smallButton("×", $.NSMakeRect(312, y + 4, 26, 24), "point.delete:" + i);
        del.enabled = editing;
        doc.addSubview(del);
    }
    this.replaceListDocument(this.scriptPointsScroll, doc);
};

function isClickAction(action) {
    return action.type === "clickPoint" || action.type === "runLayout";
}

// 规则卡片在条件行和动作行之外多出来的行数（"次数"行、"直到"行）
function ruleExtraRows(rule) {
    if (!isClickAction(rule.action)) return 0;
    return rule.action.times === 0 ? 2 : 1;
}

// 下拉菜单选中的序号：菜单项发来的看 tag，下拉按钮本身发来的看 indexOfSelectedItem
function popupIndex(sender) {
    if (jsString(sender.className) === "NSMenuItem") return jsNumber(sender.tag);
    return jsNumber(sender.indexOfSelectedItem);
}

// 规则的显示名："规则 2「开始」"；没起名字时就是"规则 2"
function ruleTitle(rule, index) {
    return tr("规则 ") + (index + 1) + (rule && rule.name ? tr("「") + rule.name + tr("」") : "");
}

// "次数"按钮上的文字，例如"点 3 次，每次间隔 300 毫秒…"
function timesSummary(action) {
    if (action.type === "runLayout") {
        var roundGap = tr("每轮之间再等 ") + Math.round(action.gap * 1000) + tr(" 毫秒");
        if (action.times === 0) return tr("一直运行，直到下面的条件满足（") + roundGap + tr("）…");
        if (action.times === 1) return tr("运行 1 轮…");
        return tr("运行 ") + action.times + tr(" 轮，") + roundGap + "…";
    }
    var gapText = tr("每次间隔 ") + Math.round(action.gap * 1000) + tr(" 毫秒");
    if (action.times === 0) return tr("一直点，直到下面的条件满足（") + gapText + tr("）…");
    if (action.times === 1) return tr("点 1 次…");
    return tr("点 ") + action.times + tr(" 次，") + gapText + "…";
}

// 规则卡片：标题行（规则 N、+条件、↑、↓、删除）+ 每个条件一行 + 动作一行
AutoClicker.prototype.rebuildRuleList = function () {
    var width = 350, line = 28;
    var rules = this.script.rules;
    var editing = !this.isClicking && !this.countdownTimer;
    var heights = rules.map(function (r) { return (r.conds.length + 2 + ruleExtraRows(r)) * line + 10; });
    var total = heights.reduce(function (a, b) { return a + b + 6; }, 4);
    var doc = $.AutoClickerFlippedView.alloc.initWithFrame($.NSMakeRect(0, 0, width, Math.max(264, total)));
    this.ruleBoxes = [];
    this.ruleCardFrames = [];
    this.ruleDragIndicator = null;
    if (!rules.length) this.emptyListLabel(doc, tr("点“添加规则”。例如：看到[开始按钮] → 点击[图片中心]"), width);

    var imageItems = [{ title: tr("（选择图片）"), enabled: false }].concat(this.script.images.map(function (img) { return img.name; }));
    var pointItems = [{ title: tr("（选择点位）"), enabled: false }].concat(this.scriptPoints.map(function (p, i) { return (i + 1) + ". " + p.name; }));
    var y = 4;
    for (var r = 0; r < rules.length; r += 1) {
        var rule = rules[r];
        var box = $.NSBox.alloc.initWithFrame($.NSMakeRect(2, y, width - 4, heights[r]));
        box.boxType = $.NSBoxCustom;
        box.titlePosition = $.NSNoTitle;
        box.borderWidth = 1;
        box.cornerRadius = 6;
        box.borderColor = $.NSColor.separatorColor;
        box.fillColor = $.NSColor.clearColor;
        doc.addSubview(box);
        this.ruleBoxes.push(box);
        this.ruleCardFrames.push({ top: y, bottom: y + heights[r] });

        var cy = y + 5;
        var handle = $.AutoClickerRuleHandle.alloc.initWithFrame($.NSMakeRect(6, cy + 1, 20, 24));
        handle.title = "≡";
        handle.bordered = false;
        handle.font = $.NSFont.boldSystemFontOfSize(16);
        handle.tag = r;
        handle.enabled = editing && rules.length > 1;
        handle.toolTip = tr("按住这里上下拖动，可以把整条规则移到任意位置（例如拖到第一）");
        doc.addSubview(handle);
        doc.addSubview(this.makeLabel(tr("规则 ") + (r + 1), $.NSMakeRect(28, cy + 4, 50, 18), 12, true, $.NSColor.labelColor));
        var nameButton = this.smallButton(rule.name || tr("起名字…"), $.NSMakeRect(76, cy, 104, 24), "rule.rename:" + r);
        nameButton.toolTip = tr("给这条规则起个名字，方便区分（序号还是会显示）");
        nameButton.enabled = editing;
        doc.addSubview(nameButton);
        var headerButtons = [
            { title: tr("+ 条件"), w: 52, cmd: "rule.addCond:" + r, enabled: rule.conds.length < MAX_CONDITIONS, tip: tr("给这条规则再加一个条件") },
            { title: "↑", w: 28, cmd: "rule.up:" + r, enabled: r > 0, tip: tr("把整条规则往上移一位（越靠上越优先）") },
            { title: "↓", w: 28, cmd: "rule.down:" + r, enabled: r < rules.length - 1, tip: tr("把整条规则往下移一位") },
            { title: tr("删除"), w: 44, cmd: "rule.delete:" + r, enabled: true, tip: tr("删除整条规则") }
        ];
        var hx = width - 8;
        for (var h = headerButtons.length - 1; h >= 0; h -= 1) {
            hx -= headerButtons[h].w;
            var hb = this.smallButton(headerButtons[h].title, $.NSMakeRect(hx, cy, headerButtons[h].w, 24), headerButtons[h].cmd);
            hb.enabled = editing && headerButtons[h].enabled;
            hb.toolTip = headerButtons[h].tip;
            doc.addSubview(hb);
            hx -= 2;
        }
        cy += line;

        for (var c = 0; c < rule.conds.length; c += 1) {
            var cond = rule.conds[c];
            if (c === 0) {
                doc.addSubview(this.makeLabel(tr("如果"), $.NSMakeRect(14, cy + 5, 50, 18), 12, false, $.NSColor.labelColor));
            } else {
                var join = this.makePopup($.NSMakeRect(8, cy, 62, 26), [tr("并且"), tr("或者")], cond.join === "or" ? 1 : 0, "cond.join:" + r + ":" + c);
                join.enabled = editing;
                doc.addSubview(join);
            }
            var neg = this.makePopup($.NSMakeRect(72, cy, 80, 26), [tr("看到"), tr("没看到")], cond.neg ? 1 : 0, "cond.neg:" + r + ":" + c);
            neg.enabled = editing;
            doc.addSubview(neg);
            var imageIndex = this.script.images.indexOf(this.imageByID(cond.image)) + 1;
            var items = imageItems;
            if (cond.image && imageIndex === 0) items = [{ title: tr("（图片已删除）"), enabled: false }].concat(imageItems.slice(1));
            var imagePopup = this.makePopup($.NSMakeRect(154, cy, rule.conds.length > 1 ? 160 : 188, 26), items, imageIndex, "cond.image:" + r + ":" + c);
            imagePopup.enabled = editing;
            doc.addSubview(imagePopup);
            if (rule.conds.length > 1) {
                var removeCond = this.smallButton("×", $.NSMakeRect(316, cy + 1, 26, 24), "cond.delete:" + r + ":" + c);
                removeCond.enabled = editing;
                doc.addSubview(removeCond);
            }
            cy += line;
        }

        doc.addSubview(this.makeLabel(tr("就"), $.NSMakeRect(14, cy + 5, 20, 18), 12, false, $.NSColor.labelColor));
        var typeIndex = 0;
        for (var t = 0; t < ACTION_TYPES.length; t += 1) if (ACTION_TYPES[t].type === rule.action.type) typeIndex = t;
        var typePopup = this.makePopup($.NSMakeRect(36, cy, 104, 26), ACTION_TYPES.map(function (a) { return a.label; }), typeIndex, "action.type:" + r);
        typePopup.enabled = editing;
        doc.addSubview(typePopup);

        var target = null;
        if (rule.action.type === "clickPoint") {
            var pi = this.scriptPoints.indexOf(this.scriptPointByID(rule.action.point)) + 1;
            var pItems = pointItems;
            if (rule.action.point !== null && pi === 0) pItems = [{ title: tr("（点位已删除）"), enabled: false }].concat(pointItems.slice(1));
            target = this.makePopup($.NSMakeRect(142, cy, 112, 26), pItems, pi, "action.point:" + r);
        } else if (rule.action.type === "runLayout") {
            var layoutItems = [{ title: tr("（选择点击方案）"), enabled: false }].concat(this.layouts.map(function (l) { return l.name; }));
            var li = rule.action.layout ? this.clickLayoutIndexByName(rule.action.layout.name) + 1 : 0;
            if (rule.action.layout && li === 0) {
                layoutItems = [{ title: rule.action.layout.name + tr("（已删除，用副本）"), enabled: false }].concat(layoutItems.slice(1));
            }
            target = this.makePopup($.NSMakeRect(142, cy, 112, 26), layoutItems, li, "action.layout:" + r);
            target.toolTip = rule.action.layout
                ? tr("运行「") + rule.action.layout.name + tr("」的全部 ") + rule.action.layout.markers.length + tr(" 个点，按方案里的顺序和间隔")
                : tr("只能选点击模式里保存的方案");
        } else {
            target = this.makePopup($.NSMakeRect(142, cy, 112, 26),
                WAIT_CHOICES.map(formatSeconds), WAIT_CHOICES.indexOf(rule.action.seconds), "action.seconds:" + r);
        }
        target.enabled = editing;
        doc.addSubview(target);

        var cooldown = this.makePopup($.NSMakeRect(256, cy, 88, 26),
            COOLDOWN_CHOICES.map(function (s) { return tr("冷却 ") + s + "s"; }),
            COOLDOWN_CHOICES.indexOf(rule.cooldown), "rule.cooldown:" + r);
        cooldown.toolTip = tr("冷却是时间（秒）：这条规则做完动作后，等这么多秒才重新检查规则、恢复默认连点。和扫描次数、点击次数无关");
        cooldown.enabled = editing;
        doc.addSubview(cooldown);

        // 点击动作：点几次（或一直点直到……）、每次间隔
        if (isClickAction(rule.action)) {
            cy += line;
            doc.addSubview(this.makeLabel(tr("次数"), $.NSMakeRect(4, cy + 5, 34, 18), 12, false, $.NSColor.labelColor));
            var timesButton = this.smallButton(timesSummary(rule.action), $.NSMakeRect(36, cy + 1, 308, 24), "action.timesDialog:" + r);
            timesButton.toolTip = tr("点这里填点几次、每次间隔多久，或改成“一直点，直到……”");
            timesButton.enabled = editing;
            doc.addSubview(timesButton);
            if (rule.action.times === 0) {
                cy += line;
                doc.addSubview(this.makeLabel(tr("直到"), $.NSMakeRect(4, cy + 5, 34, 18), 12, false, $.NSColor.labelColor));
                var untilNeg = this.makePopup($.NSMakeRect(36, cy, 104, 26), [tr("看到"), tr("没看到")], rule.action.untilNeg ? 1 : 0, "action.untilNeg:" + r);
                untilNeg.enabled = editing;
                doc.addSubview(untilNeg);
                var ui = this.script.images.indexOf(this.imageByID(rule.action.untilImage)) + 1;
                var uItems = imageItems;
                if (rule.action.untilImage && ui === 0) uItems = [{ title: tr("（图片已删除）"), enabled: false }].concat(imageItems.slice(1));
                var untilImage = this.makePopup($.NSMakeRect(142, cy, 202, 26), uItems, ui, "action.untilImage:" + r);
                untilImage.toolTip = tr("满足这个条件就停止点击。最多连续点 ") + (MAX_UNTIL_SECONDS / 60) + tr(" 分钟；按 Esc 随时停止");
                untilImage.enabled = editing;
                doc.addSubview(untilImage);
            }
        }

        y += heights[r] + 6;
    }
    this.replaceListDocument(this.rulesScroll, doc);
    this.highlightRule(this.isClicking ? this.currentRuleIndex : -1);
};

AutoClicker.prototype.highlightRule = function (index) {
    for (var i = 0; i < this.ruleBoxes.length; i += 1) {
        var active = i === index;
        this.ruleBoxes[i].borderColor = active ? $.NSColor.systemGreenColor : $.NSColor.separatorColor;
        this.ruleBoxes[i].borderWidth = active ? 2 : 1;
        this.ruleBoxes[i].fillColor = active ? $.NSColor.systemGreenColor.colorWithAlphaComponent(0.08) : $.NSColor.clearColor;
    }
};

// 复制点击模式第 index 个方案的全部数据（每个点的位置、顺序、间隔），记下当前扫描窗口的位置
AutoClicker.prototype.copyClickLayout = function (index) {
    var layout = this.layouts[index];
    if (!layout) return null;
    var origin = this.scopeOrigin();
    return normalizeLayoutCopy({
        name: layout.name,
        markers: deepCopy(layout.markers),
        ref: { x: origin.x, y: origin.y, window: this.script.scope.type === "window" }
    });
};

AutoClicker.prototype.clickLayoutIndexByName = function (name) {
    for (var i = 0; i < this.layouts.length; i += 1) if (this.layouts[i].name === name) return i;
    return -1;
};

// 开始运行前：点击模式里同名方案还在，就用它最新的数据更新副本（在点击模式里改了方案，脚本自动跟上）
AutoClicker.prototype.refreshLayoutCopies = function () {
    var self = this;
    function refresh(copy) {
        if (!copy) return;
        var at = self.clickLayoutIndexByName(copy.name);
        if (at < 0) return;
        var fresh = normalizeLayoutCopy({ name: copy.name, markers: deepCopy(self.layouts[at].markers), ref: copy.ref });
        if (fresh) copy.markers = fresh.markers;
    }
    for (var i = 0; i < this.script.rules.length; i += 1) refresh(this.script.rules[i].action.layout);
    refresh(this.script.defaultLayout);
    this.saveScript();
};

// 方案副本换算成这一刻要点的屏幕位置（窗口挪了就整体平移）
AutoClicker.prototype.layoutTargets = function (copy) {
    if (!copy) return [];
    var dx = 0, dy = 0;
    if (copy.ref.window && this.script.scope.type === "window") {
        var origin = this.scopeOrigin();
        dx = origin.x - copy.ref.x;
        dy = origin.y - copy.ref.y;
    }
    return copy.markers.map(function (m, i) {
        return { x: m.x + dx, y: m.y + dy, delayMs: m.delayMs, name: copy.name + tr(" 第 ") + (i + 1) + tr(" 个点") };
    });
};

// 方案在下拉菜单里的显示名；点击模式里已经删掉的，标出来正在用副本
AutoClicker.prototype.layoutCopyLabel = function (copy) {
    if (!copy) return "";
    return copy.name + (this.clickLayoutIndexByName(copy.name) < 0 ? tr("（点击模式里已删除，用保存的副本）") : "");
};

// 默认连点这一刻要点的位置：选了点击方案就用方案，否则用勾选的脚本点位
AutoClicker.prototype.defaultClickTargets = function () {
    if (this.script.defaultAction === "none") return [];
    if (this.script.defaultAction === "layout") return this.layoutTargets(this.script.defaultLayout);
    var origin = this.scopeOrigin();
    return this.defaultClickPoints().map(function (p) {
        return { x: origin.x + p.rx, y: origin.y + p.ry, delayMs: p.delayMs, name: p.name };
    });
};

AutoClicker.prototype.defaultClickPoints = function () {
    var chosen = this.script.defaultPoints;
    if (!chosen.length) return this.scriptPoints.slice();
    return this.scriptPoints.filter(function (p) { return chosen.indexOf(p.id) >= 0; });
};

AutoClicker.prototype.rebuildDefaultPointsMenu = function () {
    var menu = $.NSMenu.alloc.initWithTitle(tr("默认连点"));
    menu.autoenablesItems = false;
    var chosen = this.script.defaultPoints;
    var action = this.script.defaultAction;
    var layout = action === "layout" ? this.script.defaultLayout : null;
    var title;
    if (action === "none") title = tr("什么都不做");
    else if (layout) title = tr("运行点击方案「") + layout.name + tr("」");
    else if (!this.scriptPoints.length) title = tr("（还没有点位）");
    else if (!chosen.length) title = tr("全部点位（") + this.scriptPoints.length + tr(" 个）");
    else title = this.defaultClickPoints().map(function (p) { return p.name; }).join(tr("、"));
    menu.addItem(this.makeMenuItem(title, null, ""));

    var none = this.makeMenuItem(tr("什么都不做"), null, "");
    this.scriptControl(none, "default.none", false);
    none.state = action === "none" ? 1 : 0;
    menu.addItem(none);
    menu.addItem($.NSMenuItem.separatorItem);

    var pointsHeader = this.makeMenuItem(tr("连点脚本模式的点位："), null, "");
    pointsHeader.enabled = false;
    menu.addItem(pointsHeader);
    var all = this.makeMenuItem(tr("    全部点位（按列表顺序）"), null, "");
    this.scriptControl(all, "default.all", false);
    all.state = action === "points" && !chosen.length ? 1 : 0;
    menu.addItem(all);
    for (var i = 0; i < this.scriptPoints.length; i += 1) {
        var p = this.scriptPoints[i];
        var item = this.makeMenuItem("    " + (i + 1) + ". " + p.name, null, "");
        this.scriptControl(item, "default.toggle:" + p.id, false);
        item.state = action === "points" && chosen.indexOf(p.id) >= 0 ? 1 : 0;
        menu.addItem(item);
    }

    menu.addItem($.NSMenuItem.separatorItem);
    var layoutHeader = this.makeMenuItem(this.layouts.length ? tr("或者循环运行点击模式的方案：") : tr("（点击模式还没有保存过方案）"), null, "");
    layoutHeader.enabled = false;
    menu.addItem(layoutHeader);
    for (var j = 0; j < this.layouts.length; j += 1) {
        var li = this.makeMenuItem("    " + this.layouts[j].name + tr("（") + this.layouts[j].markers.length + tr(" 个点）"), null, "");
        this.scriptControl(li, "default.layout:" + j, false);
        li.state = layout && layout.name === this.layouts[j].name ? 1 : 0;
        menu.addItem(li);
    }
    if (layout && this.clickLayoutIndexByName(layout.name) < 0) {
        var orphan = this.makeMenuItem("    " + this.layoutCopyLabel(layout), null, "");
        orphan.state = 1;
        orphan.enabled = false;
        menu.addItem(orphan);
    }
    var hint = this.makeMenuItem(tr("“什么都不做”= 只有规则成立时才点击"), null, "");
    hint.enabled = false;
    menu.addItem($.NSMenuItem.separatorItem);
    menu.addItem(hint);
    this.defaultPointsPopup.menu = menu;
};

AutoClicker.prototype.updateScriptUI = function () {
    if (!this.scriptToolbar) return;
    var editing = !this.isClicking && !this.countdownTimer;

    var statusText = tr("● 已停止 · ") + this.script.images.length + tr(" 张图片 · ") +
        this.scriptPoints.length + tr(" 个点位 · ") + this.script.rules.length + tr(" 条规则");
    var color = $.NSColor.secondaryLabelColor;
    if (this.isClicking) {
        statusText = tr("● 脚本运行中") +
            (this.runDeadline ? tr(" · 剩余 ") + formatClock((this.runDeadline - Date.now()) / 1000) : "") +
            tr("（按 Esc 停止）") + (this.dryRun ? tr(" · 演练模式（不点击）") : "");
        color = $.NSColor.systemGreenColor;
    } else if (this.countdownTimer) {
        statusText = "● " + this.countdownValue + tr(" 秒后开始（按 Esc 取消）");
        color = $.NSColor.systemOrangeColor;
    } else if (this.statusNote) {
        statusText = "● " + this.statusNote;
    }
    this.scriptStatusLabel.stringValue = statusText;
    this.scriptStatusLabel.textColor = color;

    for (var i = 0; i < this.scriptEditControls.length; i += 1) this.scriptEditControls[i].enabled = editing;
    var scopeTitles = { screen: tr("整个屏幕"), window: tr("选一个窗口…"), region: tr("框选区域…") };
    for (var type in scopeTitles) {
        var current = this.script.scope.type === type;
        this.scopeButtons[type].title = (current ? "✓ " : "") + scopeTitles[type];
        this.scopeButtons[type].font = current ? $.NSFont.boldSystemFontOfSize(13) : $.NSFont.systemFontOfSize(13);
    }
    this.scopeLabel.stringValue = this.scopeDescription();
    this.idleStopButton.title = this.script.idleStopMinutes + tr(" 分钟没识别到就停止…");
    this.scanRateButton.title = tr("每秒扫描 ") + this.script.scanRate + tr(" 次…");
    this.scriptDurationButton.title = tr("持续时间：") + formatDuration(this.durationSeconds) + "…";
    this.scriptJitterButton.title = tr("随机扰动：") +
        (this.jitterMs || this.jitterPx ? "±" + this.jitterMs + "ms/±" + this.jitterPx + "px" : tr("关")) + "…";
    this.dryRunBox.state = this.scriptDryRun ? 1 : 0;

    this.scriptStartButton.title = this.isClicking
        ? tr("■ 停止脚本")
        : (this.countdownTimer ? tr("取消开始") : tr("▶ 开始脚本（3 秒后）"));
    this.scriptAxButton.title = this.trusted ? tr("辅助功能：已授权") : tr("辅助功能：未授权…");
    var screenOK = screenCaptureAllowed();
    this.scriptScreenButton.title = screenOK ? tr("屏幕录制：已授权") : tr("屏幕录制：未授权…");

    var emergency = tr("紧急停止：按 Esc");
    if (this.keyStateBroken) emergency += tr(" · 按键轮询失效");
    emergency += tr(" · 看门狗") + (this.watchdogStatus === tr("运行中") ? "✓" : "✗ " + this.watchdogStatus);
    this.scriptEmergencyLabel.stringValue = emergency;
    this.eyeStatusLabel.stringValue = tr("识别进程（眼睛）：") + this.eyeStatus +
        (this.isClicking && this.eyeLastFrameMs ? tr(" · 每帧 ") + this.eyeLastFrameMs + " ms" : "");
    this.scriptToolbar.title = tr("AutoClicker · 脚本模式");
    if (!this.isClicking) this.activityLabel.stringValue = "";
    this.updateMiniBar();
};

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

AutoClicker.prototype.handleScriptCommand = function (command, sender) {
    var parts = command.split(":");
    var name = parts[0];
    var a = Number(parts[1]);
    var b = Number(parts[2]);
    var running = this.isClicking || this.countdownTimer;

    if (this.handleExtraCommand(name, sender)) return;
    if (name === "start") { this.toggleFromToolbar(); return; }
    if (name === "perm.ax") { this.showPermissionDialog(false); return; }
    if (name === "perm.screen") { this.showScreenPermissionDialog(); return; }
    if (running) return;

    switch (name) {
    case "mode": this.returnToModeChooser(); return;
    case "scope.screen": this.scopeTypeChosen("screen", sender); return;
    case "scope.window": if (parts.length > 1) this.chooseScopeWindow(a); else this.scopeTypeChosen("window", sender); return;
    case "scope.region": this.scopeTypeChosen("region", sender); return;
    case "image.sample": this.startImageSample(); return;
    case "image.upload": this.startImageUpload(); return;
    case "image.rename": this.showImageRenameDialog(a); return;
    case "image.threshold": this.showThresholdDialog(a); return;
    case "image.delete": this.showDeleteImageDialog(a); return;
    case "image.clear": this.showClearDialog("image"); return;
    case "point.clear": this.showClearDialog("point"); return;
    case "rule.clear": this.showClearDialog("rule"); return;
    case "point.add": this.addScriptPoint(); return;
    case "point.import": this.showImportMenu(sender); return;
    case "point.importCurrent": this.importClickPoints(null); return;
    case "point.importLayout": this.importClickPoints(a); return;
    case "point.size": this.showMarkerSizeDialog(); return;
    case "point.rename": this.showPointRenameDialog(a); return;
    case "point.interval": this.showScriptIntervalDialog(a); return;
    case "point.delete": this.deleteScriptPoint(a); return;
    case "rule.add": this.addRule(); return;
    case "idleStop": this.showIdleStopDialog(); return;
    case "scanRate": this.showScanRateDialog(); return;
    case "duration": this.showDurationDialog(); return;
    case "jitter": this.showJitterDialog(); return;
    case "dryRun":
        this.scriptDryRun = jsNumber(sender.state) === 1;
        this.defaults.setBoolForKey(this.scriptDryRun, "scriptDryRun");
        this.defaults.synchronize;
        this.statusNote = this.scriptDryRun ? tr("演练模式：开始后只识别、显示相似度，不点击也不按键") : tr("已关闭演练模式");
        this.updateUI();
        return;
    case "default.none":
        this.script.defaultAction = "none";
        this.statusNote = tr("以上都没对上 → 什么都不做");
        break;
    case "default.all":
        this.script.defaultAction = "points";
        this.script.defaultPoints = [];
        break;
    case "default.layout":
        var copy = this.copyClickLayout(a);
        if (!copy) return;
        this.script.defaultLayout = copy;
        this.script.defaultAction = "layout";
        this.statusNote = tr("以上都没对上 → 循环运行点击方案「") + copy.name + tr("」（") + copy.markers.length + tr(" 个点）");
        log(this.statusNote);
        break;
    case "default.toggle":
        if (this.script.defaultAction !== "points") {
            this.script.defaultAction = "points";
            this.script.defaultPoints = [];
        }
        var list = this.script.defaultPoints.slice();
        var at = list.indexOf(a);
        if (at >= 0) list.splice(at, 1); else list.push(a);
        // 全部勾上等于"全部点位"
        this.script.defaultPoints = list.length >= this.scriptPoints.length ? [] : list;
        break;
    case "layout.save": this.showSaveScriptLayoutDialog(); return;
    case "layout.load": this.loadScriptLayout(a); return;
    case "layout.delete": this.showDeleteScriptLayoutDialog(a); return;
    default:
        if (!this.handleRuleCommand(name, a, b, sender)) {
            log("未知的脚本命令：" + command);
            return;
        }
    }
    this.saveScript();
    this.rebuildDefaultPointsMenu();
    this.updateUI();
};

AutoClicker.prototype.handleRuleCommand = function (name, r, c, sender) {
    var rules = this.script.rules;
    var rule = rules[r];
    if (!rule) return false;
    var index = popupIndex(sender);
    switch (name) {
    case "rule.addCond":
        if (rule.conds.length < MAX_CONDITIONS) rule.conds.push({ join: "and", neg: false, image: null });
        break;
    case "rule.up":
        this.moveRule(r, r - 1);
        return true;
    case "rule.down":
        this.moveRule(r, r + 1);
        return true;
    case "rule.rename":
        this.showRuleRenameDialog(r);
        return true;
    case "rule.delete":
        rules.splice(r, 1);
        this.statusNote = tr("已删除") + ruleTitle(rule, r);
        break;
    case "rule.cooldown":
        rule.cooldown = COOLDOWN_CHOICES[index] || DEFAULT_COOLDOWN;
        this.saveScript();
        return true;
    case "cond.join":
        if (rule.conds[c]) rule.conds[c].join = index === 1 ? "or" : "and";
        this.saveScript();
        return true;
    case "cond.neg":
        if (rule.conds[c]) rule.conds[c].neg = index === 1;
        this.saveScript();
        return true;
    case "cond.image":
        if (rule.conds[c] && index >= 1) rule.conds[c].image = this.imageFromPopupIndex(sender, index);
        this.saveScript();
        return true;
    case "cond.delete":
        if (rule.conds.length > 1) {
            rule.conds.splice(c, 1);
            rule.conds[0].join = "and";
        }
        break;
    case "action.type":
        rule.action.type = ACTION_TYPES[index] ? ACTION_TYPES[index].type : "clickPoint";
        break;
    case "action.point":
        var point = this.scriptPoints[index - 1];
        if (point) rule.action.point = point.id;
        this.saveScript();
        return true;
    case "action.layout":
        var layoutCopy = this.copyClickLayout(index - 1);
        if (layoutCopy) {
            rule.action.layout = layoutCopy;
            this.statusNote = ruleTitle(rule, r) + tr("：运行点击方案「") + layoutCopy.name + tr("」（") + layoutCopy.markers.length + tr(" 个点）");
            log(this.statusNote);
        }
        this.saveScript();
        this.rebuildRuleList();
        return true;
    case "action.timesDialog":
        this.showTimesDialog(r);
        return true;
    case "action.untilNeg":
        rule.action.untilNeg = index === 1;
        this.saveScript();
        return true;
    case "action.untilImage":
        if (index >= 1) rule.action.untilImage = this.imageFromPopupIndex(sender, index);
        this.saveScript();
        return true;
    case "action.seconds":
        rule.action.seconds = WAIT_CHOICES[index] || 1;
        this.saveScript();
        return true;
    default:
        return false;
    }
    this.saveScript();
    this.rebuildRuleList();
    return true;
};

// 图片下拉菜单第 0 项是提示（或"已删除"），第 1 项起依次是图片
AutoClicker.prototype.imageFromPopupIndex = function (sender, index) {
    var image = this.script.images[index - 1];
    return image ? image.id : null;
};

// 把第 from 条规则移到第 to 位，并让它的边框闪一下绿色，看得出移到了哪里
AutoClicker.prototype.moveRule = function (from, to) {
    var rules = this.script.rules;
    to = clamp(to, 0, rules.length - 1);
    if (from === to || !rules[from]) return;
    var rule = rules.splice(from, 1)[0];
    rules.splice(to, 0, rule);
    this.saveScript();
    this.rebuildRuleList();
    this.highlightRule(to);
    var box = this.ruleBoxes[to];
    if (box) box.scrollRectToVisible(box.bounds);
    var self = this;
    scheduleOnce(1.2, function () {
        if (!self.isClicking) self.highlightRule(-1);
    });
    var title = ruleTitle(rule, to);
    this.statusNote = (rule.name ? tr("「") + rule.name + tr("」") : tr("原来的规则 ") + (from + 1)) + tr(" 已移到第 ") + (to + 1) + tr(" 位");
    log("规则移动：" + (from + 1) + " → " + (to + 1) + "（" + title + "）");
    this.updateUI();
};

// 拖动"≡"把手：拖动时在落点显示一条蓝线，松开后移动规则
AutoClicker.prototype.ruleHandleMouse = function (phase, index, event) {
    if (this.isClicking || this.countdownTimer) return;
    var doc = this.rulesScroll.documentView;
    var frames = this.ruleCardFrames || [];
    if (phase === "down") {
        this.ruleDrag = { from: index, slot: index };
        $.NSCursor.closedHandCursor.push;
        if (this.ruleBoxes[index]) {
            this.ruleBoxes[index].borderColor = $.NSColor.controlAccentColor;
            this.ruleBoxes[index].borderWidth = 2;
        }
        return;
    }
    if (!this.ruleDrag) return;
    var point = doc.convertPointFromView(event.locationInWindow, $());  // nil 必须写成 $()，写 null 会闪退
    var y = Number(point.y);
    // 落点 = 中线在鼠标上方的卡片数量（0 = 最前面，n = 最后面）
    var slot = 0;
    for (var i = 0; i < frames.length; i += 1) {
        if ((frames[i].top + frames[i].bottom) / 2 < y) slot = i + 1;
    }
    if (phase === "drag") {
        doc.autoscroll(event);
        this.ruleDrag.slot = slot;
        var lineY = slot < frames.length ? frames[slot].top - 4 : frames[frames.length - 1].bottom + 2;
        if (!this.ruleDragIndicator) {
            var line = $.NSBox.alloc.initWithFrame($.NSMakeRect(2, lineY, Number(doc.frame.size.width) - 4, 3));
            line.boxType = $.NSBoxCustom;
            line.titlePosition = $.NSNoTitle;
            line.borderWidth = 0;
            line.cornerRadius = 1.5;
            line.fillColor = $.NSColor.controlAccentColor;
            doc.addSubview(line);
            this.ruleDragIndicator = line;
        }
        this.ruleDragIndicator.setFrameOrigin($.NSMakePoint(2, lineY));
        return;
    }
    // up
    $.NSCursor.pop;
    var from = this.ruleDrag.from;
    this.ruleDrag = null;
    if (this.ruleDragIndicator) this.ruleDragIndicator.removeFromSuperview;
    this.ruleDragIndicator = null;
    var to = slot > from ? slot - 1 : slot;
    if (to === from) {
        this.highlightRule(-1);
        return;
    }
    this.moveRule(from, to);
};

AutoClicker.prototype.showRuleRenameDialog = function (r) {
    var rule = this.script.rules[r];
    if (!rule) return;
    var self = this;
    this.showDialog({
        key: "ruleRename",
        windowTitle: tr("规则改名"),
        title: tr("给规则 ") + (r + 1) + tr(" 起名字"),
        messageHeight: 40,
        allowAnyInput: true,
        message: tr("例如“开始”“结果”“关闭弹窗”。前面的序号（第几条）会一直显示，留空就是不起名字。"),
        fields: [{ key: "name", value: rule.name || "" }],
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("保存"), isDefault: true,
                handler: function (values) {
                    var name = cleanName(values.name);
                    if (name.length > MAX_NAME_LENGTH) return { error: tr("名字最多 ") + MAX_NAME_LENGTH + tr(" 个字。") };
                    rule.name = name;
                    self.saveScript();
                    self.rebuildRuleList();
                    self.statusNote = name ? tr("规则 ") + (r + 1) + tr(" 已命名为「") + name + tr("」") : tr("规则 ") + (r + 1) + tr(" 已去掉名字");
                    log(self.statusNote);
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.addRule = function () {
    if (this.script.rules.length >= MAX_RULES) {
        this.showError(tr("规则太多"), tr("最多 ") + MAX_RULES + tr(" 条规则。"));
        return;
    }
    var firstImage = this.script.images.length ? this.script.images[0].id : null;
    this.script.rules.push(normalizeRule({
        conds: [{ neg: false, image: firstImage }],
        action: { type: "clickPoint" },
        cooldown: DEFAULT_COOLDOWN
    }));
    this.saveScript();
    this.rebuildRuleList();
    var doc = this.rulesScroll.documentView;
    doc.scrollRectToVisible($.NSMakeRect(0, Number(doc.frame.size.height) - 10, 10, 10));
    this.statusNote = tr("已添加规则 ") + this.script.rules.length;
    this.updateUI();
};

// ---------------------------------------------------------------------------
// 扫描范围：选窗口 / 框选区域
// ---------------------------------------------------------------------------

AutoClicker.prototype.scopeTypeChosen = function (type, sender) {
    if (type === "screen") {
        if (this.script.scope.type === "screen") return;
        this.changeScope(function () { this.script.scope.type = "screen"; }.bind(this));
        this.statusNote = tr("扫描范围：整个屏幕");
        log("扫描范围：整个屏幕");
        this.updateUI();
        return;
    }
    // 窗口 / 区域：先让用户选，选完才真正切换；取消则保持原来的范围。
    // 等按钮的点击处理完再弹出菜单 / 遮罩，避免在按钮的事件处理过程中再开一层菜单跟踪。
    var self = this;
    scheduleOnce(0.05, function () {
        if (!self.isClicking && !self.countdownTimer) self.pickScopeTarget(sender, type);
    });
};

AutoClicker.prototype.pickScopeTarget = function (anchorView, type) {
    type = type || this.script.scope.type;
    if (type === "window") {
        this.showWindowMenu(anchorView);
    } else if (type === "region") {
        var self = this;
        this.startRegionSelection(tr("拖动框选要扫描的区域（Esc 取消）"), function (rect) {
            if (!rect) {
                self.updateUI();
                return;
            }
            self.hideScriptWindowsForCapture(false);
            self.changeScope(function () {
                self.script.scope.type = "region";
                self.script.scope.region = rect;
            });
            self.statusNote = tr("扫描范围：框选的区域 ") + Math.round(rect.w) + "×" + Math.round(rect.h);
            log("扫描范围：区域 " + JSON.stringify(rect));
            self.updateUI();
        });
    }
    this.updateUI();
};

AutoClicker.prototype.showWindowMenu = function (anchorView) {
    this.windowCandidates = this.listWindows();
    var menu = $.NSMenu.alloc.initWithTitle(tr("选择窗口"));
    menu.autoenablesItems = false;
    if (!this.windowCandidates.length) {
        var none = this.makeMenuItem(tr("没有找到可用的窗口（需要“屏幕录制”权限才能看到窗口标题）"), null, "");
        none.enabled = false;
        menu.addItem(none);
    }
    for (var i = 0; i < this.windowCandidates.length; i += 1) {
        var w = this.windowCandidates[i];
        var title = w.owner + (w.name ? " — " + w.name : "") + tr("（") + Math.round(w.bounds.w) + "×" + Math.round(w.bounds.h) + tr("）");
        var item = this.makeMenuItem(title, null, "");
        this.scriptControl(item, "scope.window:" + i, false);
        menu.addItem(item);
    }
    // 弹出菜单在这里同步等待用户选择（和下拉按钮一样的菜单跟踪，不是 runModal）
    menu.popUpMenuPositioningItemAtLocationInView($(), $.NSMakePoint(0, Number(anchorView.frame.size.height) + 4), anchorView);
    this.updateUI();
};

AutoClicker.prototype.chooseScopeWindow = function (index) {
    var w = this.windowCandidates[index];
    if (!w) return;
    var self = this;
    this.changeScope(function () {
        self.script.scope.type = "window";
        self.script.scope.window = { owner: w.owner, name: w.name, number: w.number, lastBounds: w.bounds };
    });
    this.statusNote = tr("扫描范围：窗口「") + w.owner + (w.name ? " — " + w.name : "") + tr("」");
    log("扫描范围：窗口 " + w.owner + " / " + w.name + " #" + w.number + " " + JSON.stringify(w.bounds));
    this.updateUI();
};

// 全屏半透明遮罩，拖动出一个矩形；callback(rect) 收到 CG 坐标矩形，取消时收到 null
AutoClicker.prototype.startRegionSelection = function (hint, callback) {
    if (this.overlay) this.finishRegionSelection(null);
    this.closeDialog();
    this.stopFlash();
    this.overlayCallback = callback;
    this.overlayStart = null;
    this.hideScriptWindowsForCapture(true);

    var all = allScreensCGRect();
    var frame = cgRectToAppKitFrame(all);
    var panel = $.AutoClickerOverlayPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        frame, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false
    );
    panel.opaque = false;
    panel.backgroundColor = $.NSColor.blackColor.colorWithAlphaComponent(0.18);
    panel.level = $.NSPopUpMenuWindowLevel;
    panel.releasedWhenClosed = false;
    panel.hidesOnDeactivate = false;
    panel.collectionBehavior =
        $.NSWindowCollectionBehaviorCanJoinAllSpaces |
        $.NSWindowCollectionBehaviorFullScreenAuxiliary;

    var view = $.AutoClickerOverlayView.alloc.initWithFrame($.NSMakeRect(0, 0, all.w, all.h));
    panel.contentView = view;

    var box = $.NSBox.alloc.initWithFrame($.NSMakeRect(0, 0, 0, 0));
    box.boxType = $.NSBoxCustom;
    box.titlePosition = $.NSNoTitle;
    box.borderWidth = 2;
    box.borderColor = $.NSColor.systemBlueColor;
    box.fillColor = $.NSColor.systemBlueColor.colorWithAlphaComponent(0.15);
    box.hidden = true;
    view.addSubview(box);

    // 提示文字放在鼠标所在屏幕的上方
    var mouse = $.NSEvent.mouseLocation;
    var screenFrame = visibleFrameForPoint(Number(mouse.x), Number(mouse.y));
    var hintLabel = this.makeLabel(hint,
        $.NSMakeRect(Number(screenFrame.origin.x) - Number(frame.origin.x) + Number(screenFrame.size.width) / 2 - 220,
            Number(screenFrame.origin.y) - Number(frame.origin.y) + Number(screenFrame.size.height) - 70, 440, 30),
        16, true, $.NSColor.whiteColor);
    hintLabel.alignment = $.NSTextAlignmentCenter;
    hintLabel.drawsBackground = true;
    hintLabel.backgroundColor = $.NSColor.blackColor.colorWithAlphaComponent(0.6);
    view.addSubview(hintLabel);

    this.overlay = { panel: panel, box: box, frame: frame };
    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
    panel.makeKeyAndOrderFront(null);
    $.NSCursor.crosshairCursor.push;
    log("开始框选：" + hint);
};

AutoClicker.prototype.overlayMouse = function (phase) {
    if (!this.overlay) return;
    var mouse = $.NSEvent.mouseLocation;
    var mx = Number(mouse.x), my = Number(mouse.y);
    if (phase === "down") {
        this.overlayStart = { x: mx, y: my };
        this.overlay.box.hidden = false;
    }
    if (!this.overlayStart) return;
    var x0 = Math.min(this.overlayStart.x, mx), y0 = Math.min(this.overlayStart.y, my);
    var w = Math.abs(mx - this.overlayStart.x), h = Math.abs(my - this.overlayStart.y);
    var origin = this.overlay.frame.origin;
    this.overlay.box.frame = $.NSMakeRect(x0 - Number(origin.x), y0 - Number(origin.y), w, h);
    if (phase === "up") {
        if (w < 6 || h < 6) {
            // 太小：当作误点，继续等待拖动
            this.overlay.box.hidden = true;
            this.overlayStart = null;
            return;
        }
        var topLeft = appKitPointToCG(x0, y0 + h);
        this.finishRegionSelection({ x: Math.round(topLeft.x), y: Math.round(topLeft.y), w: Math.round(w), h: Math.round(h) });
    }
};

AutoClicker.prototype.finishRegionSelection = function (rect) {
    if (!this.overlay) return;
    this.overlay.panel.orderOut(null);
    this.overlay = null;
    $.NSCursor.pop;
    var callback = this.overlayCallback;
    this.overlayCallback = null;
    log("框选结束：" + (rect ? JSON.stringify(rect) : "取消"));
    if (!rect) this.hideScriptWindowsForCapture(false);
    if (callback) callback(rect);
    if (!rect) this.statusNote = tr("已取消框选");
    this.updateUI();
};

// 取样 / 框选时把自己的窗口藏起来，免得被截进图片里
AutoClicker.prototype.hideScriptWindowsForCapture = function (hide) {
    if (hide) {
        if (this.scriptToolbar) this.scriptToolbar.orderOut(null);
        for (var i = 0; i < this.scriptPoints.length; i += 1) {
            if (this.scriptPoints[i].panel) this.scriptPoints[i].panel.orderOut(null);
        }
    } else if (this.mode === "script") {
        this.showToolbar();
    }
};

// ---------------------------------------------------------------------------
// Python 眼睛：查找 Python、取样、启动 / 停止扫描进程
// ---------------------------------------------------------------------------

AutoClicker.prototype.eyeScriptPath = function () {
    return jsString($.NSBundle.mainBundle.resourcePath) + "/eye.py";
};

// 找一个装好了 opencv / numpy / mss 的 python3。可用 defaults write com.charlie.autoclicker pythonPath 指定。
AutoClicker.prototype.ensurePython = function () {
    if (this.pythonPath) return { ok: true };
    var fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(this.eyeScriptPath())) return { ok: false, error: tr("应用里缺少 eye.py，请重新运行 build-app.sh") };

    var custom = jsString(this.defaults.stringForKey("pythonPath"));
    var candidates = [custom,
        "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3",
        "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
    var lastError = tr("没有找到 python3");
    for (var i = 0; i < candidates.length; i += 1) {
        var path = candidates[i];
        if (!path || !jsBoolean(fm.isExecutableFileAtPath(path))) continue;
        var result = runTaskSync(path, [this.eyeScriptPath(), "check"], 15);
        var info = parseLastJSONLine(result.text);
        if (info && info.ok) {
            this.pythonPath = path;
            log("使用 Python：" + path + "（" + JSON.stringify(info) + "）");
            return { ok: true };
        }
        lastError = path + tr("：") + (info ? info.error : (result.error || tr("无法运行")));
        log("Python 不可用 " + lastError);
    }
    return { ok: false, error: lastError };
};

AutoClicker.prototype.showPythonError = function (detail) {
    this.showDialog({
        key: "python",
        windowTitle: tr("需要 Python 依赖"),
        title: tr("识别进程（眼睛）无法启动"),
        messageHeight: 110,
        allowAnyInput: true,
        message: tr("需要 Python 3 并安装 opencv-python、numpy、mss。请在“终端”里运行：\n") +
            "pip3 install opencv-python numpy mss\n" +
            tr("如果装在别的 Python 里，可以指定路径：defaults write com.charlie.autoclicker pythonPath /路径/python3\n") +
            tr("详情：") + detail,
        buttons: [{ title: tr("好"), isDefault: true, cancel: true }]
    });
};

AutoClicker.prototype.startImageSample = function () {
    if (this.script.images.length >= MAX_SCRIPT_IMAGES) {
        this.showError(tr("图片太多"), tr("最多 ") + MAX_SCRIPT_IMAGES + tr(" 张图片。"));
        return;
    }
    if (!screenCaptureAllowed()) {
        this.showScreenPermissionDialog();
        return;
    }
    var python = this.ensurePython();
    if (!python.ok) {
        this.showPythonError(python.error);
        return;
    }
    var self = this;
    this.startRegionSelection(tr("拖动框住一个按钮或一段文字（Esc 取消）"), function (rect) {
        if (!rect) return;
        // 遮罩刚关，等它从屏幕上消失再截图
        scheduleOnce(0.25, function (timer) { self.captureSample(rect); });
    });
};

AutoClicker.prototype.captureSample = function (rect) {
    var id = "img" + Date.now();
    var file = id + ".png";
    var path = IMAGES_DIR + "/" + file;
    var result = runTaskSync(this.pythonPath,
        [this.eyeScriptPath(), "grab", String(rect.x), String(rect.y), String(rect.w), String(rect.h), path], 15);
    this.hideScriptWindowsForCapture(false);
    var info = parseLastJSONLine(result.text);
    if (!info || !info.ok) {
        log("取样失败：" + (info ? info.error : result.error || result.text));
        this.showError(tr("取样失败"), info ? tr(info.error) : (result.error || tr("截图进程没有返回结果")));
        return;
    }
    log("取样成功：" + file + " " + info.w + "×" + info.h + (info.flat ? "（几乎是纯色）" : ""));
    var image = { id: id, name: tr("图片 ") + (this.script.images.length + 1), file: file, threshold: DEFAULT_THRESHOLD, w: info.w, h: info.h };
    this.showNewImageDialog(image, Boolean(info.flat));
};

// 上传图片：不用 runModal（README 的坑），用非模态的打开面板。不需要屏幕录制权限。
AutoClicker.prototype.startImageUpload = function () {
    if (this.script.images.length >= MAX_SCRIPT_IMAGES) {
        this.showError(tr("图片太多"), tr("最多 ") + MAX_SCRIPT_IMAGES + tr(" 张图片。"));
        return;
    }
    var python = this.ensurePython();
    if (!python.ok) {
        this.showPythonError(python.error);
        return;
    }
    if (this.uploadPanel) {
        this.uploadPanel.makeKeyAndOrderFront($());
        return;
    }
    var self = this;
    var panel = $.NSOpenPanel.openPanel;
    panel.canChooseFiles = true;
    panel.canChooseDirectories = false;
    panel.allowsMultipleSelection = false;
    panel.allowedFileTypes = $(["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp"]);
    panel.message = tr("选一张只有按钮或文字的图片，大小不用管");
    panel.level = $.NSStatusWindowLevel;
    this.uploadPanel = panel;
    // JS 函数要留住引用，否则面板关闭前可能被回收
    this.uploadPanelHandler = function (response) {
        var path = Number(response) === 1 ? jsString(panel.URL.path) : "";
        self.uploadPanel = null;
        scheduleOnce(0.05, function (timer) {
            self.uploadPanelHandler = null;
            if (path) self.importUploadedImage(path);
        });
    };
    $.NSApp.activateIgnoringOtherApps(true);
    panel.beginWithCompletionHandler(this.uploadPanelHandler);
};

AutoClicker.prototype.importUploadedImage = function (source) {
    // 面板开着的时候可能用快捷键开始了运行：运行中不能加图片
    if (this.isClicking || this.countdownTimer) {
        this.statusNote = tr("运行中不能添加图片，请停止后再上传");
        this.updateUI();
        return;
    }
    var id = "img" + Date.now();
    var file = id + ".png";
    var result = runTaskSync(this.pythonPath, [this.eyeScriptPath(), "import", source, IMAGES_DIR + "/" + file], 15);
    var info = parseLastJSONLine(result.text);
    if (!info || !info.ok) {
        log("上传失败：" + (info ? info.error : result.error || result.text));
        this.showError(tr("上传失败"), info ? tr(info.error) : (result.error || tr("处理图片的进程没有返回结果")));
        return;
    }
    log("上传成功：" + source + " → " + file + " " + info.w + "×" + info.h);
    var stem = source.split("/").pop().replace(/\.[^.]*$/, "");
    var image = {
        id: id, name: cleanName(stem).slice(0, MAX_NAME_LENGTH) || tr("图片 ") + (this.script.images.length + 1),
        file: file, threshold: DEFAULT_THRESHOLD, w: info.w, h: info.h, uploaded: true, scale: 0
    };
    var screen = allScreensCGRect();
    this.showNewImageDialog(image, Boolean(info.flat), info.w >= screen.w * 0.8 && info.h >= screen.h * 0.8);
};

AutoClicker.prototype.showNewImageDialog = function (image, flat, looksLikeWholeScreen) {
    var self = this;
    var saved = false;
    var message = flat
        ? tr("注意：这张图几乎是一整块纯色，可能没有“屏幕录制”权限，或者框到了空白处。")
        : tr("例如“开始按钮”“完成”“返回”。名字只是给你看的，可以随时改。");
    if (image.uploaded && !flat) {
        message = looksLikeWholeScreen
            ? tr("注意：这张图很大，像是整张截图。图片要裁剪到只剩按钮或文字本身，否则认不出来。")
            : tr("大小不用管，运行时会自己匹配。图片要裁剪到只剩按钮或文字本身。");
    }
    this.showDialog({
        key: "newImage",
        windowTitle: tr("新图片"),
        title: tr("给这张图片起个名字（") + image.w + "×" + image.h + tr("）"),
        messageHeight: 40,
        allowAnyInput: true,
        message: message,
        fields: [{ key: "name", value: image.name, placeholder: tr("例如 开始按钮") }],
        onClose: function () {
            // 没保存（取消 / 被别的窗口顶掉）就删掉截下来的文件
            if (!saved) $.NSFileManager.defaultManager.removeItemAtPathError(self.imagePath(image), $());
        },
        buttons: [
            { title: tr("不要了"), cancel: true, handler: function () { log("取样已放弃"); } },
            {
                title: tr("保存"),
                isDefault: true,
                handler: function (values) {
                    var name = cleanName(values.name);
                    if (!name) return { error: tr("请输入名字。") };
                    if (name.length > MAX_NAME_LENGTH) return { error: tr("名字最多 ") + MAX_NAME_LENGTH + tr(" 个字。") };
                    image.name = name;
                    self.script.images.push(image);
                    saved = true;
                    self.saveScript();
                    self.rebuildScriptLists();
                    self.statusNote = tr("已添加图片「") + name + tr("」，相似度门槛 ") + image.threshold.toFixed(2);
                    log("添加图片「" + name + "」 " + image.file);
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.showImageRenameDialog = function (index) {
    var image = this.script.images[index];
    if (!image) return;
    var self = this;
    this.showDialog({
        key: "imageRename",
        windowTitle: tr("图片改名"),
        title: tr("给图片「") + image.name + tr("」改名"),
        messageHeight: 24,
        allowAnyInput: true,
        message: tr("规则里引用的是这张图片本身，改名不影响规则。"),
        fields: [{ key: "name", value: image.name }],
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("保存"), isDefault: true,
                handler: function (values) {
                    var name = cleanName(values.name);
                    if (!name) return { error: tr("请输入名字。") };
                    if (name.length > MAX_NAME_LENGTH) return { error: tr("名字最多 ") + MAX_NAME_LENGTH + tr(" 个字。") };
                    image.name = name;
                    self.saveScript();
                    self.rebuildScriptLists();
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

function parseThreshold(text) {
    var cleaned = String(text || "").replace(/[\s％%]/g, "");
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    var value = Number(cleaned);
    if (value > 1) value = value / 100;       // 允许写 85 表示 0.85
    if (value < 0.5 || value > 0.99) return null;
    return Math.round(value * 100) / 100;
}

AutoClicker.prototype.showThresholdDialog = function (index) {
    var image = this.script.images[index];
    if (!image) return;
    var self = this;
    this.showDialog({
        key: "threshold",
        windowTitle: tr("相似度门槛"),
        title: tr("图片「") + image.name + tr("」的相似度门槛"),
        messageHeight: 56,
        message: tr("相似度达到这个值才算“看到”，范围 0.50–0.99，默认 0.85。认错了就调高，明明在屏幕上却认不出就调低。") +
            tr("开“演练”运行时，图片列表会实时显示当前相似度，方便参考。"),
        fields: [{ key: "value", value: image.threshold.toFixed(2), placeholder: "0.85" }],
        preview: function (values) {
            var v = parseThreshold(values.value);
            return v === null ? tr("请输入 0.50–0.99（也可以写 85 表示 0.85）") : tr("将设为：") + v.toFixed(2);
        },
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("保存"), isDefault: true,
                handler: function (values) {
                    var v = parseThreshold(values.value);
                    if (v === null) return { error: tr("请输入 0.50–0.99 之间的数。") };
                    image.threshold = v;
                    self.saveScript();
                    self.rebuildScriptImageList();
                    self.statusNote = tr("「") + image.name + tr("」相似度门槛：") + v.toFixed(2);
                    log("门槛已保存：" + image.name + " = " + v);
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.showTimesDialog = function (r) {
    var rule = this.script.rules[r];
    if (!rule) return;
    var self = this;
    var a = rule.action;
    var isLayout = a.type === "runLayout";

    function parse(values) {
        var gapText = String(values.gap || "").replace(/[,，\s]|毫秒|ms/gi, "");
        if (!/^\d{1,5}$/.test(gapText)) return { error: tr("间隔请填 ") + MIN_GAP_MS + "–" + MAX_GAP_MS + tr(" 的整数毫秒"), field: "gap" };
        var gapMs = Number(gapText);
        if (gapMs < MIN_GAP_MS || gapMs > MAX_GAP_MS) return { error: tr("间隔请填 ") + MIN_GAP_MS + "–" + MAX_GAP_MS + tr(" 的整数毫秒"), field: "gap" };
        if (values.until) return { times: 0, gapMs: gapMs };
        var countText = String(values.count || "").replace(/[,，\s]|次/g, "");
        if (!/^\d{1,4}$/.test(countText) || Number(countText) < 1) return { error: tr("次数请填 1–") + MAX_TIMES + tr(" 的整数"), field: "count" };
        return { times: Number(countText), gapMs: gapMs };
    }

    this.showDialog({
        key: "ruleTimes",
        windowTitle: tr("点击次数"),
        title: ruleTitle(rule, r) + (isLayout ? tr("：运行几轮？") : tr("：点几次？")),
        messageHeight: 72,
        message: (isLayout
            ? tr("一轮 = 把方案里的点按顺序、按各自的间隔全部点一遍。填运行几轮，以及每轮之间再等多少毫秒（1000 毫秒 = 1 秒）。")
            : tr("填写点几次，以及两次点击之间隔多少毫秒（1000 毫秒 = 1 秒）。")) +
            tr("勾选“一直点”后会不停地点，直到规则卡片里“直到”那一行的条件满足（例如看到某张图片）就停；最多连续 ") +
            (MAX_UNTIL_SECONDS / 60) + tr(" 分钟，Esc 随时可停。"),
        checkboxes: [{ key: "until", label: (isLayout ? tr("一直运行") : tr("一直点")) + tr("，直到“直到”那一行的条件满足"), width: 360, checked: a.times === 0 }],
        fields: [
            { key: "count", value: String(a.times || 1), label: isLayout ? tr("轮") : tr("次"), width: 80, labelWidth: 24, placeholder: "1" },
            { key: "gap", value: String(Math.round(a.gap * 1000)), label: isLayout ? tr("毫秒/每轮") : tr("毫秒间隔"), width: 90, labelWidth: 64, placeholder: "300" }
        ],
        preview: function (values) {
            var v = parse(values);
            if (v.error) return v.error;
            if (isLayout) {
                if (v.times === 0) return tr("将会：一轮接一轮地运行，每轮之间等 ") + v.gapMs + tr(" 毫秒，直到条件满足");
                return tr("将会：运行 ") + v.times + tr(" 轮") + (v.times > 1 ? tr("，每轮之间等 ") + v.gapMs + tr(" 毫秒") : "");
            }
            if (v.times === 0) return tr("将会：一直点，每次间隔 ") + v.gapMs + tr(" 毫秒，直到条件满足（次数不用填）");
            return tr("将会：点 ") + v.times + tr(" 次") + (v.times > 1 ? tr("，每次间隔 ") + v.gapMs + tr(" 毫秒") : "");
        },
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("保存"), isDefault: true,
                handler: function (values) {
                    var v = parse(values);
                    if (v.error) return { error: v.error, field: v.field };
                    a.times = v.times;
                    a.gap = v.gapMs / 1000;
                    // 第一次改成"一直点，直到……"时，默认"直到看到"条件里没用到的第一张图片
                    // （用条件里那张会一开始就满足，马上停下）
                    if (a.times === 0 && !self.imageByID(a.untilImage)) {
                        var inConds = rule.conds.map(function (cond) { return cond.image; });
                        a.untilNeg = false;
                        a.untilImage = null;
                        for (var i = 0; i < self.script.images.length && !a.untilImage; i += 1) {
                            if (inConds.indexOf(self.script.images[i].id) < 0) a.untilImage = self.script.images[i].id;
                        }
                        if (!a.untilImage && self.script.images.length) a.untilImage = self.script.images[0].id;
                    }
                    self.saveScript();
                    self.rebuildRuleList();
                    self.statusNote = tr("规则 ") + (r + 1) + tr("：") + timesSummary(a).replace(/…$/, "");
                    log("规则 " + (r + 1) + " 次数：" + a.times + "，间隔 " + v.gapMs + " ms");
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.imageUsedInRules = function (id) {
    var used = [];
    for (var i = 0; i < this.script.rules.length; i += 1) {
        var rule = this.script.rules[i];
        var hit = false;
        for (var c = 0; c < rule.conds.length; c += 1) if (rule.conds[c].image === id) hit = true;
        if (hit) used.push(i + 1);
    }
    return used;
};

AutoClicker.prototype.showDeleteImageDialog = function (index) {
    var image = this.script.images[index];
    if (!image) return;
    var self = this;
    var used = this.imageUsedInRules(image.id);
    this.showDialog({
        key: "deleteImage",
        windowTitle: tr("删除图片"),
        title: tr("删除图片「") + image.name + tr("」？"),
        messageHeight: 40,
        message: used.length
            ? tr("规则 ") + used.join(tr("、")) + tr(" 用到了这张图片，删除后这些地方会显示“已删除”，对应条件不再成立。")
            : tr("没有规则用到这张图片。"),
        buttons: [
            {
                title: tr("删除"),
                handler: function () {
                    var at = self.script.images.indexOf(image);
                    if (at >= 0) self.script.images.splice(at, 1);
                    self.removeUnusedImageFiles();
                    self.saveScript();
                    self.rebuildScriptLists();
                    self.statusNote = tr("已删除图片「") + image.name + tr("」");
                    log("删除图片「" + image.name + "」");
                    self.updateUI();
                    return null;
                }
            },
            { title: tr("取消"), isDefault: true, cancel: true }
        ]
    });
};

// 一键清空：只清当前脚本的图片 / 点位 / 规则，已保存的脚本方案不受影响
AutoClicker.prototype.showClearDialog = function (kind) {
    var self = this;
    var names = { image: tr("图片").toLowerCase(), point: tr("点位").toLowerCase(), rule: tr("规则").toLowerCase() };
    var counts = { image: this.script.images.length, point: this.scriptPoints.length, rule: this.script.rules.length };
    var usedNote = {
        image: tr("规则里用到这些图片的条件会显示“已删除”，不再成立。"),
        point: tr("规则里用到这些点位的动作需要重新选择点位。"),
        rule: tr("图片和点位都会留着。")
    };
    if (!counts[kind]) {
        this.statusNote = tr("当前没有") + names[kind] + tr("可以清空");
        this.updateUI();
        return;
    }
    this.showDialog({
        key: "clearAll",
        windowTitle: tr("清空") + names[kind],
        title: tr("清空全部 ") + counts[kind] + tr(" 个") + names[kind] + tr("？"),
        messageHeight: 56,
        message: usedNote[kind] + tr("不能撤销；已保存的脚本方案不受影响。"),
        buttons: [
            {
                title: tr("清空"),
                handler: function () {
                    self.clearScriptItems(kind);
                    self.statusNote = tr("已清空") + names[kind];
                    log("清空" + names[kind] + "：" + counts[kind] + " 个");
                    self.updateUI();
                    return null;
                }
            },
            { title: tr("取消"), isDefault: true, cancel: true }
        ]
    });
};

AutoClicker.prototype.clearScriptItems = function (kind) {
    if (kind === "image") {
        this.script.images = [];
        this.removeUnusedImageFiles();
    } else if (kind === "rule") {
        this.script.rules = [];
    } else {
        this.stopFlash();
        this.scriptPoints.forEach(function (p) { if (p.panel) p.panel.orderOut($()); });
        this.scriptPoints = [];
        this.selectedMarkerID = null;
        this.script.defaultPoints = [];
        this.script.rules.forEach(function (rule) { rule.action.point = null; });
    }
    this.saveScript();
    this.rebuildScriptLists();
};

// 删除没有被当前脚本和任何脚本方案引用的图片文件
AutoClicker.prototype.removeUnusedImageFiles = function () {
    var used = {};
    var mark = function (images) { (images || []).forEach(function (img) { used[img.file] = true; }); };
    mark(this.script.images);
    for (var i = 0; i < this.scriptLayouts.length; i += 1) mark(this.scriptLayouts[i].data.images);
    var fm = $.NSFileManager.defaultManager;
    var files = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(IMAGES_DIR, $())) || [];
    for (var j = 0; j < files.length; j += 1) {
        if (/\.png$/.test(files[j]) && !used[files[j]]) {
            fm.removeItemAtPathError(IMAGES_DIR + "/" + files[j], $());
            log("删除未使用的图片文件 " + files[j]);
        }
    }
};

// ---------------------------------------------------------------------------
// 脚本点位
// ---------------------------------------------------------------------------

AutoClicker.prototype.renumberScriptMarkers = function () {
    for (var i = 0; i < this.scriptPoints.length; i += 1) {
        var p = this.scriptPoints[i];
        if (p.view) {
            p.view.title = String(i + 1);
            p.view.toolTip = (i + 1) + ". " + p.name + tr("（拖动调整位置）");
        }
    }
    this.updateMarkerAppearance();
};

AutoClicker.prototype.newScriptPoint = function (absX, absY, name, delayMs) {
    var origin = this.scopeOrigin();
    var p = {
        id: this.nextScriptPointID, name: name, rx: absX - origin.x, ry: absY - origin.y,
        delayMs: delayMs, x: absX, y: absY, panel: null, view: null, script: true
    };
    this.nextScriptPointID += 1;
    this.scriptPoints.push(p);
    this.createMarkerWindow(p);
    return p;
};

AutoClicker.prototype.scriptPointsChanged = function (note) {
    this.renumberScriptMarkers();
    this.saveScript();
    this.rebuildScriptPointList();
    this.rebuildRuleList();
    this.rebuildDefaultPointsMenu();
    if (note) this.statusNote = note;
    this.updateUI();
};

AutoClicker.prototype.addScriptPoint = function () {
    if (this.scriptPoints.length >= MAX_SCRIPT_POINTS) {
        this.showError(tr("点位太多"), tr("最多 ") + MAX_SCRIPT_POINTS + tr(" 个点位。"));
        return;
    }
    var frame = this.scriptToolbar.frame;
    var appX = Number(frame.origin.x) - Math.max(44, this.markerSize / 2 + 18);
    var appY = Number(frame.origin.y) + Number(frame.size.height) - 140 - (this.scriptPoints.length % 6) * 14;
    var onScreen = false;
    var screens = $.NSScreen.screens;
    for (var i = 0; i < jsNumber(screens.count); i += 1) {
        if (pointInsideRect(appX, appY, screens.objectAtIndex(i).visibleFrame)) onScreen = true;
    }
    if (!onScreen) {
        var visible = primaryScreenFrame();
        appX = Number(visible.origin.x) + Number(visible.size.width) / 2;
        appY = Number(visible.origin.y) + Number(visible.size.height) / 2;
    }
    var cg = appKitPointToCG(appX, appY);
    var p = this.newScriptPoint(cg.x, cg.y, tr("点位 ") + (this.scriptPoints.length + 1), DEFAULT_INTERVAL);
    this.selectedMarkerID = p.id;
    log("添加脚本点位 " + this.scriptPoints.length);
    this.scriptPointsChanged(tr("已添加点位 ") + this.scriptPoints.length + tr("，请拖动绿色圆点到目标位置"));
};

// "导入…"菜单：点击模式现在的点位，或点击模式里保存过的某个方案
AutoClicker.prototype.showImportMenu = function (anchorView) {
    var menu = $.NSMenu.alloc.initWithTitle(tr("导入点位"));
    menu.autoenablesItems = false;
    var current = this.makeMenuItem(tr("点击模式现在的点位（") + this.markers.length + tr(" 个）"), null, "");
    this.scriptControl(current, "point.importCurrent", false);
    current.enabled = this.markers.length > 0;
    menu.addItem(current);
    menu.addItem($.NSMenuItem.separatorItem);
    var header = this.makeMenuItem(this.layouts.length ? tr("点击模式保存的方案：") : tr("（点击模式还没有保存过方案）"), null, "");
    header.enabled = false;
    menu.addItem(header);
    for (var i = 0; i < this.layouts.length; i += 1) {
        var item = this.makeMenuItem("    " + this.layouts[i].name + tr("（") + this.layouts[i].markers.length + tr(" 个点）"), null, "");
        this.scriptControl(item, "point.importLayout:" + i, false);
        menu.addItem(item);
    }
    var self = this;
    // 等按钮的点击处理完再弹出菜单
    scheduleOnce(0.05, function () {
        menu.popUpMenuPositioningItemAtLocationInView($(), $.NSMakePoint(0, Number(anchorView.frame.size.height) + 4), anchorView);
        self.updateUI();
    });
};

// layoutIndex 为 null 时导入点击模式现在的点位，否则导入点击模式保存的第 layoutIndex 个方案
AutoClicker.prototype.importClickPoints = function (layoutIndex) {
    var layout = layoutIndex === null ? null : this.layouts[layoutIndex];
    var source = layout ? layout.markers : this.markers;
    var sourceName = layout ? tr("方案「") + layout.name + tr("」") : tr("点击模式");
    if (!source.length) {
        this.showError(tr("点击模式里没有点位"), tr("先在点击模式里放置点位，再回来导入。"));
        return;
    }
    var room = MAX_SCRIPT_POINTS - this.scriptPoints.length;
    var count = Math.min(room, source.length);
    var prefix = layout ? layout.name.slice(0, MAX_NAME_LENGTH - 3) + " " : tr("导入 ");
    for (var i = 0; i < count; i += 1) {
        var m = source[i];
        this.newScriptPoint(m.x, m.y, prefix + (i + 1), m.delayMs);
    }
    log("从" + sourceName + "导入 " + count + " 个点位");
    this.scriptPointsChanged(tr("已从") + sourceName + tr("导入 ") + count + tr(" 个点位") +
        (count < source.length ? tr("（已达上限 ") + MAX_SCRIPT_POINTS + tr(" 个）") : "") +
        (this.script.scope.type === "window" ? tr("，已换算成相对窗口的位置") : ""));
};

// 圆点拖动结束（由 markerMouseUp 调用）：把新位置换算成相对坐标
AutoClicker.prototype.scriptPointMoved = function (p) {
    var origin = this.scopeOrigin();
    p.rx = p.x - origin.x;
    p.ry = p.y - origin.y;
    var index = this.scriptPoints.indexOf(p) + 1;
    log("脚本点 " + index + " 移动到 (" + Math.round(p.x) + ", " + Math.round(p.y) + ")");
    this.saveScript();
    this.rebuildScriptPointList();
    this.statusNote = tr("点位 ") + index + tr("「") + p.name + tr("」位置已保存");
    this.updateUI();
};

AutoClicker.prototype.deleteScriptPoint = function (index) {
    var p = this.scriptPoints[index];
    if (!p) return;
    if (this.flashMarkerID === p.id) this.stopFlash();
    if (p.panel) p.panel.orderOut(null);
    this.scriptPoints.splice(index, 1);
    if (this.selectedMarkerID === p.id) this.selectedMarkerID = null;
    var at = this.script.defaultPoints.indexOf(p.id);
    if (at >= 0) this.script.defaultPoints.splice(at, 1);
    log("删除脚本点「" + p.name + "」");
    this.scriptPointsChanged(tr("已删除点位「") + p.name + tr("」"));
};

AutoClicker.prototype.showPointRenameDialog = function (index) {
    var p = this.scriptPoints[index];
    if (!p) return;
    var self = this;
    this.showDialog({
        key: "pointRename",
        windowTitle: tr("点位改名"),
        title: tr("给点位 ") + (index + 1) + tr(" 起名字"),
        messageHeight: 24,
        allowAnyInput: true,
        message: tr("例如“开始”“确认”“关闭弹窗”，规则里会显示这个名字。"),
        fields: [{ key: "name", value: p.name }],
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("保存"), isDefault: true,
                handler: function (values) {
                    var name = cleanName(values.name);
                    if (!name) return { error: tr("请输入名字。") };
                    if (name.length > MAX_NAME_LENGTH) return { error: tr("名字最多 ") + MAX_NAME_LENGTH + tr(" 个字。") };
                    p.name = name;
                    self.scriptPointsChanged(tr("点位 ") + (index + 1) + tr(" 已改名为「") + name + tr("」"));
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.showScriptIntervalDialog = function (index) {
    var p = this.scriptPoints[index];
    if (!p) return;
    var self = this;
    this.showDialog({
        key: "scriptInterval",
        windowTitle: tr("点击间隔"),
        title: tr("点位 ") + (index + 1) + tr("「") + p.name + tr("」的点击间隔"),
        message: tr("默认连点时，点完这个点后等待多久再点下一个（1–60,000 毫秒）。规则动作点这个点时不使用这个间隔。"),
        fields: [{ key: "value", value: String(p.delayMs), placeholder: tr("例如 500") }],
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("保存"), isDefault: true,
                handler: function (values) {
                    var text = String(values.value || "").replace(/[,，\s]/g, "");
                    if (!/^\d{1,6}$/.test(text) || Number(text) < MIN_INTERVAL || Number(text) > MAX_INTERVAL) {
                        return { error: tr("请输入 1–60,000 之间的整数毫秒数。") };
                    }
                    p.delayMs = Number(text);
                    self.saveScript();
                    self.rebuildScriptPointList();
                    self.statusNote = tr("点位「") + p.name + tr("」间隔 ") + p.delayMs + " ms";
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.showScanRateDialog = function () {
    var self = this;
    this.showDialog({
        key: "scanRate",
        windowTitle: tr("扫描频率"),
        title: tr("每秒扫描屏幕多少次"),
        messageHeight: 72,
        message: "1–" + MAX_SCAN_RATE + tr(" 次，默认 ") + DEFAULT_SCAN_RATE + tr(" 次。越高反应越快，也越占 CPU；画面变化慢就可以调低。") +
            tr("运行时下方状态会显示“每帧 N ms”：如果 N 比每次扫描的间隔（1000 ÷ 次数）还大，实际就达不到这么快。"),
        fields: [{ key: "value", value: String(this.script.scanRate), label: tr("次/秒"), width: 80, labelWidth: 50 }],
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("保存"), isDefault: true,
                handler: function (values) {
                    var n = parseNonNegativeInteger(values.value, MAX_SCAN_RATE);
                    if (!n) return { error: tr("请输入 1–") + MAX_SCAN_RATE + tr(" 的整数。") };
                    self.script.scanRate = n;
                    self.saveScript();
                    self.statusNote = tr("每秒扫描 ") + n + tr(" 次");
                    log("扫描频率：每秒 " + n + " 次");
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.showIdleStopDialog = function () {
    var self = this;
    this.showDialog({
        key: "idleStop",
        windowTitle: tr("自动停止"),
        title: tr("多久没识别到任何页面就停止"),
        messageHeight: 56,
        message: tr("从上一次有任何一条规则对上开始计时，超过这么多分钟就停止脚本（1–") + MAX_IDLE_STOP_MINUTES + tr("）。") +
            tr("这个时间要比一轮完整流程的时长更长，否则可能中途被停掉。"),
        fields: [{ key: "value", value: String(this.script.idleStopMinutes), label: tr("分钟"), width: 80, labelWidth: 40 }],
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("保存"), isDefault: true,
                handler: function (values) {
                    var n = parseNonNegativeInteger(values.value, MAX_IDLE_STOP_MINUTES);
                    if (!n) return { error: tr("请输入 1–") + MAX_IDLE_STOP_MINUTES + tr(" 的整数分钟。") };
                    self.script.idleStopMinutes = n;
                    self.saveScript();
                    self.statusNote = tr("连续 ") + n + tr(" 分钟没识别到任何页面就停止");
                    log("空闲停止时间：" + n + " 分钟");
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

// ---------------------------------------------------------------------------
// 脚本方案
// ---------------------------------------------------------------------------

AutoClicker.prototype.loadScriptLayouts = function () {
    var raw = jsString(this.defaults.stringForKey("scriptLayoutsJSON"));
    if (!raw) return;
    try {
        var saved = JSON.parse(raw);
        if (!Array.isArray(saved)) return;
        for (var i = 0; i < saved.length && this.scriptLayouts.length < MAX_LAYOUTS; i += 1) {
            var name = cleanName(saved[i] && saved[i].name).slice(0, MAX_LAYOUT_NAME);
            if (name && saved[i].data) this.scriptLayouts.push({ name: name, data: saved[i].data });
        }
    } catch (error) {
        this.scriptLayouts = [];
    }
};

AutoClicker.prototype.saveScriptLayouts = function () {
    this.defaults.setObjectForKey(JSON.stringify(this.scriptLayouts), "scriptLayoutsJSON");
    this.defaults.synchronize;
};

AutoClicker.prototype.rebuildScriptLayoutMenu = function () {
    if (!this.scriptLayoutPopup) return;
    var menu = $.NSMenu.alloc.initWithTitle(tr("脚本方案"));
    menu.autoenablesItems = false;
    menu.addItem(this.makeMenuItem(tr("脚本方案（") + this.scriptLayouts.length + tr("）"), null, ""));
    if (!this.scriptLayouts.length) {
        var empty = this.makeMenuItem(tr("还没有保存的脚本方案"), null, "");
        empty.enabled = false;
        menu.addItem(empty);
    }
    for (var i = 0; i < this.scriptLayouts.length; i += 1) {
        var d = this.scriptLayouts[i].data;
        var item = this.makeMenuItem(tr("载入：") + this.scriptLayouts[i].name + tr("（") + (d.images || []).length + tr(" 图 / ") +
            (d.rules || []).length + tr(" 规则）"), null, "");
        this.scriptControl(item, "layout.load:" + i, false);
        menu.addItem(item);
    }
    menu.addItem($.NSMenuItem.separatorItem);
    var save = this.makeMenuItem(tr("把当前脚本保存为方案…"), null, "");
    this.scriptControl(save, "layout.save", false);
    menu.addItem(save);
    if (this.scriptLayouts.length) {
        var holder = this.makeMenuItem(tr("删除脚本方案"), null, "");
        var sub = $.NSMenu.alloc.initWithTitle(tr("删除脚本方案"));
        sub.autoenablesItems = false;
        for (var j = 0; j < this.scriptLayouts.length; j += 1) {
            var del = this.makeMenuItem(this.scriptLayouts[j].name + "…", null, "");
            this.scriptControl(del, "layout.delete:" + j, false);
            sub.addItem(del);
        }
        holder.submenu = sub;
        menu.addItem(holder);
    }
    this.scriptLayoutPopup.menu = menu;
};

AutoClicker.prototype.scriptLayoutIndexByName = function (name) {
    for (var i = 0; i < this.scriptLayouts.length; i += 1) if (this.scriptLayouts[i].name === name) return i;
    return -1;
};

AutoClicker.prototype.showSaveScriptLayoutDialog = function () {
    var self = this;
    var defaultName = tr("脚本 ") + (this.scriptLayouts.length + 1);
    while (this.scriptLayoutIndexByName(defaultName) >= 0) defaultName += "'";
    this.showDialog({
        key: "saveScriptLayout",
        windowTitle: tr("保存脚本方案"),
        title: tr("把当前脚本保存为方案"),
        messageHeight: 40,
        allowAnyInput: true,
        message: tr("一起保存：扫描范围、图片、点位、规则、默认连点和自动停止设置。和点击模式的方案分开存放。同名会覆盖。"),
        fields: [{ key: "name", value: defaultName, placeholder: tr("例如 每日任务") }],
        preview: function (values) {
            var name = cleanName(values.name);
            if (!name) return tr("请输入方案名称");
            if (name.length > MAX_LAYOUT_NAME) return tr("名称最多 ") + MAX_LAYOUT_NAME + tr(" 个字");
            return self.scriptLayoutIndexByName(name) >= 0 ? tr("将覆盖已有方案「") + name + tr("」") : tr("将保存为「") + name + tr("」");
        },
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("保存"), isDefault: true,
                handler: function (values) {
                    var name = cleanName(values.name);
                    if (!name) return { error: tr("请输入方案名称。") };
                    if (name.length > MAX_LAYOUT_NAME) return { error: tr("名称最多 ") + MAX_LAYOUT_NAME + tr(" 个字。") };
                    var existing = self.scriptLayoutIndexByName(name);
                    if (existing < 0 && self.scriptLayouts.length >= MAX_LAYOUTS) {
                        return { error: tr("最多保存 ") + MAX_LAYOUTS + tr(" 个脚本方案。") };
                    }
                    var layout = { name: name, data: self.serializeScript() };
                    if (existing >= 0) self.scriptLayouts[existing] = layout; else self.scriptLayouts.push(layout);
                    self.saveScriptLayouts();
                    self.removeUnusedImageFiles();
                    self.rebuildScriptLayoutMenu();
                    self.statusNote = tr("已保存脚本方案「") + name + tr("」");
                    log("保存脚本方案「" + name + "」");
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.loadScriptLayout = function (index) {
    var layout = this.scriptLayouts[index];
    if (!layout) return;
    this.closeDialog();
    this.stopFlash();
    this.selectedMarkerID = null;
    this.applyScriptData(normalizeScript(deepCopy(layout.data)), true);
    this.saveScript();
    this.removeUnusedImageFiles();
    this.rebuildScriptLists();
    this.statusNote = tr("已载入脚本方案「") + layout.name + tr("」");
    log("载入脚本方案「" + layout.name + "」");
    this.updateUI();
};

AutoClicker.prototype.showDeleteScriptLayoutDialog = function (index) {
    var layout = this.scriptLayouts[index];
    if (!layout) return;
    var self = this;
    this.showDialog({
        key: "deleteScriptLayout",
        windowTitle: tr("删除脚本方案"),
        title: tr("删除脚本方案「") + layout.name + tr("」？"),
        messageHeight: 24,
        message: tr("只删除保存的方案，不影响当前正在编辑的脚本。"),
        buttons: [
            {
                title: tr("删除"),
                handler: function () {
                    var at = self.scriptLayouts.indexOf(layout);
                    if (at >= 0) self.scriptLayouts.splice(at, 1);
                    self.saveScriptLayouts();
                    self.removeUnusedImageFiles();
                    self.rebuildScriptLayoutMenu();
                    self.statusNote = tr("已删除脚本方案「") + layout.name + tr("」");
                    self.updateUI();
                    return null;
                }
            },
            { title: tr("取消"), isDefault: true, cancel: true }
        ]
    });
};

// ---------------------------------------------------------------------------
// 屏幕录制权限
// ---------------------------------------------------------------------------

AutoClicker.prototype.showScreenPermissionDialog = function () {
    var allowed = screenCaptureAllowed();
    var self = this;
    log("打开屏幕录制权限窗口，allowed=" + allowed);
    if (allowed) {
        this.showDialog({
            key: "screenPermission",
            windowTitle: tr("屏幕录制"),
            title: tr("屏幕录制权限正常"),
            message: tr("识别进程（眼睛）可以截取屏幕内容。"),
            buttons: [{ title: tr("好"), isDefault: true, cancel: true }]
        });
        return;
    }
    // 让系统把本应用加进"屏幕录制"列表（第一次会弹出系统提示）
    try { $.CGRequestScreenCaptureAccess(); } catch (error) { log("CGRequestScreenCaptureAccess 失败：" + error); }
    this.showDialog({
        key: "screenPermission",
        windowTitle: tr("屏幕录制"),
        title: tr("需要“屏幕录制”权限"),
        messageHeight: 72,
        message: tr("脚本模式要截屏识别图片。请到 系统设置 → 隐私与安全性 → 屏幕与系统录音（屏幕录制），打开“AutoClicker”。\n") +
            tr("macOS 要求授权后退出并重新打开 AutoClicker 才生效。"),
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("退出 AutoClicker"),
                handler: function () {
                    self.cleanup();
                    $.NSApplication.sharedApplication.terminate(null);
                    return null;
                }
            },
            {
                title: tr("打开系统设置"),
                isDefault: true,
                handler: function () {
                    var url = $.NSURL.URLWithString("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture");
                    if (!jsBoolean($.NSWorkspace.sharedWorkspace.openURL(url))) {
                        $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(
                            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"));
                    }
                    return { keepOpen: true, note: tr("授权后点“退出 AutoClicker”，再重新打开。") };
                }
            }
        ]
    });
};

// ---------------------------------------------------------------------------
// 运行：开始前检查
// ---------------------------------------------------------------------------

AutoClicker.prototype.ruleProblem = function (rule) {
    for (var c = 0; c < rule.conds.length; c += 1) {
        if (!rule.conds[c].image) return tr("有条件还没选图片");
        if (!this.imageByID(rule.conds[c].image)) return tr("条件里的图片已被删除");
    }
    var a = rule.action;
    if (a.type === "clickPoint" && !this.scriptPointByID(a.point)) return a.point === null ? tr("还没选要点击的点位") : tr("要点击的点位已被删除");
    if (a.type === "runLayout" && !a.layout) return tr("还没选要运行的点击方案");
    if (isClickAction(a) && a.times === 0 && !this.imageByID(a.untilImage)) return a.untilImage ? tr("“直到”里的图片已被删除") : tr("“一直点，直到…”还没选图片");
    return null;
};

AutoClicker.prototype.validateScriptBeforeStart = function () {
    this.refreshLayoutCopies();
    if (!this.script.rules.length) {
        this.showError(tr("脚本是空的"), tr("请先添加至少一条规则。"));
        return false;
    }
    for (var i = 0; i < this.script.rules.length; i += 1) {
        var problem = this.ruleProblem(this.script.rules[i]);
        if (problem) {
            this.showError(ruleTitle(this.script.rules[i], i) + tr(" 还没写完"), problem + tr("。请修改或删除这条规则。"));
            return false;
        }
    }

    var scope = this.script.scope;
    this.refreshScopeOrigin(true);
    if (scope.type === "window" && !this.scopeWindowBounds) {
        this.showError(tr("找不到要扫描的窗口"), (scope.window ? tr("「") + scope.window.owner + tr("」") : "") +
            tr("当前不在屏幕上（可能被最小化、关闭或在别的桌面）。请打开它，或在“扫描范围”里重新选择。"));
        return false;
    }
    if (scope.type === "region" && !scope.region) {
        this.showError(tr("还没有框选区域"), tr("请在“扫描范围”里点“框选区域…”。"));
        return false;
    }

    var region = this.scanRegion();
    // 运行时一直在屏幕上的窗口：会自动最小化就是小条，否则是工具栏
    var covering = this.autoMinimize || this.minimized ? tr("最小化小条") : tr("工具栏");
    var toolbarRect = this.runCoverFrame(this.scriptToolbar) || $.NSMakeRect(-100000, -100000, 0, 0);
    var tb = appKitPointToCG(Number(toolbarRect.origin.x), Number(toolbarRect.origin.y) + Number(toolbarRect.size.height));
    var toolbarCG = { x: tb.x, y: tb.y, w: Number(toolbarRect.size.width), h: Number(toolbarRect.size.height) };
    if (scope.type !== "screen" && rectsIntersect(region, toolbarCG)) {
        this.showError(covering + tr("挡住了扫描范围"), tr("请把") + covering + tr("拖到扫描范围外面，否则会挡住要识别的画面。") +
            (covering === tr("工具栏") ? "" : tr("（先点“— 最小化”，再拖动小条）")));
        return false;
    }
    var points = this.scriptPoints;
    for (var j = 0; j < points.length; j += 1) {
        var appPoint = cgPointToAppKit(points[j].x, points[j].y);
        if (!this.pointIsOnScreen(points[j])) {
            this.showError(tr("点位 ") + (j + 1) + tr("「") + points[j].name + tr("」不在屏幕内"), tr("请重新拖动这个点位。"));
            return false;
        }
        if (pointInsideRect(appPoint.x, appPoint.y, toolbarRect)) {
            this.showError(tr("点位 ") + (j + 1) + tr("「") + points[j].name + tr("」被") + covering + tr("挡住了"), tr("请移动") + covering + tr("或拖动点位。"));
            return false;
        }
    }

    if (!screenCaptureAllowed()) {
        this.showScreenPermissionDialog();
        return false;
    }
    var python = this.ensurePython();
    if (!python.ok) {
        this.showPythonError(python.error);
        return false;
    }
    this.dryRun = this.scriptDryRun || jsBoolean(this.defaults.boolForKey("dryRun"));
    if (!this.dryRun && !this.ensurePermission()) return false;
    return true;
};

// ---------------------------------------------------------------------------
// 运行：眼睛进程
// ---------------------------------------------------------------------------

AutoClicker.prototype.writeEyeConfig = function () {
    var region = this.scanRegion() || (this.script.scope.window && this.script.scope.window.lastBounds) || allScreensCGRect();
    var self = this;
    var config = {
        region: { x: Math.round(region.x), y: Math.round(region.y), w: Math.round(region.w), h: Math.round(region.h) },
        rate: this.script.scanRate,
        images: this.script.images.map(function (img) {
            var entry = { id: img.id, path: self.imagePath(img) };
            if (img.uploaded) {
                entry.auto = true;
                entry.threshold = img.threshold;
                if (img.scale) entry.scale = img.scale;
            }
            return entry;
        })
    };
    var text = JSON.stringify(config);
    if (text === this.lastConfigText) return;
    this.lastConfigText = text;
    writeTextFile(EYE_CONFIG_PATH, text);
};

AutoClicker.prototype.startEye = function () {
    if (this.eyeTask && jsBoolean(this.eyeTask.running)) return;
    if (!this.pythonPath) return;
    this.lastConfigText = "";
    this.writeEyeConfig();
    $.NSFileManager.defaultManager.removeItemAtPathError(EYE_RESULT_PATH, $());
    var fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(EYE_STDERR_PATH)) fm.createFileAtPathContentsAttributes(EYE_STDERR_PATH, $(), $());
    try {
        var task = $.NSTask.alloc.init;
        task.launchPath = this.pythonPath;
        task.arguments = $([this.eyeScriptPath(), "run", EYE_CONFIG_PATH, EYE_RESULT_PATH,
            String(jsNumber($.NSProcessInfo.processInfo.processIdentifier))]);
        var errorHandle = $.NSFileHandle.fileHandleForWritingAtPath(EYE_STDERR_PATH);
        if (!isNil(errorHandle)) {
            var size = jsNumber(errorHandle.seekToEndOfFile);
            if (size > 1024 * 1024) errorHandle.truncateFileAtOffset(0);
            task.standardError = errorHandle;
            task.standardOutput = errorHandle;
        }
        task.launch;
        this.eyeTask = task;
        this.eyeLastStart = Date.now();
        this.eyeStatus = tr("启动中");
        log("眼睛进程已启动，pid " + jsNumber(task.processIdentifier));
    } catch (error) {
        this.eyeTask = null;
        this.eyeStatus = tr("启动失败");
        log("眼睛进程启动失败：" + error);
    }
};

AutoClicker.prototype.stopEye = function () {
    if (this.eyeTask && jsBoolean(this.eyeTask.running)) this.eyeTask.terminate;
    this.eyeTask = null;
    this.eyeStatus = tr("未运行");
};

// 眼睛进程退出了就自动重启（至少间隔 2 秒）；缺依赖这种致命错误直接停止
AutoClicker.prototype.pollEye = function (result) {
    if (result && result.fatal) {
        this.stopSequence(tr("识别进程出错：") + result.error);
        this.showPythonError(result.error);
        return false;
    }
    if (this.eyeTask && jsBoolean(this.eyeTask.running)) return true;
    var now = Date.now();
    if (now - this.eyeLastStart < EYE_RESTART_GAP_MS) return true;
    if (this.eyeTask) log("眼睛进程已退出（退出码 " + jsNumber(this.eyeTask.terminationStatus) + "），自动重启");
    this.eyeRestarts += 1;
    this.eyeTask = null;
    this.startEye();
    this.eyeStatus = tr("已重启 ") + this.eyeRestarts + tr(" 次");
    return true;
};

AutoClicker.prototype.readEyeResult = function () {
    var text = readTextFile(EYE_RESULT_PATH);
    if (!text) return null;
    try { return JSON.parse(text); } catch (error) { return null; }
};

// ---------------------------------------------------------------------------
// 运行：主循环
// ---------------------------------------------------------------------------

AutoClicker.prototype.startScriptEngine = function (generation) {
    this.scriptRunActive = true;
    this.scriptRunStartedAt = Date.now();
    this.lastMatchTime = Date.now();
    this.handBusyUntil = 0;
    this.ruleBurst = null;
    this.scriptClickIndex = 0;
    this.eyeReady = false;
    this.eyeRestarts = 0;
    this.eyeLastSeq = -1;
    this.currentRuleIndex = -1;
    this.lastWindowCheck = 0;
    this.stopScriptEditTimer();
    this.rebuildScriptLists();
    this.startEye();
    var self = this;
    this.scriptScanTimer = scheduleRepeating(1 / this.script.scanRate, function (timer) {
        try {
            self.scriptScanTick(generation);
        } catch (error) {
            log("脚本扫描出错：" + error);
        }
    });
    log("脚本开始：" + this.script.rules.length + " 条规则，" + this.script.images.length + " 张图片，范围 " +
        this.scopeDescription() + "，" + this.script.idleStopMinutes + " 分钟无识别停止" + (this.dryRun ? "【演练】" : ""));
};

AutoClicker.prototype.stopScriptEngine = function () {
    if (!this.scriptRunActive) return;
    this.scriptRunActive = false;
    if (this.scriptScanTimer) this.scriptScanTimer.invalidate;
    this.scriptScanTimer = null;
    this.stopScriptClicking();
    this.stopRuleBurst();
    this.stopEye();
    this.currentRuleIndex = -1;
    if (this.mode === "script") {
        this.rebuildScriptLists();
        this.startScriptEditTimer();
    }
};

AutoClicker.prototype.conditionTrue = function (cond, states) {
    var image = this.imageByID(cond.image);
    if (!image) return false;
    var state = states[image.id];
    // 上传的图片第一轮还没试完：不知道屏幕上有没有，"看到"和"没看到"都不算成立
    if (state && state.unknown) return false;
    var seen = Boolean(state && state.found);
    return cond.neg ? !seen : seen;
};

// 条件从左往右排成一行，"并且"优先于"或者"：A 并且 B 或者 C = (A 并且 B) 或者 C
AutoClicker.prototype.ruleMatches = function (rule, states) {
    if (this.ruleProblem(rule)) return false;
    var groupOK = true;
    for (var i = 0; i < rule.conds.length; i += 1) {
        var cond = rule.conds[i];
        if (i > 0 && cond.join === "or") {
            if (groupOK) return true;
            groupOK = true;
        }
        if (!this.conditionTrue(cond, states)) groupOK = false;
    }
    return groupOK;
};

AutoClicker.prototype.scriptScanTick = function (generation) {
    if (!this.isClicking || generation !== this.runGeneration || !this.scriptRunActive) return;
    var now = Date.now();

    // 窗口位置每秒查一次；变了就更新扫描区域和点位坐标
    if (this.script.scope.type === "window" && now - this.lastWindowCheck >= WINDOW_TRACK_MS) {
        this.lastWindowCheck = now;
        var wasFound = Boolean(this.scopeWindowBounds);
        if (this.refreshScopeOrigin(!wasFound)) {
            log("扫描窗口位置变化：" + JSON.stringify(this.scopeWindowBounds));
            this.writeEyeConfig();
        }
    }

    var result = this.readEyeResult();
    if (!this.pollEye(result)) return;

    // 整理识别结果：过期 / 出错 / 找不到窗口都按"什么都没看到"处理
    var states = {};
    var fresh = result && !result.error && result.seq !== this.eyeLastSeq && now - Number(result.ts) < EYE_STALE_MS;
    var windowMissing = this.script.scope.type === "window" && !this.scopeWindowBounds;
    if (result && result.seq !== undefined && now - Number(result.ts) < EYE_STALE_MS) {
        if (!this.eyeReady) log("收到第一帧识别结果（" + result.ms + " ms）");
        this.eyeReady = true;
        this.eyeLastFrameMs = result.ms;
        this.eyeStatus = result.error ? tr("出错：") + result.error : tr("运行中✓");
    } else if (this.eyeReady) {
        this.eyeStatus = tr("暂时没有结果");
    }
    if (fresh) this.eyeLastSeq = result.seq;
    if (result && !result.error && now - Number(result.ts) < EYE_STALE_MS && !windowMissing) {
        for (var i = 0; i < this.script.images.length; i += 1) {
            var image = this.script.images[i];
            var r = result.images && result.images[image.id];
            if (!r) continue;
            states[image.id] = { score: Number(r.score), x: Number(r.x), y: Number(r.y), found: Number(r.score) >= image.threshold && !r.pending, unknown: Boolean(r.unknown) };
            if (image.uploaded && r.scale && r.scale !== image.scale) {
                image.scale = Number(r.scale);
                this.saveScript();
                log("上传图片「" + image.name + "」已记住大小：" + Math.round(image.scale * 100) + "%");
            }
        }
    }

    // 刚启动时等第一帧结果，避免一开始就在错误的页面上连点
    if (!this.eyeReady && now - this.scriptRunStartedAt < EYE_STARTUP_GRACE_MS) {
        this.activityLabel.stringValue = tr("等待识别进程启动…");
        this.updateScriptUI();
        return;
    }

    var matched = -1;
    for (var k = 0; k < this.script.rules.length; k += 1) {
        if (this.ruleMatches(this.script.rules[k], states)) { matched = k; break; }
    }
    if (matched >= 0) this.lastMatchTime = now;

    var idleLimit = this.script.idleStopMinutes * 60000;
    if (now - this.lastMatchTime >= idleLimit) {
        log("连续 " + this.script.idleStopMinutes + " 分钟没有识别到任何页面，停止");
        this.stopSequence(tr("已停止：") + this.script.idleStopMinutes + tr(" 分钟没有识别到任何页面"));
        return;
    }

    this.updateLiveScores(states);

    // 规则正在连续点击：不检查别的规则，只看"直到……"有没有满足
    if (this.ruleBurst) {
        this.lastMatchTime = now;
        var burst = this.ruleBurst;
        var haveFrame = result && !result.error && now - Number(result.ts) < EYE_STALE_MS && !windowMissing;
        if (windowMissing) {
            this.finishRuleBurst(tr("找不到扫描窗口"));
        } else if (burst.until && haveFrame && this.conditionTrue({ neg: burst.rule.action.untilNeg, image: burst.rule.action.untilImage }, states)) {
            this.finishRuleBurst(tr("“直到”的条件满足了"));
        } else {
            this.updateScriptUI();
            return;
        }
    }

    if (now < this.handBusyUntil) {
        this.activityLabel.stringValue = ruleTitle(this.script.rules[this.currentRuleIndex], this.currentRuleIndex) + tr(" 冷却中（还剩 ") +
            ((this.handBusyUntil - now) / 1000).toFixed(1) + tr(" 秒）");
        this.updateScriptUI();
        return;
    }

    if (matched >= 0) {
        this.stopScriptClicking();
        var rule = this.script.rules[matched];
        this.currentRuleIndex = matched;
        this.highlightRule(matched);
        if (rule.action.type === "runLayout" || (isClickAction(rule.action) && rule.action.times !== 1)) {
            this.startRuleBurst(matched, rule, states, generation);
            this.updateScriptUI();
            return;
        }
        if (!this.executeRuleAction(matched, rule, states)) return;
        var waitMs = rule.action.type === "wait" ? rule.action.seconds * 1000 : 0;
        this.handBusyUntil = Date.now() + waitMs + rule.cooldown * 1000;
    } else if (windowMissing) {
        // 窗口不见了（最小化 / 关掉 / 换了桌面）：点位坐标已经不可靠，暂停连点，但照样计入 N 分钟停止计时
        this.stopScriptClicking();
        this.activityLabel.stringValue = tr("找不到扫描窗口，暂停连点（等待窗口回来）");
    } else {
        if (this.currentRuleIndex !== -1) {
            this.currentRuleIndex = -1;
            this.highlightRule(-1);
        }
        var defaults = this.defaultClickTargets();
        var what = this.script.defaultAction === "layout" ? tr("运行点击方案「") + this.script.defaultLayout.name + tr("」") : tr("默认连点");
        this.activityLabel.stringValue = this.script.defaultAction === "none"
            ? tr("没对上任何规则 → 什么都不做，等待中")
            : defaults.length
            ? tr("没对上任何规则 → ") + what + tr("（") + defaults.length + tr(" 个点）") + (this.dryRun ? tr("【演练】") : "")
            : tr("没对上任何规则（没有默认连点的点位）");
        this.startScriptClicking(generation);
    }
    this.updateScriptUI();
};

AutoClicker.prototype.updateLiveScores = function (states) {
    this.remoteImageStates = states;
    for (var i = 0; i < this.script.images.length; i += 1) {
        var image = this.script.images[i];
        var label = this.imageScoreLabels[image.id];
        if (!label) continue;
        var s = states[image.id];
        if (!s) {
            label.stringValue = "—";
            label.textColor = $.NSColor.secondaryLabelColor;
        } else if (s.unknown) {
            label.stringValue = tr("找大小…");
            label.textColor = $.NSColor.secondaryLabelColor;
        } else {
            label.stringValue = s.score.toFixed(2) + (s.found ? " ✓" : "");
            label.textColor = s.found ? $.NSColor.systemGreenColor : $.NSColor.secondaryLabelColor;
        }
    }
};

AutoClicker.prototype.executeRuleAction = function (index, rule, states) {
    try {
        if (this.escapeIsDown()) {
            this.stopSequence(tr("检测到 Esc 已按下，未执行动作"));
            return false;
        }
    } catch (error) {
        this.stopSequence(tr("Esc 轮询失效，已停止以策安全"));
        return false;
    }
    var a = rule.action;
    var label = ruleTitle(rule, index);
    var prefix = this.dryRun ? tr("【演练】") : "";
    if (a.type === "clickPoint") {
        var p = this.scriptPointByID(a.point);
        var origin = this.scopeOrigin();
        var x = origin.x + p.rx, y = origin.y + p.ry;
        if (this.jitterPx > 0) {
            x += Math.round((Math.random() * 2 - 1) * this.jitterPx);
            y += Math.round((Math.random() * 2 - 1) * this.jitterPx);
        }
        this.postLeftClick(x, y, label + tr("「") + p.name + tr("」"));
        this.activityLabel.stringValue = prefix + label + tr(" → 点击「") + p.name + tr("」");
    } else {
        this.activityLabel.stringValue = label + tr(" → 等待 ") + formatSeconds(a.seconds);
        log(label + "：等待 " + a.seconds + " 秒");
    }
    return true;
};

// 规则要点击的点位位置（加上随机扰动），点位被删了返回 null
AutoClicker.prototype.ruleClickTarget = function (action) {
    var p = this.scriptPointByID(action.point);
    if (!p) return null;
    var origin = this.scopeOrigin();
    var x = origin.x + p.rx, y = origin.y + p.ry;
    if (this.jitterPx > 0) {
        x += Math.round((Math.random() * 2 - 1) * this.jitterPx);
        y += Math.round((Math.random() * 2 - 1) * this.jitterPx);
    }
    return { x: x, y: y, name: p.name };
};

// 连续点击：点 N 次，或一直点直到"看到 / 没看到"某张图片。期间不检查别的规则、不默认连点。
AutoClicker.prototype.startRuleBurst = function (index, rule, states, generation) {
    var a = rule.action;
    var isLayout = a.type === "runLayout";
    var first = isLayout ? {} : this.ruleClickTarget(a);
    var label = ruleTitle(rule, index);
    if (isLayout && !this.layoutTargets(a.layout).length) first = null;
    if (!first) {
        this.activityLabel.stringValue = label + tr(" → 没有可点的位置，跳过");
        log(label + "：没有可点的位置，跳过");
        this.handBusyUntil = Date.now() + rule.cooldown * 1000;
        return;
    }
    this.ruleBurst = {
        index: index,
        rule: rule,
        until: a.times === 0,
        total: a.times || Infinity,
        done: 0,
        pointIndex: 0,
        deadline: Date.now() + MAX_UNTIL_SECONDS * 1000,
        generation: generation,
        timer: null
    };
    this.handBusyUntil = Infinity;
    var untilText = tr("直到") + (a.untilNeg ? tr("没看到") : tr("看到")) + tr("「") + (this.imageByID(a.untilImage) || { name: "?" }).name + tr("」");
    log(label + "：开始" + (isLayout ? "运行点击方案「" + a.layout.name + "」（" + a.layout.markers.length + " 个点），" : "连续点击，") +
        (a.times ? a.times + (isLayout ? " 轮" : " 次") : untilText) + "，间隔 " + a.gap + " 秒");
    this.ruleBurstStep();
};

AutoClicker.prototype.ruleBurstStep = function () {
    var burst = this.ruleBurst;
    if (!burst) return;
    burst.timer = null;
    if (!this.isClicking || burst.generation !== this.runGeneration) {
        this.stopRuleBurst();
        return;
    }
    try {
        if (this.escapeIsDown()) {
            this.stopSequence(tr("检测到 Esc 已按下，未发送点击"));
            return;
        }
    } catch (error) {
        this.stopSequence(tr("Esc 轮询失效，已停止以策安全"));
        return;
    }
    if (burst.until && Date.now() > burst.deadline) {
        this.finishRuleBurst(tr("已经连续点了 ") + (MAX_UNTIL_SECONDS / 60) + tr(" 分钟，先停下"));
        return;
    }
    var a = burst.rule.action;
    var label = ruleTitle(burst.rule, burst.index);
    if (a.type === "runLayout") {
        this.ruleLayoutStep(burst, a, label);
        return;
    }
    var target = this.ruleClickTarget(a);
    if (target) {
        burst.done += 1;
        this.postLeftClick(target.x, target.y, label + tr("「") + target.name + tr("」第 ") + burst.done + tr(" 次"));
        this.activityLabel.stringValue = (this.dryRun ? tr("【演练】") : "") + label + tr(" → 点击「") + target.name + tr("」第 ") + burst.done +
            (burst.until ? tr(" 次（直到") + (a.untilNeg ? tr("没看到") : tr("看到")) + tr("「") + (this.imageByID(a.untilImage) || { name: "?" }).name + tr("」）")
                : " / " + burst.total + tr(" 次"));
    }
    if (burst.done >= burst.total) {
        this.finishRuleBurst(tr("点完 ") + burst.total + tr(" 次"));
        return;
    }
    var self = this;
    burst.timer = scheduleOnce(a.gap, function () { self.ruleBurstStep(); });
};

// 运行点击方案：按方案顺序点下一个点，等这个点自己的间隔（加随机扰动，只加一次）；一轮点完算 1 轮
AutoClicker.prototype.ruleLayoutStep = function (burst, a, label) {
    var points = this.layoutTargets(a.layout);
    if (!points.length) {
        this.finishRuleBurst(tr("点击方案里没有点"));
        return;
    }
    var p = points[burst.pointIndex % points.length];
    var x = p.x, y = p.y;
    if (this.jitterPx > 0) {
        x += Math.round((Math.random() * 2 - 1) * this.jitterPx);
        y += Math.round((Math.random() * 2 - 1) * this.jitterPx);
    }
    this.postLeftClick(x, y, label + tr("「") + p.name + tr("」第 ") + (burst.done + 1) + tr(" 轮"));
    burst.pointIndex += 1;
    this.activityLabel.stringValue = (this.dryRun ? tr("【演练】") : "") + label + tr(" → 运行「") + a.layout.name + tr("」第 ") + (burst.done + 1) +
        (burst.until ? tr(" 轮") : " / " + burst.total + tr(" 轮")) + tr("，第 ") + burst.pointIndex + " / " + points.length + tr(" 个点");
    var delay = p.delayMs;
    if (this.jitterMs > 0) delay = clamp(Math.round(delay + (Math.random() * 2 - 1) * this.jitterMs), MIN_INTERVAL, MAX_INTERVAL);
    if (burst.pointIndex >= points.length) {
        burst.pointIndex = 0;
        burst.done += 1;
        if (burst.done >= burst.total) {
            this.finishRuleBurst(tr("运行完 ") + burst.total + tr(" 轮"));
            return;
        }
        delay += a.gap * 1000;
    }
    var self = this;
    burst.timer = scheduleOnce(delay / 1000, function () { self.ruleBurstStep(); });
};

AutoClicker.prototype.finishRuleBurst = function (reason) {
    var burst = this.ruleBurst;
    if (!burst) return;
    log(ruleTitle(burst.rule, burst.index) + "：连续点击结束（" + reason + "），共 " + burst.done + " 次");
    this.stopRuleBurst();
    this.handBusyUntil = Date.now() + burst.rule.cooldown * 1000;
};

AutoClicker.prototype.stopRuleBurst = function () {
    if (this.ruleBurst && this.ruleBurst.timer) this.ruleBurst.timer.invalidate;
    this.ruleBurst = null;
};

// 默认连点：沿用点击模式的连点方式（每个点自己的间隔 + 随机扰动），规则触发时立即停住
AutoClicker.prototype.startScriptClicking = function (generation) {
    if (this.scriptClickingActive) return;
    if (!this.defaultClickTargets().length) return;
    this.scriptClickingActive = true;
    this.scriptClickStep(generation);
};

AutoClicker.prototype.stopScriptClicking = function () {
    this.scriptClickingActive = false;
    if (this.scriptClickTimer) this.scriptClickTimer.invalidate;
    this.scriptClickTimer = null;
};

AutoClicker.prototype.scriptClickStep = function (generation) {
    this.scriptClickTimer = null;
    if (!this.scriptClickingActive || !this.isClicking || generation !== this.runGeneration) return;
    if (Date.now() < this.handBusyUntil) {
        this.scriptClickingActive = false;
        return;
    }
    var points = this.defaultClickTargets();
    if (!points.length) {
        this.scriptClickingActive = false;
        return;
    }
    try {
        if (this.escapeIsDown()) {
            this.stopSequence(tr("检测到 Esc 已按下，未发送点击"));
            return;
        }
    } catch (error) {
        this.stopSequence(tr("Esc 轮询失效，已停止以策安全"));
        return;
    }
    var p = points[this.scriptClickIndex % points.length];
    var x = p.x, y = p.y;
    if (this.jitterPx > 0) {
        x += Math.round((Math.random() * 2 - 1) * this.jitterPx);
        y += Math.round((Math.random() * 2 - 1) * this.jitterPx);
    }
    this.postLeftClick(x, y, (this.script.defaultAction === "layout" ? tr("默认方案") : tr("默认连点")) + tr("「") + p.name + tr("」"));
    this.scriptClickIndex = (this.scriptClickIndex + 1) % points.length;
    var delay = p.delayMs;
    if (this.jitterMs > 0) {
        delay = clamp(Math.round(delay + (Math.random() * 2 - 1) * this.jitterMs), MIN_INTERVAL, MAX_INTERVAL);
    }
    var self = this;
    this.scriptClickTimer = scheduleOnce(delay / 1000.0, function (timer) {
        self.scriptClickStep(generation);
    });
};
