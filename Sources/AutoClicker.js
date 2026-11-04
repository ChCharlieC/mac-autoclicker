ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("Foundation");

var MOD_COMMAND = Number($.NSEventModifierFlagCommand);
var MOD_SHIFT = Number($.NSEventModifierFlagShift);
var MOD_OPTION = Number($.NSEventModifierFlagOption);
var MOD_CONTROL = Number($.NSEventModifierFlagControl);
var MODIFIER_MASK = MOD_COMMAND | MOD_SHIFT | MOD_OPTION | MOD_CONTROL;

var TOOLBAR_WIDTH = 310;
var TOOLBAR_HEIGHT = 792;
var MARKER_SIZE = 52;          // 圆点默认大小；实际大小可在"圆点大小…"里改（this.markerSize）
var MIN_MARKER_SIZE = 20;
var MAX_MARKER_SIZE = 100;
var MIN_INTERVAL = 1;
var MAX_INTERVAL = 60000;
var DEFAULT_INTERVAL = 500;
var MAX_MARKERS = 30;
var ESCAPE_KEY_CODE = 53;
var DIALOG_WIDTH = 400;
var HEARTBEAT_SECONDS = 1.0;
var ESC_POLL_SECONDS = 0.03;
var WATCHDOG_RESTART_LIMIT = 3;
var MAX_JITTER_MS = 10000;
var MAX_JITTER_PX = 50;
var MAX_DURATION_SECONDS = 24 * 3600;
var MAX_LAYOUTS = 20;
var MAX_LAYOUT_NAME = 20;
var HALO_EXTRA = 36;           // 光环直径 = 圆点大小 + 36
var MARKER_FLASH_EXTRA = 10;   // 闪烁时圆点临时放大 10 px
var FLASH_STEP_SECONDS = 0.15;
var FLASH_STEPS = 6;
var MODE_WINDOW_WIDTH = 380;
var MODE_WINDOW_HEIGHT = 236;
var POINT_ROW_HEIGHT = 38;

var appController = null;
var logHandle = null;
var LOG_PATH = "";
var SUPPORT_DIR = "";
var STATE_PATH = "";
var WATCHDOG_LOG_PATH = "";
var WATCHDOG_STDERR_PATH = "";
var KILL_MARKER_PATH = "";

function jsString(value) {
    if (value === null || value === undefined) return "";
    try {
        // nil（例如 defaults 里还没有这个键）解包后是 undefined，返回空串而不是 "undefined"
        var unwrapped = ObjC.unwrap(value);
        return unwrapped === undefined || unwrapped === null ? "" : String(unwrapped);
    } catch (error) { return String(value); }
}

function jsNumber(value) {
    try { return Number(ObjC.unwrap(value)); } catch (error) { return Number(value); }
}

function jsBoolean(value) {
    try { return Boolean(ObjC.unwrap(value)); } catch (error) { return Boolean(value); }
}

function isNil(object) {
    if (object === null || object === undefined) return true;
    try { return Boolean(object.isNil()); } catch (error) { return false; }
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function pad(number, width) {
    var text = String(number);
    while (text.length < (width || 2)) text = "0" + text;
    return text;
}

function timestamp() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
        "." + pad(d.getMilliseconds(), 3);
}

// ---------------------------------------------------------------------------
// 文件日志与状态文件
// ---------------------------------------------------------------------------

function setupPaths() {
    var home = jsString($.NSHomeDirectory());
    LOG_PATH = home + "/Library/Logs/AutoClicker.log";
    SUPPORT_DIR = home + "/Library/Application Support/com.charlie.autoclicker";
    STATE_PATH = SUPPORT_DIR + "/state.json";
    WATCHDOG_LOG_PATH = SUPPORT_DIR + "/watchdog.log";
    WATCHDOG_STDERR_PATH = SUPPORT_DIR + "/watchdog-stderr.log";
    KILL_MARKER_PATH = SUPPORT_DIR + "/last-force-quit.json";

    var fm = $.NSFileManager.defaultManager;
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
        SUPPORT_DIR, true, $(), $()
    );
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
        home + "/Library/Logs", true, $(), $()
    );
    if (!fm.fileExistsAtPath(LOG_PATH)) {
        fm.createFileAtPathContentsAttributes(LOG_PATH, $(), $());
    }
    logHandle = $.NSFileHandle.fileHandleForWritingAtPath(LOG_PATH);
    if (!isNil(logHandle)) {
        var size = jsNumber(logHandle.seekToEndOfFile);
        if (size > 2 * 1024 * 1024) logHandle.truncateFileAtOffset(0);
    }
}

function log(message) {
    if (isNil(logHandle)) return;
    try {
        logHandle.writeData(
            $(timestamp() + " " + message + "\n").dataUsingEncoding($.NSUTF8StringEncoding)
        );
    } catch (error) {}
}

function readTextFile(path) {
    var text = $.NSString.stringWithContentsOfFileEncodingError(
        path, $.NSUTF8StringEncoding, $()
    );
    if (isNil(text)) return null;
    return jsString(text);
}

function writeTextFile(path, text) {
    return jsBoolean($(text).writeToFileAtomicallyEncodingError(
        path, true, $.NSUTF8StringEncoding, $()
    ));
}

// ---------------------------------------------------------------------------
// 几何与定时器
// ---------------------------------------------------------------------------

function primaryScreenFrame() {
    var screens = $.NSScreen.screens;
    if (jsNumber(screens.count) > 0) return screens.objectAtIndex(0).frame;
    return $.NSMakeRect(0, 0, 1920, 1080);
}

function appKitPointToCG(x, y) {
    var frame = primaryScreenFrame();
    return {
        x: Number(x),
        y: Number(frame.origin.y) + Number(frame.size.height) - Number(y)
    };
}

function cgPointToAppKit(x, y) {
    var frame = primaryScreenFrame();
    return {
        x: Number(x),
        y: Number(frame.origin.y) + Number(frame.size.height) - Number(y)
    };
}

function pointInsideRect(x, y, rect) {
    var minX = Number(rect.origin.x);
    var minY = Number(rect.origin.y);
    var maxX = minX + Number(rect.size.width);
    var maxY = minY + Number(rect.size.height);
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

// 圆点编号字号按圆点大小等比缩放（52 px 时为 18 号字）。
function markerFontForSize(size) {
    return $.NSFont.boldSystemFontOfSize(Math.max(9, Math.round(18 * size / MARKER_SIZE)));
}

function panelCenter(window) {
    var frame = window.frame;
    return {
        x: Number(frame.origin.x) + Number(frame.size.width) / 2,
        y: Number(frame.origin.y) + Number(frame.size.height) / 2
    };
}

function visibleFrameForPoint(x, y) {
    var screens = $.NSScreen.screens;
    for (var i = 0; i < jsNumber(screens.count); i += 1) {
        var screen = screens.objectAtIndex(i);
        if (pointInsideRect(x, y, screen.frame)) return screen.visibleFrame;
    }
    return $.NSScreen.mainScreen.visibleFrame;
}

function scheduleOnce(seconds, block) {
    var timer = $.NSTimer.timerWithTimeIntervalRepeatsBlock(seconds, false, block);
    $.NSRunLoop.mainRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);
    return timer;
}

function scheduleRepeating(seconds, block) {
    var timer = $.NSTimer.timerWithTimeIntervalRepeatsBlock(seconds, true, block);
    $.NSRunLoop.mainRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);
    return timer;
}

// ---------------------------------------------------------------------------
// 快捷键解析
// ---------------------------------------------------------------------------

function keyCodeMap() {
    return {
        A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7,
        C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15,
        Y: 16, T: 17, "1": 18, "2": 19, "3": 20, "4": 21,
        "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
        "8": 28, "0": 29, "]": 30, O: 31, U: 32, "[": 33,
        I: 34, P: 35, RETURN: 36, L: 37, J: 38, "'": 39,
        K: 40, ";": 41, "\\": 42, ",": 43, "/": 44, N: 45,
        M: 46, ".": 47, TAB: 48, SPACE: 49,
        BACKSPACE: 51, ESC: 53,
        F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
        F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
        LEFT: 123, RIGHT: 124, DOWN: 125, UP: 126
    };
}

// 菜单 key equivalent 用的字符（用于应用自身处于活动状态时捕获按键）
function keyEquivalentFor(key) {
    var special = {
        RETURN: "\r", TAB: "\t", SPACE: " ", BACKSPACE: "", ESC: "",
        LEFT: "", RIGHT: "", DOWN: "", UP: "",
        F1: "", F2: "", F3: "", F4: "",
        F5: "", F6: "", F7: "", F8: "",
        F9: "", F10: "", F11: "", F12: ""
    };
    if (special[key] !== undefined) return special[key];
    return key.toLowerCase();
}

function parseShortcut(input) {
    var original = String(input || "").trim();
    var upper = original.toUpperCase();
    var modifiers = 0;

    if (/⌘|COMMAND|CMD/.test(upper)) modifiers |= MOD_COMMAND;
    if (/⌥|OPTION|ALT/.test(upper)) modifiers |= MOD_OPTION;
    if (/⌃|CONTROL|CTRL/.test(upper)) modifiers |= MOD_CONTROL;
    if (/⇧|SHIFT/.test(upper)) modifiers |= MOD_SHIFT;
    if (modifiers === 0) return null;

    var key = upper
        .replace(/COMMAND|CONTROL|OPTION|SHIFT|CMD|CTRL|ALT/g, "")
        .replace(/[⌘⌥⌃⇧+\s]/g, "");

    var aliases = {
        ENTER: "RETURN", "↩": "RETURN", "回车": "RETURN",
        "空格": "SPACE", SPACEBAR: "SPACE",
        ESCAPE: "ESC", "退出": "ESC", DELETE: "BACKSPACE", DEL: "BACKSPACE",
        "←": "LEFT", "→": "RIGHT", "↓": "DOWN", "↑": "UP",
        ARROWLEFT: "LEFT", ARROWRIGHT: "RIGHT", ARROWDOWN: "DOWN", ARROWUP: "UP"
    };
    if (aliases[key]) key = aliases[key];

    var codes = keyCodeMap();
    if (codes[key] === undefined) return null;

    var labels = {
        RETURN: "Enter", SPACE: "Space", BACKSPACE: "Backspace", ESC: "Esc",
        LEFT: "Left", RIGHT: "Right", DOWN: "Down", UP: "Up"
    };
    var label = labels[key] || key;
    var parts = [];
    if (modifiers & MOD_CONTROL) parts.push("Ctrl");
    if (modifiers & MOD_OPTION) parts.push("Option");
    if (modifiers & MOD_SHIFT) parts.push("Shift");
    if (modifiers & MOD_COMMAND) parts.push("Cmd");
    parts.push(label);
    var display = parts.join("+");

    return {
        keyCode: codes[key],
        modifiers: modifiers,
        label: label,
        display: display,
        equivalent: keyEquivalentFor(key)
    };
}

// ---------------------------------------------------------------------------
// ObjC 子类
// ---------------------------------------------------------------------------

ObjC.registerSubclass({
    name: "AutoClickerActionTarget",
    superclass: "NSObject",
    methods: {
        "showToolbar:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showToolbar();
            }
        },
        "toggleClicking:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.toggleFromToolbar();
            }
        },
        "addPoint:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.addPoint();
            }
        },
        "toggleDeleteMode:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.toggleDeleteMode();
            }
        },
        "deletePoint:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.deletePointByID(jsNumber(sender.tag));
            }
        },
        "editInterval:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showIntervalDialog(jsNumber(sender.tag));
            }
        },
        "setShortcut:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showShortcutDialog();
            }
        },
        "checkAccessibility:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showPermissionDialog(false);
            }
        },
        "setDuration:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showDurationDialog();
            }
        },
        "setJitter:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showJitterDialog();
            }
        },
        "loadLayout:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.loadLayout(jsNumber(sender.tag));
            }
        },
        "saveLayout:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showSaveLayoutDialog();
            }
        },
        "deleteLayout:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showDeleteLayoutDialog(jsNumber(sender.tag));
            }
        },
        "adjustAllIntervals:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showAdjustIntervalsDialog();
            }
        },
        "setMarkerSize:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showMarkerSizeDialog();
            }
        },
        "deleteAllPoints:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.showDeleteAllDialog();
            }
        },
        "selectPoint:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.selectMarker(jsNumber(sender.tag), tr("列表"));
            }
        },
        "chooseMode:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.chooseMode(jsNumber(sender.tag) === 2 ? "script" : "click");
            }
        },
        "showModeChooser:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.returnToModeChooser();
            }
        },
        "dialogControlChanged:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.dialogValuesChanged();
            }
        },
        "dialogButton:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.dialogButtonPressed(jsNumber(sender.tag));
            }
        },
        "emergencyStopKey:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.escapeDetected(tr("菜单 key equivalent"));
            }
        },
        "hotkeyPressed:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.hotkeyDetected(tr("菜单 key equivalent"));
            }
        },
        "openLog:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(LOG_PATH));
            }
        },
        "quitApplication:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.cleanup();
                $.NSApplication.sharedApplication.terminate(null);
            }
        }
    }
});

// 对话框输入框的 delegate：内容变化时刷新实时预览
ObjC.registerSubclass({
    name: "AutoClickerDialogDelegate",
    superclass: "NSObject",
    protocols: ["NSTextFieldDelegate"],
    methods: {
        "controlTextDidChange:": {
            types: ["void", ["id"]],
            implementation: function (notification) {
                if (appController) appController.dialogValuesChanged();
            }
        }
    }
});

ObjC.registerSubclass({
    name: "AutoClickerMarkerButton",
    superclass: "NSButton",
    methods: {
        "acceptsFirstMouse:": {
            types: ["bool", ["id"]],
            implementation: function (event) {
                return true;
            }
        },
        "mouseDown:": {
            types: ["void", ["id"]],
            implementation: function (event) {
                if (appController) {
                    appController.markerMouseDown(jsNumber(this.tag), this.window, event);
                }
            }
        },
        "mouseDragged:": {
            types: ["void", ["id"]],
            implementation: function (event) {
                if (appController) {
                    appController.markerMouseDragged(jsNumber(this.tag), this.window, event);
                }
            }
        },
        "mouseUp:": {
            types: ["void", ["id"]],
            implementation: function (event) {
                if (appController) {
                    appController.markerMouseUp(jsNumber(this.tag), this.window, event);
                }
            }
        }
    }
});

// NSPanel 默认在按 Esc 时执行 cancelOperation: 并关闭面板；这里拦截：
// 工具栏面板上的 Esc 交给紧急停止，对话框面板上的 Esc 等同"取消"。
ObjC.registerSubclass({
    name: "AutoClickerPanel",
    superclass: "NSPanel",
    methods: {
        "cancelOperation:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                if (appController) appController.panelEscapePressed(this);
            }
        }
    }
});

ObjC.registerSubclass({
    name: "AutoClickerFlippedView",
    superclass: "NSView",
    methods: {
        "isFlipped": {
            types: ["bool", []],
            implementation: function () {
                return true;
            }
        }
    }
});

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

function AutoClicker() {
    this.defaults = $.NSUserDefaults.standardUserDefaults;
    this.actionTarget = $.AutoClickerActionTarget.alloc.init;
    this.dialogDelegate = $.AutoClickerDialogDelegate.alloc.init;
    this.durationSeconds = clamp(jsNumber(this.defaults.integerForKey("durationSeconds")) || 0, 0, MAX_DURATION_SECONDS);
    this.jitterMs = clamp(jsNumber(this.defaults.integerForKey("jitterMs")) || 0, 0, MAX_JITTER_MS);
    this.jitterPx = clamp(jsNumber(this.defaults.integerForKey("jitterPx")) || 0, 0, MAX_JITTER_PX);
    this.markerSize = clamp(jsNumber(this.defaults.integerForKey("markerSize")) || MARKER_SIZE, MIN_MARKER_SIZE, MAX_MARKER_SIZE);
    this.durationTimer = null;
    this.runDeadline = 0;

    var savedShortcut = jsString(this.defaults.stringForKey("shortcut"));
    this.shortcut = parseShortcut(savedShortcut) || parseShortcut("Ctrl+Option+C");

    this.markers = [];
    this.nextMarkerID = 1;
    this.loadMarkerModels();
    this.layouts = [];
    this.loadLayoutModels();

    this.isClicking = false;
    this.countdownValue = 0;
    this.sequenceTimer = null;
    this.countdownTimer = null;
    this.permissionTimer = null;
    this.emergencyKeyTimer = null;
    this.heartbeatTimer = null;
    this.globalMonitor = null;
    this.runGeneration = 0;
    this.currentIndex = 0;
    this.clickCount = 0;
    this.dryRun = false;

    // 当前模式：null = 停在模式选择页，"click" = 点击模式（原有功能），"script" = 脚本模式（第二阶段）
    this.mode = null;
    this.modeWindow = null;
    this.modeNoteLabel = null;

    // 选中反馈：金色光环窗口 + 闪烁定时器
    this.haloPanel = null;
    this.haloRing = null;
    this.flashTimer = null;
    this.flashMarkerID = null;
    this.flashStep = 0;

    this.deleteMode = false;
    this.selectedMarkerID = null;
    this.draggingMarkerID = null;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;
    this.intervalFields = [];

    this.lastHotkeyTime = 0;
    this.escapeWasDown = false;
    this.keyStateBroken = false;
    this.trusted = jsBoolean($.AXIsProcessTrusted());
    this.statusNote = "";
    this.activeDialog = null;

    this.watchdogTask = null;
    this.watchdogRestarts = 0;
    this.watchdogStatus = tr("未启动");

    this.initScriptMode();
    this.initExtras();
}

AutoClicker.prototype.loadMarkerModels = function () {
    var raw = jsString(this.defaults.stringForKey("sequenceMarkersJSON"));
    if (!raw) return;

    try {
        var saved = JSON.parse(raw);
        if (!Array.isArray(saved)) return;

        for (var i = 0; i < saved.length && i < MAX_MARKERS; i += 1) {
            var item = saved[i];
            var x = Number(item.x);
            var y = Number(item.y);
            var delay = Number(item.delayMs);
            if (!isFinite(x) || !isFinite(y) || !isFinite(delay)) continue;

            var id = Number(item.id);
            if (!isFinite(id) || id < 1) id = this.nextMarkerID;
            id = Math.round(id);

            this.markers.push({
                id: id,
                x: x,
                y: y,
                delayMs: clamp(Math.round(delay), MIN_INTERVAL, MAX_INTERVAL),
                panel: null,
                view: null
            });
            this.nextMarkerID = Math.max(this.nextMarkerID, id + 1);
        }
    } catch (error) {
        this.markers = [];
    }
};

AutoClicker.prototype.saveMarkers = function () {
    var saved = [];
    for (var i = 0; i < this.markers.length; i += 1) {
        var marker = this.markers[i];
        saved.push({
            id: marker.id,
            x: marker.x,
            y: marker.y,
            delayMs: marker.delayMs
        });
    }
    this.defaults.setObjectForKey(JSON.stringify(saved), "sequenceMarkersJSON");
    this.defaults.synchronize;
};

// 方案：一整套点位（坐标 + 间隔）的命名快照，载入时整体替换当前点位。
AutoClicker.prototype.loadLayoutModels = function () {
    var raw = jsString(this.defaults.stringForKey("layoutsJSON"));
    if (!raw) return;

    try {
        var saved = JSON.parse(raw);
        if (!Array.isArray(saved)) return;

        for (var i = 0; i < saved.length && this.layouts.length < MAX_LAYOUTS; i += 1) {
            var item = saved[i];
            var name = String((item && item.name) || "").trim().slice(0, MAX_LAYOUT_NAME);
            if (!name || !Array.isArray(item.markers)) continue;

            var points = [];
            for (var j = 0; j < item.markers.length && points.length < MAX_MARKERS; j += 1) {
                var x = Number(item.markers[j].x);
                var y = Number(item.markers[j].y);
                var delay = Number(item.markers[j].delayMs);
                if (!isFinite(x) || !isFinite(y) || !isFinite(delay)) continue;
                points.push({ x: x, y: y, delayMs: clamp(Math.round(delay), MIN_INTERVAL, MAX_INTERVAL) });
            }
            if (points.length) this.layouts.push({ name: name, markers: points });
        }
    } catch (error) {
        this.layouts = [];
    }
};

AutoClicker.prototype.saveLayouts = function () {
    this.defaults.setObjectForKey(JSON.stringify(this.layouts), "layoutsJSON");
    this.defaults.synchronize;
};

AutoClicker.prototype.layoutIndexByName = function (name) {
    for (var i = 0; i < this.layouts.length; i += 1) {
        if (this.layouts[i].name === name) return i;
    }
    return -1;
};

AutoClicker.prototype.start = function () {
    $.NSApplication.sharedApplication.setActivationPolicy(
        $.NSApplicationActivationPolicyAccessory
    );

    log("==== 启动 pid " + jsNumber($.NSProcessInfo.processInfo.processIdentifier) +
        " 版本 " + jsString($.NSBundle.mainBundle.objectForInfoDictionaryKey("CFBundleShortVersionString")) +
        " 路径 " + jsString($.NSBundle.mainBundle.bundlePath));
    log("AXIsProcessTrusted=" + this.trusted + "，点位 " + this.markers.length +
        " 个，快捷键 " + this.shortcut.display);

    this.buildStatusMenu();
    this.installKeyEquivalents();
    this.buildToolbar();

    for (var i = 0; i < this.markers.length; i += 1) {
        this.createMarkerWindow(this.markers[i]);
    }
    this.renumberMarkers();
    this.rebuildPointList();
    this.installGlobalMonitor();
    this.writeState();
    this.startHeartbeat();
    this.startWatchdog();
    this.reportLastForceQuit();
    this.showModeChooser();

    var self = this;
    this.permissionTimer = scheduleRepeating(1.5, function (timer) {
        self.pollPermission();
        self.pollWatchdog();
    });

    if (!this.trusted) {
        // 让系统把本应用加入辅助功能列表并弹出系统提示（若列表里没有条目）。
        try {
            $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
        } catch (error) {
            log("AXIsProcessTrustedWithOptions 失败：" + error);
        }
        scheduleOnce(0.6, function (timer) {
            if (!self.trusted) self.showPermissionDialog(true);
        });
    } else {
        var didShowWelcome = jsBoolean(this.defaults.boolForKey("didShowSequenceWelcome"));
        if (!didShowWelcome) {
            this.defaults.setBoolForKey(true, "didShowSequenceWelcome");
            scheduleOnce(0.5, function (timer) {
                self.showWelcome();
            });
        }
    }
    this.updateUI();
};

// ---------------------------------------------------------------------------
// 状态文件、心跳、看门狗
// ---------------------------------------------------------------------------

AutoClicker.prototype.currentStateName = function () {
    if (this.isClicking) return "running";
    if (this.countdownTimer) return "countdown";
    return "idle";
};

AutoClicker.prototype.writeState = function () {
    var state = {
        state: this.currentStateName(),
        generation: this.runGeneration,
        pid: jsNumber($.NSProcessInfo.processInfo.processIdentifier),
        ts: Date.now(),
        clicks: this.clickCount,
        dryRun: this.dryRun
    };
    if (!writeTextFile(STATE_PATH, JSON.stringify(state))) {
        log("写入状态文件失败：" + STATE_PATH);
    }
};

AutoClicker.prototype.startHeartbeat = function () {
    var self = this;
    this.heartbeatTimer = scheduleRepeating(HEARTBEAT_SECONDS, function (timer) {
        self.writeState();
        if (self.isClicking && self.runDeadline) self.updateUI();
    });
};

AutoClicker.prototype.startWatchdog = function () {
    var script = jsString($.NSBundle.mainBundle.resourcePath) + "/watchdog.js";
    var fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(script)) {
        this.watchdogStatus = tr("缺少脚本");
        log("看门狗脚本不存在：" + script);
        return;
    }
    if (!fm.fileExistsAtPath(WATCHDOG_STDERR_PATH)) {
        fm.createFileAtPathContentsAttributes(WATCHDOG_STDERR_PATH, $(), $());
    }

    try {
        var task = $.NSTask.alloc.init;
        task.launchPath = "/usr/bin/osascript";
        task.arguments = $([
            "-l", "JavaScript", script,
            String(jsNumber($.NSProcessInfo.processInfo.processIdentifier)),
            STATE_PATH, WATCHDOG_LOG_PATH, KILL_MARKER_PATH
        ]);
        var errorHandle = $.NSFileHandle.fileHandleForWritingAtPath(WATCHDOG_STDERR_PATH);
        if (!isNil(errorHandle)) {
            errorHandle.seekToEndOfFile;
            task.standardError = errorHandle;
            task.standardOutput = errorHandle;
        }
        task.launch;
        this.watchdogTask = task;
        this.watchdogStatus = tr("运行中");
        log("看门狗已启动，pid " + jsNumber(task.processIdentifier));
    } catch (error) {
        this.watchdogTask = null;
        this.watchdogStatus = tr("启动失败");
        log("看门狗启动失败：" + error);
    }
};

AutoClicker.prototype.pollWatchdog = function () {
    if (!this.watchdogTask) return;
    if (jsBoolean(this.watchdogTask.running)) return;

    log("看门狗进程已退出（退出码 " + jsNumber(this.watchdogTask.terminationStatus) + "）");
    this.watchdogTask = null;
    if (this.watchdogRestarts < WATCHDOG_RESTART_LIMIT) {
        this.watchdogRestarts += 1;
        log("重新启动看门狗（第 " + this.watchdogRestarts + " 次）");
        this.startWatchdog();
    } else {
        this.watchdogStatus = tr("已退出");
        this.statusNote = tr("看门狗进程多次退出，Esc 强制退出保障不可用");
    }
    this.updateUI();
};

AutoClicker.prototype.reportLastForceQuit = function () {
    var text = readTextFile(KILL_MARKER_PATH);
    if (!text) return;
    $.NSFileManager.defaultManager.removeItemAtPathError(KILL_MARKER_PATH, $());
    var reason = text;
    try {
        var parsed = JSON.parse(text);
        reason = parsed.reason + tr("（") + parsed.time + tr("）");
    } catch (error) {}
    log("上次运行被看门狗强制退出：" + reason);
    this.statusNote = tr("上次被看门狗强制退出：") + reason;
};

// ---------------------------------------------------------------------------
// 菜单栏、隐藏主菜单
// ---------------------------------------------------------------------------

AutoClicker.prototype.makeMenuItem = function (title, action, keyEquivalent) {
    var selector = action ? $.NSSelectorFromString(action) : null;
    var item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(
        title,
        selector,
        keyEquivalent || ""
    );
    if (action) item.target = this.actionTarget;
    return item;
};

AutoClicker.prototype.buildStatusMenu = function () {
    this.statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(
        $.NSVariableStatusItemLength
    );
    this.statusItem.button.toolTip = tr("AutoClicker");

    var menu = $.NSMenu.alloc.initWithTitle(tr("AutoClicker"));
    menu.autoenablesItems = false;

    this.statusMenuItem = this.makeMenuItem(tr("状态：已停止"), null, "");
    this.statusMenuItem.enabled = false;
    menu.addItem(this.statusMenuItem);

    this.menuToggleItem = this.makeMenuItem(tr("开始循环（3 秒后）"), "toggleClicking:", "");
    menu.addItem(this.menuToggleItem);

    this.pointCountMenuItem = this.makeMenuItem(tr("点击点：0 个"), null, "");
    this.pointCountMenuItem.enabled = false;
    menu.addItem(this.pointCountMenuItem);

    this.layoutMenuItem = this.makeMenuItem(tr("载入方案"), null, "");
    menu.addItem(this.layoutMenuItem);

    menu.addItem($.NSMenuItem.separatorItem);

    this.showToolbarMenuItem = this.makeMenuItem(tr("显示工具栏"), "showToolbar:", "");
    menu.addItem(this.showToolbarMenuItem);

    this.switchModeMenuItem = this.makeMenuItem(tr("切换模式…"), "showModeChooser:", "");
    menu.addItem(this.switchModeMenuItem);

    var minimizeItem = this.makeMenuItem(tr("最小化工具栏"), null, "");
    this.scriptControl(minimizeItem, "mini.minimize", false);
    menu.addItem(minimizeItem);

    var remoteItem = this.makeMenuItem(tr("手机遥控…"), null, "");
    this.scriptControl(remoteItem, "remote.panel", false);
    menu.addItem(remoteItem);

    var languageItem = this.makeMenuItem(this.otherLanguageName(), null, "");
    this.scriptControl(languageItem, "lang.toggle", false);
    menu.addItem(languageItem);

    this.permissionMenuItem = this.makeMenuItem(tr("辅助功能：尚未授权…"), "checkAccessibility:", "");
    menu.addItem(this.permissionMenuItem);

    menu.addItem($.NSMenuItem.separatorItem);

    var emergencyItem = this.makeMenuItem(tr("紧急停止：按 Esc"), null, "");
    emergencyItem.enabled = false;
    menu.addItem(emergencyItem);

    menu.addItem(this.makeMenuItem(tr("打开日志文件"), "openLog:", ""));

    var quitItem = this.makeMenuItem(tr("退出 AutoClicker"), "quitApplication:", "q");
    menu.addItem(quitItem);

    this.statusItem.menu = menu;
};

// 隐藏主菜单：应用自身处于活动状态时（例如正在工具栏或编辑窗口里），
// 通过菜单 key equivalent 捕获 Esc 和开始/停止快捷键。
// 不使用 NSEvent local monitor：JXA 无法正确桥接其返回值，会让所有按键在 AppKit 中抛异常丢失。
AutoClicker.prototype.installKeyEquivalents = function () {
    var app = $.NSApplication.sharedApplication;
    var main = app.mainMenu;
    if (isNil(main)) {
        main = $.NSMenu.alloc.initWithTitle("MainMenu");
        app.mainMenu = main;
        log("主菜单不存在，已创建");
    } else {
        log("主菜单已存在，包含 " + jsNumber(main.numberOfItems) + " 项");
    }

    var holder = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(tr("AutoClicker"), null, "");
    var submenu = $.NSMenu.alloc.initWithTitle(tr("AutoClicker"));
    submenu.autoenablesItems = false;

    this.escMenuItem = this.makeMenuItem(tr("紧急停止"), "emergencyStopKey:", "");
    this.escMenuItem.keyEquivalentModifierMask = 0;
    submenu.addItem(this.escMenuItem);

    this.hotkeyMenuItem = this.makeMenuItem(tr("开始/停止"), "hotkeyPressed:", "");
    submenu.addItem(this.hotkeyMenuItem);
    this.applyShortcutToMenu();

    holder.submenu = submenu;
    main.addItem(holder);

    if (isNil(main.itemWithTitle("Edit")) && isNil(main.itemWithTitle(tr("编辑")))) {
        var editHolder = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent("Edit", null, "");
        var edit = $.NSMenu.alloc.initWithTitle("Edit");
        var actions = [
            ["Undo", "undo:", "z"], ["Redo", "redo:", "Z"], ["Cut", "cut:", "x"],
            ["Copy", "copy:", "c"], ["Paste", "paste:", "v"], ["Select All", "selectAll:", "a"]
        ];
        for (var i = 0; i < actions.length; i += 1) {
            var item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(
                actions[i][0], $.NSSelectorFromString(actions[i][1]), actions[i][2]
            );
            edit.addItem(item);
        }
        editHolder.submenu = edit;
        main.addItem(editHolder);
    }
};

AutoClicker.prototype.applyShortcutToMenu = function () {
    if (!this.hotkeyMenuItem) return;
    this.hotkeyMenuItem.keyEquivalent = this.shortcut.equivalent;
    this.hotkeyMenuItem.keyEquivalentModifierMask = this.shortcut.modifiers;
    this.hotkeyMenuItem.title = tr("开始/停止（") + this.shortcut.display + tr("）");
};

// ---------------------------------------------------------------------------
// 工具栏
// ---------------------------------------------------------------------------

AutoClicker.prototype.makeLabel = function (text, frame, fontSize, bold, color) {
    var label = $.NSTextField.alloc.initWithFrame(frame);
    label.stringValue = text;
    label.editable = false;
    label.selectable = false;
    label.bezeled = false;
    label.drawsBackground = false;
    label.font = bold
        ? $.NSFont.boldSystemFontOfSize(fontSize)
        : $.NSFont.systemFontOfSize(fontSize);
    label.textColor = color || $.NSColor.labelColor;
    return label;
};

AutoClicker.prototype.makeButton = function (title, frame, action) {
    var button = $.NSButton.alloc.initWithFrame(frame);
    button.title = title;
    button.bezelStyle = $.NSBezelStyleRounded;
    button.target = this.actionTarget;
    button.action = $.NSSelectorFromString(action);
    return button;
};

AutoClicker.prototype.buildToolbar = function () {
    var visible = primaryScreenFrame();
    var x = Number(visible.origin.x) + Number(visible.size.width) - TOOLBAR_WIDTH - 24;
    var y = Number(visible.origin.y) +
        Math.max(30, (Number(visible.size.height) - TOOLBAR_HEIGHT) / 2);

    var style = $.NSWindowStyleMaskTitled |
        $.NSWindowStyleMaskClosable |
        $.NSWindowStyleMaskUtilityWindow;
    this.toolbar = $.AutoClickerPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(x, y, TOOLBAR_WIDTH, TOOLBAR_HEIGHT),
        style,
        $.NSBackingStoreBuffered,
        false
    );
    this.toolbar.title = tr("AutoClicker 工具栏");
    this.toolbar.releasedWhenClosed = false;
    this.toolbar.floatingPanel = true;
    this.toolbar.hidesOnDeactivate = false;
    this.toolbar.level = $.NSFloatingWindowLevel;
    this.toolbar.collectionBehavior =
        $.NSWindowCollectionBehaviorCanJoinAllSpaces |
        $.NSWindowCollectionBehaviorFullScreenAuxiliary;

    var content = $.NSView.alloc.initWithFrame(
        $.NSMakeRect(0, 0, TOOLBAR_WIDTH, TOOLBAR_HEIGHT)
    );
    this.toolbar.contentView = content;

    content.addSubview(this.makeLabel(
        tr("AutoClicker"),
        $.NSMakeRect(16, 753, 134, 26),
        18, true, $.NSColor.labelColor
    ));

    content.addSubview(this.extraButton("📱", $.NSMakeRect(152, 752, 34, 28), "remote.panel", tr("手机遥控：用手机看状态、开始和停止")));
    content.addSubview(this.extraButton("—", $.NSMakeRect(186, 752, 32, 28), "mini.minimize", tr("最小化：收成一条小条，不挡住屏幕")));
    this.modeButton = this.makeButton(tr("⇄ 模式"), $.NSMakeRect(220, 752, 74, 28), "showModeChooser:");
    this.modeButton.toolTip = tr("回到模式选择页");
    content.addSubview(this.modeButton);

    this.statusLabel = this.makeLabel(
        tr("● 已停止"),
        $.NSMakeRect(16, 723, 278, 23),
        13, true, $.NSColor.secondaryLabelColor
    );
    content.addSubview(this.statusLabel);

    this.addButton = this.makeButton(tr("放置"), $.NSMakeRect(16, 679, 88, 34), "addPoint:");
    content.addSubview(this.addButton);

    this.deleteModeButton = this.makeButton(
        tr("删除"), $.NSMakeRect(111, 679, 88, 34), "toggleDeleteMode:"
    );
    content.addSubview(this.deleteModeButton);

    this.deleteAllButton = this.makeButton(
        tr("全部删除"), $.NSMakeRect(206, 679, 88, 34), "deleteAllPoints:"
    );
    content.addSubview(this.deleteAllButton);

    this.hintLabel = this.makeLabel(
        tr("放置后，把屏幕上的编号圆点拖到目标位置。按创建顺序 1 → 2 → 3 循环。"),
        $.NSMakeRect(16, 638, 278, 34),
        11, false, $.NSColor.secondaryLabelColor
    );
    this.hintLabel.lineBreakMode = $.NSLineBreakByWordWrapping;
    content.addSubview(this.hintLabel);

    var coordinateHeader = this.makeLabel(
        tr("坐标"), $.NSMakeRect(50, 613, 91, 20), 11, true, $.NSColor.secondaryLabelColor
    );
    content.addSubview(coordinateHeader);

    var intervalHeader = this.makeLabel(
        tr("点击间隔"), $.NSMakeRect(142, 613, 98, 20), 11, true, $.NSColor.secondaryLabelColor
    );
    intervalHeader.alignment = $.NSTextAlignmentCenter;
    content.addSubview(intervalHeader);

    var deleteHeader = this.makeLabel(
        tr("删除"), $.NSMakeRect(245, 613, 27, 20), 11, true, $.NSColor.secondaryLabelColor
    );
    deleteHeader.alignment = $.NSTextAlignmentCenter;
    content.addSubview(deleteHeader);

    this.pointsScrollView = $.NSScrollView.alloc.initWithFrame(
        $.NSMakeRect(16, 397, 278, 212)
    );
    this.pointsScrollView.hasVerticalScroller = true;
    this.pointsScrollView.autohidesScrollers = true;
    this.pointsScrollView.borderType = $.NSBezelBorder;
    this.pointsScrollView.drawsBackground = false;
    content.addSubview(this.pointsScrollView);

    this.layoutPopup = $.NSPopUpButton.alloc.initWithFramePullsDown(
        $.NSMakeRect(16, 355, 132, 32), true
    );
    content.addSubview(this.layoutPopup);

    this.adjustIntervalsButton = this.makeButton(
        tr("全部间隔…"), $.NSMakeRect(162, 355, 132, 32), "adjustAllIntervals:"
    );
    content.addSubview(this.adjustIntervalsButton);

    this.shortcutButton = this.makeButton(
        tr("开始/停止快捷键：Ctrl+Option+C…"), $.NSMakeRect(16, 313, 278, 32), "setShortcut:"
    );
    content.addSubview(this.shortcutButton);

    this.durationButton = this.makeButton(
        tr("持续时间：不限…"), $.NSMakeRect(16, 279, 278, 32), "setDuration:"
    );
    content.addSubview(this.durationButton);

    this.jitterButton = this.makeButton(
        tr("随机扰动：关…"), $.NSMakeRect(16, 245, 278, 32), "setJitter:"
    );
    content.addSubview(this.jitterButton);

    this.markerSizeButton = this.makeButton(
        tr("圆点大小：52 px…"), $.NSMakeRect(16, 211, 278, 32), "setMarkerSize:"
    );
    content.addSubview(this.markerSizeButton);

    this.emergencyLabel = this.makeLabel(
        tr("紧急停止：按 Esc"),
        $.NSMakeRect(16, 179, 278, 24),
        12, true, $.NSColor.systemRedColor
    );
    this.emergencyLabel.alignment = $.NSTextAlignmentCenter;
    content.addSubview(this.emergencyLabel);

    this.permissionButton = this.makeButton(
        tr("辅助功能：未生效（检查 / 修复）"), $.NSMakeRect(16, 133, 278, 32), "checkAccessibility:"
    );
    content.addSubview(this.permissionButton);

    var permissionGuide = this.makeLabel(
        tr("系统设置 → 隐私与安全性 → 辅助功能 → 打开“AutoClicker”"),
        $.NSMakeRect(16, 97, 278, 30),
        10, false, $.NSColor.secondaryLabelColor
    );
    permissionGuide.alignment = $.NSTextAlignmentCenter;
    permissionGuide.lineBreakMode = $.NSLineBreakByWordWrapping;
    content.addSubview(permissionGuide);

    content.addSubview(this.makeAutoMinimizeBox($.NSMakeRect(16, 64, 278, 24)));

    this.startButton = this.makeButton(
        tr("▶ 开始循环（3 秒后）"), $.NSMakeRect(16, 18, 278, 42), "toggleClicking:"
    );
    this.startButton.font = $.NSFont.boldSystemFontOfSize(15);
    content.addSubview(this.startButton);

    this.rebuildLayoutMenus();
    this.updateUI();
};

// 工具栏的"方案"下拉按钮和菜单栏的"载入方案"子菜单共用同一份内容，各自一套 NSMenuItem。
AutoClicker.prototype.buildLayoutMenu = function (forPopup) {
    var menu = $.NSMenu.alloc.initWithTitle(tr("方案"));
    menu.autoenablesItems = false;
    // pull-down 按钮把第一项当作按钮标题，不会出现在菜单里。
    if (forPopup) menu.addItem(this.makeMenuItem(tr("方案（") + this.layouts.length + tr("）"), null, ""));

    if (this.layouts.length === 0) {
        var empty = this.makeMenuItem(tr("还没有保存的方案"), null, "");
        empty.enabled = false;
        menu.addItem(empty);
    }
    for (var i = 0; i < this.layouts.length; i += 1) {
        var layout = this.layouts[i];
        var item = this.makeMenuItem(
            tr("载入：") + layout.name + tr("（") + layout.markers.length + tr(" 点）"), "loadLayout:", ""
        );
        item.tag = i;
        menu.addItem(item);
    }

    menu.addItem($.NSMenuItem.separatorItem);
    menu.addItem(this.makeMenuItem(tr("把当前点位保存为方案…"), "saveLayout:", ""));

    if (this.layouts.length) {
        var deleteHolder = this.makeMenuItem(tr("删除方案"), null, "");
        var deleteMenu = $.NSMenu.alloc.initWithTitle(tr("删除方案"));
        deleteMenu.autoenablesItems = false;
        for (var j = 0; j < this.layouts.length; j += 1) {
            var deleteItem = this.makeMenuItem(this.layouts[j].name + "…", "deleteLayout:", "");
            deleteItem.tag = j;
            deleteMenu.addItem(deleteItem);
        }
        deleteHolder.submenu = deleteMenu;
        menu.addItem(deleteHolder);
    }
    return menu;
};

AutoClicker.prototype.rebuildLayoutMenus = function () {
    if (this.layoutPopup) this.layoutPopup.menu = this.buildLayoutMenu(true);
    if (this.layoutMenuItem) this.layoutMenuItem.submenu = this.buildLayoutMenu(false);
};

AutoClicker.prototype.showToolbar = function () {
    // 还没选模式时（或从工具栏回到了模式选择页），"显示工具栏"打开模式选择页。
    if (this.mode !== "click" && this.mode !== "script") {
        this.showModeChooser();
        return;
    }
    if (this.minimized) this.hideMiniBar();
    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
    this.currentToolbar().makeKeyAndOrderFront(null);
    if (!this.isClicking) this.showMarkerWindows();
};

// ---------------------------------------------------------------------------
// 模式选择页
// ---------------------------------------------------------------------------

AutoClicker.prototype.buildModeWindow = function () {
    var visible = primaryScreenFrame();
    var x = Number(visible.origin.x) + (Number(visible.size.width) - MODE_WINDOW_WIDTH) / 2;
    var y = Number(visible.origin.y) + (Number(visible.size.height) - MODE_WINDOW_HEIGHT) / 2;

    var panel = $.AutoClickerPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(x, y, MODE_WINDOW_WIDTH, MODE_WINDOW_HEIGHT),
        $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
        $.NSBackingStoreBuffered,
        false
    );
    panel.title = tr("AutoClicker");
    panel.releasedWhenClosed = false;
    panel.hidesOnDeactivate = false;
    panel.floatingPanel = true;
    panel.level = $.NSFloatingWindowLevel;
    panel.collectionBehavior =
        $.NSWindowCollectionBehaviorCanJoinAllSpaces |
        $.NSWindowCollectionBehaviorFullScreenAuxiliary;

    var content = $.AutoClickerFlippedView.alloc.initWithFrame(
        $.NSMakeRect(0, 0, MODE_WINDOW_WIDTH, MODE_WINDOW_HEIGHT)
    );
    panel.contentView = content;

    content.addSubview(this.makeLabel(
        tr("选择模式"), $.NSMakeRect(20, 16, MODE_WINDOW_WIDTH - 40, 28),
        20, true, $.NSColor.labelColor
    ));

    content.addSubview(this.extraButton(this.otherLanguageName(), $.NSMakeRect(MODE_WINDOW_WIDTH - 100, 18, 80, 26), "lang.toggle"));

    var buttonWidth = (MODE_WINDOW_WIDTH - 40 - 16) / 2;
    var specs = [
        { tag: 1, title: tr("点击"), detail: tr("放置编号点位，从上往下循环连点") },
        { tag: 2, title: tr("脚本"), detail: tr("识别屏幕上的图片，按规则点击；没对上就连点") }
    ];
    for (var i = 0; i < specs.length; i += 1) {
        var bx = 20 + i * (buttonWidth + 16);
        var button = this.makeButton(specs[i].title, $.NSMakeRect(bx, 56, buttonWidth, 84), "chooseMode:");
        // 圆角按钮（Rounded）高度固定，大按钮要用可变高度的方形按钮样式。
        button.bezelStyle = $.NSBezelStyleRegularSquare;
        button.font = $.NSFont.boldSystemFontOfSize(22);
        button.tag = specs[i].tag;
        content.addSubview(button);

        var detail = this.makeLabel(
            specs[i].detail, $.NSMakeRect(bx, 146, buttonWidth, 34),
            11, false, $.NSColor.secondaryLabelColor
        );
        detail.alignment = $.NSTextAlignmentCenter;
        detail.lineBreakMode = $.NSLineBreakByWordWrapping;
        content.addSubview(detail);
    }

    this.modeNoteLabel = this.makeLabel(
        "", $.NSMakeRect(20, 192, MODE_WINDOW_WIDTH - 40, 22),
        12, true, $.NSColor.systemOrangeColor
    );
    this.modeNoteLabel.alignment = $.NSTextAlignmentCenter;
    content.addSubview(this.modeNoteLabel);

    this.modeWindow = panel;
};

AutoClicker.prototype.showModeChooser = function () {
    if (this.minimized) this.hideMiniBar();
    if (!this.modeWindow) this.buildModeWindow();
    this.modeNoteLabel.stringValue = "";
    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
    this.modeWindow.makeKeyAndOrderFront(null);
    this.updateUI();
};

AutoClicker.prototype.chooseMode = function (mode) {
    if (mode === "script") {
        this.enterScriptMode();
        return;
    }
    log("模式选择：点击");
    this.mode = "click";
    if (this.modeWindow) this.modeWindow.orderOut(null);
    this.statusNote = "";
    this.showToolbar();
    this.updateUI();
};

// 从工具栏回到模式选择页：只在空闲时允许。
AutoClicker.prototype.returnToModeChooser = function () {
    if (this.isClicking || this.countdownTimer) return;
    this.closeDialog();
    this.stopFlash();
    this.deleteMode = false;
    this.draggingMarkerID = null;
    if (this.mode === "script") this.leaveScriptMode();
    this.mode = null;
    this.toolbar.orderOut(null);
    this.updateMarkerAppearance();
    log("回到模式选择页");
    this.showModeChooser();
};

// ---------------------------------------------------------------------------
// 编号圆点
// ---------------------------------------------------------------------------

AutoClicker.prototype.createMarkerWindow = function (marker) {
    var size = this.markerSize;
    var appPoint = cgPointToAppKit(marker.x, marker.y);
    var originX = appPoint.x - size / 2;
    var originY = appPoint.y - size / 2;
    var style = $.NSWindowStyleMaskBorderless |
        $.NSWindowStyleMaskNonactivatingPanel;

    var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(originX, originY, size, size),
        style,
        $.NSBackingStoreBuffered,
        false
    );
    panel.opaque = false;
    panel.backgroundColor = $.NSColor.clearColor;
    panel.hasShadow = true;
    panel.releasedWhenClosed = false;
    panel.hidesOnDeactivate = false;
    panel.level = $.NSFloatingWindowLevel;
    panel.collectionBehavior =
        $.NSWindowCollectionBehaviorCanJoinAllSpaces |
        $.NSWindowCollectionBehaviorFullScreenAuxiliary;

    var view = $.AutoClickerMarkerButton.alloc.initWithFrame(
        $.NSMakeRect(0, 0, size, size)
    );
    view.tag = marker.id;
    view.title = "1";
    view.bordered = true;
    view.bezelStyle = $.NSBezelStyleCircular;
    view.font = markerFontForSize(size);
    view.contentTintColor = $.NSColor.whiteColor;
    view.focusRingType = $.NSFocusRingTypeNone;

    panel.contentView = view;
    marker.panel = panel;
    marker.view = view;
    if (this.markerShouldShow(marker)) panel.orderFrontRegardless;
};

// 点击模式的圆点只在点击模式显示，脚本点位只在脚本模式显示；运行中都隐藏。
AutoClicker.prototype.markerShouldShow = function (marker) {
    if (this.isClicking) return false;
    return marker.script ? this.mode === "script" : this.mode === "click";
};

AutoClicker.prototype.allMarkers = function () {
    return this.markers.concat(this.scriptPoints || []);
};

AutoClicker.prototype.renumberMarkers = function () {
    for (var i = 0; i < this.markers.length; i += 1) {
        var marker = this.markers[i];
        if (marker.view) {
            marker.view.title = String(i + 1);
            marker.view.toolTip = tr("第 ") + (i + 1) + tr(" 个点击点（拖动调整位置）");
        }
    }
    this.updateMarkerAppearance();
};

AutoClicker.prototype.updateMarkerAppearance = function () {
    var editingLocked = this.isClicking || this.countdownTimer !== null;
    var all = this.allMarkers();
    for (var i = 0; i < all.length; i += 1) {
        var marker = all[i];
        if (!marker.panel || !marker.view) continue;

        // 点击模式的圆点是蓝色，脚本点位是绿色
        var color = marker.script ? $.NSColor.systemGreenColor : $.NSColor.systemBlueColor;
        if (this.deleteMode && !marker.script) color = $.NSColor.systemRedColor;
        else if (this.selectedMarkerID === marker.id) color = $.NSColor.systemOrangeColor;

        marker.view.bezelColor = color;
        marker.view.contentTintColor = $.NSColor.whiteColor;
        marker.panel.ignoresMouseEvents = editingLocked;

        if (!this.markerShouldShow(marker)) marker.panel.orderOut(null);
        else marker.panel.orderFrontRegardless;
    }
    // 圆点每次 orderFront 后，光环要重新放到最上层，否则会被圆点盖住。
    if (this.flashTimer && this.haloPanel) this.haloPanel.orderFrontRegardless;
};

AutoClicker.prototype.showMarkerWindows = function () {
    if (this.isClicking) return;
    this.updateMarkerAppearance();
};

AutoClicker.prototype.markerByID = function (id) {
    for (var i = 0; i < this.markers.length; i += 1) {
        if (this.markers[i].id === id) return this.markers[i];
    }
    return this.scriptPointByID ? this.scriptPointByID(id) : null;
};

AutoClicker.prototype.markerMouseDown = function (id, window, event) {
    if (this.isClicking || this.countdownTimer) return;

    if (this.deleteMode) {
        this.deletePointByID(id);
        return;
    }

    var marker = this.markerByID(id);
    if (!marker) return;

    this.selectMarker(id, tr("圆点"));
    this.draggingMarkerID = id;
    // 拖动偏移量相对圆点中心计算：闪烁时圆点会临时放大，用中心才不会错位。
    var mouse = $.NSEvent.mouseLocation;
    var center = panelCenter(window);
    this.dragOffsetX = Number(mouse.x) - center.x;
    this.dragOffsetY = Number(mouse.y) - center.y;
    var list = marker.script ? this.scriptPoints : this.markers;
    this.statusNote = tr("已选中第 ") + (list.indexOf(marker) + 1) + tr(" 个点（可拖动）");
    this.updateUI();
};

AutoClicker.prototype.markerMouseDragged = function (id, window, event) {
    if (this.isClicking || this.countdownTimer) return;
    if (this.draggingMarkerID !== id) return;

    var mouse = $.NSEvent.mouseLocation;
    var size = Number(window.frame.size.width);
    var centerX = Number(mouse.x) - this.dragOffsetX;
    var centerY = Number(mouse.y) - this.dragOffsetY;
    window.setFrameOrigin($.NSMakePoint(centerX - size / 2, centerY - size / 2));
    if (this.flashMarkerID === id) this.positionHalo(centerX, centerY);
};

AutoClicker.prototype.markerMouseUp = function (id, window, event) {
    if (this.isClicking || this.countdownTimer) return;
    if (this.draggingMarkerID !== id) return;

    var marker = this.markerByID(id);
    this.draggingMarkerID = null;
    if (!marker) return;

    var center = panelCenter(window);
    var cgPoint = appKitPointToCG(center.x, center.y);
    marker.x = cgPoint.x;
    marker.y = cgPoint.y;
    if (marker.script) {
        this.scriptPointMoved(marker);
        return;
    }

    this.statusNote = tr("第 ") + (this.markers.indexOf(marker) + 1) + tr(" 个点位置已保存");
    log("点 " + (this.markers.indexOf(marker) + 1) + " 移动到 (" +
        Math.round(marker.x) + ", " + Math.round(marker.y) + ")");
    this.saveMarkers();
    this.rebuildPointList();
    this.updateUI();
};

AutoClicker.prototype.addPoint = function () {
    if (this.isClicking || this.countdownTimer) return;
    if (this.markers.length >= MAX_MARKERS) {
        this.showError(tr("点击点太多"), tr("最多可以放置 ") + MAX_MARKERS + tr(" 个点击点。"));
        return;
    }

    this.deleteMode = false;
    var toolbarFrame = this.toolbar.frame;
    var appX = Number(toolbarFrame.origin.x) - Math.max(44, this.markerSize / 2 + 18);
    var appY = Number(toolbarFrame.origin.y) +
        Number(toolbarFrame.size.height) - 120 -
        (this.markers.length % 6) * 14;

    var screens = $.NSScreen.screens;
    var isVisible = false;
    for (var i = 0; i < jsNumber(screens.count); i += 1) {
        if (pointInsideRect(appX, appY, screens.objectAtIndex(i).visibleFrame)) {
            isVisible = true;
            break;
        }
    }
    if (!isVisible) {
        var visible = primaryScreenFrame();
        appX = Number(visible.origin.x) + Number(visible.size.width) / 2;
        appY = Number(visible.origin.y) + Number(visible.size.height) / 2;
    }

    var cgPoint = appKitPointToCG(appX, appY);
    var marker = {
        id: this.nextMarkerID,
        x: cgPoint.x,
        y: cgPoint.y,
        delayMs: DEFAULT_INTERVAL,
        panel: null,
        view: null
    };
    this.nextMarkerID += 1;
    this.markers.push(marker);
    this.selectedMarkerID = marker.id;

    this.createMarkerWindow(marker);
    this.renumberMarkers();
    this.saveMarkers();
    this.rebuildPointList();
    this.statusNote = tr("已添加第 ") + this.markers.length + tr(" 个点，请拖动圆点到目标位置");
    log("添加点 " + this.markers.length);
    this.updateUI();
};

AutoClicker.prototype.toggleDeleteMode = function () {
    if (this.isClicking || this.countdownTimer) return;
    if (this.markers.length === 0) {
        this.showError(tr("没有可删除的点"), tr("请先点击“放置”添加一个点位。"));
        return;
    }

    this.deleteMode = !this.deleteMode;
    this.statusNote = this.deleteMode ? tr("删除：点击任意红色圆点即可删除") : tr("已退出删除");
    this.updateUI();
};

AutoClicker.prototype.deletePointByID = function (id) {
    if (this.isClicking || this.countdownTimer) return;

    var index = -1;
    for (var i = 0; i < this.markers.length; i += 1) {
        if (this.markers[i].id === id) {
            index = i;
            break;
        }
    }
    if (index < 0) return;

    var marker = this.markers[index];
    if (this.flashMarkerID === id) this.stopFlash();
    if (marker.panel) marker.panel.orderOut(null);
    this.markers.splice(index, 1);
    if (this.selectedMarkerID === id) this.selectedMarkerID = null;
    if (this.markers.length === 0) this.deleteMode = false;

    this.renumberMarkers();
    this.saveMarkers();
    this.rebuildPointList();
    this.statusNote = tr("已删除点击点，剩余 ") + this.markers.length + tr(" 个");
    log("删除点，剩余 " + this.markers.length);
    this.updateUI();
};

AutoClicker.prototype.showDeleteAllDialog = function () {
    if (this.isClicking || this.countdownTimer) return;
    if (this.markers.length === 0) {
        this.showError(tr("没有可删除的点"), tr("当前没有任何点位。"));
        return;
    }
    var self = this;
    var count = this.markers.length;
    log("打开全部删除确认，当前 " + count + " 个点");

    // "取消"是默认按钮（回车），避免一按回车就把点位全删掉。
    this.showDialog({
        key: "deleteAll",
        windowTitle: tr("全部删除"),
        title: tr("删除全部 ") + count + tr(" 个点位？"),
        messageHeight: 40,
        message: tr("屏幕上的所有编号圆点都会被删除，不能撤销。已保存的方案不受影响，可以随时从“方案”里重新载入。"),
        buttons: [
            {
                title: tr("全部删除"),
                handler: function () {
                    self.deleteAllPoints();
                    return null;
                }
            },
            { title: tr("取消"), isDefault: true, cancel: true, handler: function () { log("全部删除已取消"); } }
        ]
    });
};

AutoClicker.prototype.deleteAllPoints = function () {
    if (this.isClicking || this.countdownTimer) return;
    var count = this.markers.length;
    this.stopFlash();
    for (var i = 0; i < this.markers.length; i += 1) {
        if (this.markers[i].panel) this.markers[i].panel.orderOut(null);
    }
    this.markers = [];
    this.deleteMode = false;
    this.selectedMarkerID = null;
    this.draggingMarkerID = null;

    this.saveMarkers();
    this.rebuildPointList();
    this.statusNote = tr("已删除全部 ") + count + tr(" 个点位");
    log("全部删除：" + count + " 个点");
    this.updateUI();
};

// ---------------------------------------------------------------------------
// 选中反馈：金色光环 + 圆点放大 + 闪烁，列表行高亮
// ---------------------------------------------------------------------------

AutoClicker.prototype.selectMarker = function (id, source) {
    if (this.isClicking || this.countdownTimer) return;
    var marker = this.markerByID(id);
    if (!marker) return;

    this.selectedMarkerID = id;
    if (marker.script) {
        var scriptIndex = this.scriptPoints.indexOf(marker);
        this.rebuildScriptPointList();
        var doc = this.scriptPointsScroll.documentView;
        if (!isNil(doc)) doc.scrollRectToVisible($.NSMakeRect(0, 2 + scriptIndex * 32, 300, 32));
        this.flashMarker(marker);
        if (source === tr("列表")) {
            this.statusNote = tr("已选中点位 ") + (scriptIndex + 1) + tr("「") + marker.name + tr("」");
            this.updateUI();
        }
        return;
    }
    var index = this.markers.indexOf(marker);
    this.rebuildPointList();
    this.scrollPointRowIntoView(index);
    this.flashMarker(marker);
    if (source === tr("列表")) {
        this.statusNote = tr("已选中第 ") + (index + 1) + tr(" 个点");
        this.updateUI();
    }
};

AutoClicker.prototype.scrollPointRowIntoView = function (index) {
    if (index < 0 || !this.pointsScrollView) return;
    var documentView = this.pointsScrollView.documentView;
    if (isNil(documentView)) return;
    documentView.scrollRectToVisible($.NSMakeRect(0, 4 + index * POINT_ROW_HEIGHT, 260, POINT_ROW_HEIGHT));
};

// 光环是一个不接收鼠标的透明小窗口，里面是一个金色圆环（NSBox 自定义样式，不需要自己画图）。
AutoClicker.prototype.ensureHaloPanel = function () {
    if (this.haloPanel) return this.haloPanel;

    var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(0, 0, 100, 100),
        $.NSWindowStyleMaskBorderless | $.NSWindowStyleMaskNonactivatingPanel,
        $.NSBackingStoreBuffered,
        false
    );
    panel.opaque = false;
    panel.backgroundColor = $.NSColor.clearColor;
    panel.hasShadow = false;
    panel.releasedWhenClosed = false;
    panel.hidesOnDeactivate = false;
    panel.ignoresMouseEvents = true;
    panel.level = $.NSFloatingWindowLevel;
    panel.collectionBehavior =
        $.NSWindowCollectionBehaviorCanJoinAllSpaces |
        $.NSWindowCollectionBehaviorFullScreenAuxiliary;

    var gold = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1.0, 0.78, 0.12, 1.0);
    var ring = $.NSBox.alloc.initWithFrame($.NSMakeRect(2, 2, 96, 96));
    ring.boxType = $.NSBoxCustom;
    ring.titlePosition = $.NSNoTitle;
    ring.borderWidth = 5;
    ring.borderColor = gold;
    ring.fillColor = gold.colorWithAlphaComponent(0.15);
    panel.contentView.addSubview(ring);

    this.haloPanel = panel;
    this.haloRing = ring;
    return panel;
};

// 光环直径跟着圆点大小走：圆点大小 + HALO_EXTRA。
AutoClicker.prototype.positionHalo = function (centerX, centerY) {
    if (!this.haloPanel) return;
    var size = this.markerSize + HALO_EXTRA;
    this.haloPanel.setFrameDisplay($.NSMakeRect(centerX - size / 2, centerY - size / 2, size, size), true);
    this.haloRing.frame = $.NSMakeRect(2, 2, size - 4, size - 4);
    this.haloRing.cornerRadius = (size - 4) / 2;
};

// 圆点以中心为基准改变大小（闪烁时临时放大，结束后恢复）。
AutoClicker.prototype.setMarkerSize = function (marker, size) {
    if (!marker.panel || !marker.view) return;
    var center = panelCenter(marker.panel);
    marker.panel.setFrameDisplay($.NSMakeRect(center.x - size / 2, center.y - size / 2, size, size), true);
    marker.view.font = markerFontForSize(size);
};

AutoClicker.prototype.flashMarker = function (marker) {
    this.stopFlash();
    if (!this.markerShouldShow(marker) || !marker.panel) return;

    var halo = this.ensureHaloPanel();
    this.flashMarkerID = marker.id;
    this.flashStep = 0;
    this.setMarkerSize(marker, this.markerSize + MARKER_FLASH_EXTRA);
    var center = panelCenter(marker.panel);
    this.positionHalo(center.x, center.y);
    halo.alphaValue = 1.0;
    halo.orderFrontRegardless;

    // 亮 → 暗 → 亮 → 暗 → 亮 → 暗，共闪 3 下，约 0.9 秒后结束。
    var self = this;
    this.flashTimer = scheduleRepeating(FLASH_STEP_SECONDS, function (timer) {
        self.flashStep += 1;
        if (self.flashStep >= FLASH_STEPS) {
            self.stopFlash();
            return;
        }
        if (self.haloPanel) self.haloPanel.alphaValue = self.flashStep % 2 === 0 ? 1.0 : 0.15;
    });
};

AutoClicker.prototype.stopFlash = function () {
    if (this.flashTimer) this.flashTimer.invalidate;
    this.flashTimer = null;
    if (this.haloPanel) this.haloPanel.orderOut(null);
    if (this.flashMarkerID !== null) {
        var marker = this.markerByID(this.flashMarkerID);
        if (marker) this.setMarkerSize(marker, this.markerSize);
    }
    this.flashMarkerID = null;
    this.flashStep = 0;
};

AutoClicker.prototype.loadLayout = function (index) {
    if (this.isClicking || this.countdownTimer) return;
    var layout = this.layouts[index];
    if (!layout) return;

    this.closeDialog();
    this.stopFlash();
    for (var i = 0; i < this.markers.length; i += 1) {
        if (this.markers[i].panel) this.markers[i].panel.orderOut(null);
    }
    this.markers = [];
    this.deleteMode = false;
    this.selectedMarkerID = null;
    this.draggingMarkerID = null;

    for (var j = 0; j < layout.markers.length; j += 1) {
        var saved = layout.markers[j];
        var marker = {
            id: this.nextMarkerID,
            x: saved.x,
            y: saved.y,
            delayMs: saved.delayMs,
            panel: null,
            view: null
        };
        this.nextMarkerID += 1;
        this.markers.push(marker);
        this.createMarkerWindow(marker);
    }

    this.renumberMarkers();
    this.saveMarkers();
    this.rebuildPointList();
    this.statusNote = tr("已载入方案「") + layout.name + tr("」（") + this.markers.length + tr(" 个点）");
    log("载入方案「" + layout.name + "」：" + this.markers.length + " 个点");
    this.updateUI();
};

// ---------------------------------------------------------------------------
// 非模态对话框（替代所有 NSAlert.runModal）
// ---------------------------------------------------------------------------

AutoClicker.prototype.showDialog = function (spec) {
    this.closeDialog();
    // 对话框贴着工具栏弹出：最小化时先展开工具栏（例如手机上点开始，检查没通过要提示）
    if (this.minimized) this.restoreToolbar(true);

    var fields = spec.fields || [];
    var checkboxes = spec.checkboxes || [];
    var hasPreview = typeof spec.preview === "function";
    var messageHeight = spec.messageHeight || 56;
    // 英文比中文长，按字数估算行数，放不下就加高（每行约 62 个字母、18 点高）
    if (currentLanguage() === "en" && spec.message) {
        messageHeight = Math.max(messageHeight, Math.ceil(spec.message.length / 62) * 18 + 4);
    }
    var top = 18;
    var titleHeight = 22;
    var checkboxHeight = checkboxes.length ? 24 : 0;
    var fieldHeight = fields.length ? 26 : 0;
    var previewHeight = hasPreview ? 20 : 0;
    var errorHeight = 20;
    var buttonHeight = 32;
    var height = top + titleHeight + 8 + messageHeight + 8 +
        (checkboxHeight ? checkboxHeight + 8 : 0) +
        (fieldHeight ? fieldHeight + 8 : 0) +
        (previewHeight ? previewHeight + 4 : 0) +
        errorHeight + 10 + buttonHeight + 18;

    var toolbarFrame = this.currentToolbar().frame;
    var toolbarX = Number(toolbarFrame.origin.x);
    var toolbarY = Number(toolbarFrame.origin.y);
    var toolbarW = Number(toolbarFrame.size.width);
    var toolbarH = Number(toolbarFrame.size.height);
    var visible = visibleFrameForPoint(toolbarX + toolbarW / 2, toolbarY + toolbarH / 2);
    var x = toolbarX - DIALOG_WIDTH - 12;
    var y = toolbarY + toolbarH - height - 60;
    var minX = Number(visible.origin.x) + 8;
    var maxX = Number(visible.origin.x) + Number(visible.size.width) - DIALOG_WIDTH - 8;
    var minY = Number(visible.origin.y) + 8;
    var maxY = Number(visible.origin.y) + Number(visible.size.height) - height - 8;
    x = clamp(x, minX, Math.max(minX, maxX));
    y = clamp(y, minY, Math.max(minY, maxY));

    var panel = $.AutoClickerPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(x, y, DIALOG_WIDTH, height),
        $.NSWindowStyleMaskTitled,
        $.NSBackingStoreBuffered,
        false
    );
    panel.title = spec.windowTitle || tr("AutoClicker");
    panel.releasedWhenClosed = false;
    panel.hidesOnDeactivate = false;
    panel.floatingPanel = true;
    panel.becomesKeyOnlyIfNeeded = false;
    panel.level = $.NSModalPanelWindowLevel;
    panel.collectionBehavior =
        $.NSWindowCollectionBehaviorCanJoinAllSpaces |
        $.NSWindowCollectionBehaviorFullScreenAuxiliary;

    var content = $.AutoClickerFlippedView.alloc.initWithFrame(
        $.NSMakeRect(0, 0, DIALOG_WIDTH, height)
    );
    panel.contentView = content;

    var cursor = top;
    content.addSubview(this.makeLabel(
        spec.title, $.NSMakeRect(20, cursor, DIALOG_WIDTH - 40, titleHeight),
        14, true, $.NSColor.labelColor
    ));
    cursor += titleHeight + 8;

    var message = this.makeLabel(
        spec.message, $.NSMakeRect(20, cursor, DIALOG_WIDTH - 40, messageHeight),
        12, false, $.NSColor.labelColor
    );
    message.lineBreakMode = $.NSLineBreakByWordWrapping;
    content.addSubview(message);
    cursor += messageHeight + 8;

    var dialog = {
        key: spec.key || "dialog",
        panel: panel,
        spec: spec,
        fields: {},
        fieldOrder: [],
        checkboxes: {},
        previewLabel: null,
        errorLabel: null,
        firstField: null
    };
    this.activeDialog = dialog;

    if (checkboxes.length) {
        var cx = 20;
        for (var c = 0; c < checkboxes.length; c += 1) {
            var item = checkboxes[c];
            var width = item.width || 84;
            var box = $.NSButton.alloc.initWithFrame($.NSMakeRect(cx, cursor, width, checkboxHeight));
            box.setButtonType($.NSButtonTypeSwitch);
            box.title = item.label;
            box.state = item.checked ? 1 : 0;
            box.target = this.actionTarget;
            box.action = $.NSSelectorFromString("dialogControlChanged:");
            content.addSubview(box);
            dialog.checkboxes[item.key] = box;
            cx += width + 6;
        }
        cursor += checkboxHeight + 8;
    }

    if (fields.length) {
        var fx = 20;
        var available = DIALOG_WIDTH - 40;
        for (var f = 0; f < fields.length; f += 1) {
            var fieldSpec = fields[f];
            var fieldWidth = fieldSpec.width || (fields.length === 1 && !fieldSpec.label ? available : 80);
            var field = $.NSTextField.alloc.initWithFrame(
                $.NSMakeRect(fx, cursor, fieldWidth, fieldHeight)
            );
            field.stringValue = String(fieldSpec.value === undefined ? "" : fieldSpec.value);
            field.editable = true;
            field.selectable = true;
            field.bezeled = true;
            field.drawsBackground = true;
            field.font = $.NSFont.systemFontOfSize(13);
            field.delegate = this.dialogDelegate;
            if (fieldSpec.placeholder) field.placeholderString = fieldSpec.placeholder;
            content.addSubview(field);
            dialog.fields[fieldSpec.key] = field;
            dialog.fieldOrder.push(field);
            if (!dialog.firstField) dialog.firstField = field;
            fx += fieldWidth + 6;
            if (fieldSpec.label) {
                var labelWidth = fieldSpec.labelWidth || 44;
                var suffix = this.makeLabel(
                    fieldSpec.label, $.NSMakeRect(fx, cursor + 4, labelWidth, 20),
                    12, false, $.NSColor.labelColor
                );
                content.addSubview(suffix);
                fx += labelWidth + 8;
            }
        }
        for (var n = 0; n + 1 < dialog.fieldOrder.length; n += 1) {
            dialog.fieldOrder[n].nextKeyView = dialog.fieldOrder[n + 1];
        }
        cursor += fieldHeight + 8;
    }

    if (hasPreview) {
        dialog.previewLabel = this.makeLabel(
            "", $.NSMakeRect(20, cursor, DIALOG_WIDTH - 40, previewHeight),
            12, true, $.NSColor.labelColor
        );
        content.addSubview(dialog.previewLabel);
        cursor += previewHeight + 4;
    }

    dialog.errorLabel = this.makeLabel(
        "", $.NSMakeRect(20, cursor, DIALOG_WIDTH - 40, errorHeight),
        11, true, $.NSColor.systemRedColor
    );
    content.addSubview(dialog.errorLabel);
    cursor += errorHeight + 10;

    var buttonWidth = 104;
    var right = DIALOG_WIDTH - 20;
    var buttons = spec.buttons || [];
    for (var i = buttons.length - 1; i >= 0; i -= 1) {
        var frame = $.NSMakeRect(right - buttonWidth, cursor, buttonWidth, buttonHeight);
        var button = this.makeButton(buttons[i].title, frame, "dialogButton:");
        button.tag = i;
        if (buttons[i].isDefault) button.keyEquivalent = "\r";
        else if (buttons[i].cancel) button.keyEquivalent = "";
        content.addSubview(button);
        right -= buttonWidth + 10;
    }

    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
    if (dialog.firstField) panel.initialFirstResponder = dialog.firstField;
    panel.makeKeyAndOrderFront(null);
    if (dialog.firstField) {
        panel.makeFirstResponder(dialog.firstField);
        dialog.firstField.selectText(null);
        if (!spec.allowAnyInput) this.restrictFieldToRomanInput(panel, dialog.firstField);
    }
    this.dialogValuesChanged();
    log("打开对话框 [" + dialog.key + "] key=" + jsBoolean(panel.isKeyWindow) +
        " 焦点=" + (dialog.firstField ? jsString(panel.firstResponder.className) : "无输入框"));
};

AutoClicker.prototype.dialogValues = function () {
    var dialog = this.activeDialog;
    var values = {};
    if (!dialog) return values;
    for (var key in dialog.fields) {
        if (dialog.fields.hasOwnProperty(key)) {
            values[key] = jsString(dialog.fields[key].stringValue);
        }
    }
    for (var box in dialog.checkboxes) {
        if (dialog.checkboxes.hasOwnProperty(box)) {
            values[box] = jsNumber(dialog.checkboxes[box].state) === 1;
        }
    }
    return values;
};

// 输入框内容或勾选框变化时刷新实时预览
AutoClicker.prototype.dialogValuesChanged = function () {
    var dialog = this.activeDialog;
    if (!dialog || !dialog.previewLabel) return;
    try {
        var text = dialog.spec.preview(this.dialogValues());
        dialog.previewLabel.stringValue = text || "";
    } catch (error) {
        dialog.previewLabel.stringValue = "";
    }
};

// 输入框只需要数字/ASCII。中文输入法会把字母当作拼音组合，第一次回车被输入法吃掉，
// 这里把 field editor 限制为罗马字母输入源，回车直接触发"保存"。
AutoClicker.prototype.restrictFieldToRomanInput = function (panel, field) {
    try {
        var editor = panel.fieldEditorForObject(true, field);
        if (isNil(editor)) return;
        var context = editor.inputContext;
        if (isNil(context)) return;
        context.allowedInputSourceLocales = $([$.NSAllRomanInputSourcesLocaleIdentifier]);
    } catch (error) {
        log("限制输入源失败：" + error);
    }
};

AutoClicker.prototype.closeDialog = function () {
    var dialog = this.activeDialog;
    if (!dialog) return;
    this.activeDialog = null;
    dialog.panel.orderOut(null);
    log("关闭对话框 [" + dialog.key + "]");
    if (typeof dialog.spec.onClose === "function") {
        try { dialog.spec.onClose(); } catch (error) { log("对话框 [" + dialog.key + "] onClose 出错：" + error); }
    }
};

AutoClicker.prototype.dialogButtonPressed = function (index) {
    var dialog = this.activeDialog;
    if (!dialog) return;
    var button = dialog.spec.buttons[index];
    if (!button) return;

    var values = this.dialogValues();
    var result = null;
    try {
        result = button.handler ? button.handler(values) : null;
    } catch (error) {
        log("对话框 [" + dialog.key + "] 按钮“" + button.title + "”处理出错：" + error);
        result = { error: tr("处理失败：") + error };
    }
    if (this.activeDialog !== dialog) return;

    if (result && result.error) {
        dialog.errorLabel.stringValue = result.error;
        $.NSBeep();
        var focus = (result.field && dialog.fields[result.field]) || dialog.firstField;
        if (focus) {
            dialog.panel.makeFirstResponder(focus);
            focus.selectText(null);
        }
        return;
    }
    if (result && result.keepOpen) {
        if (result.note !== undefined) dialog.errorLabel.stringValue = result.note;
        return;
    }
    this.closeDialog();
    var toolbar = this.currentToolbar();
    if (jsBoolean(toolbar.visible)) toolbar.makeKeyAndOrderFront(null);
};

AutoClicker.prototype.showError = function (title, detail) {
    log("错误提示：" + title + " — " + detail);
    this.noteError(title, detail);
    this.showDialog({
        key: "error",
        windowTitle: tr("AutoClicker"),
        title: title,
        message: detail,
        buttons: [{ title: tr("好"), isDefault: true, cancel: true }]
    });
};

function parseNonNegativeInteger(text, maximum) {
    var cleaned = String(text || "").replace(/[,，\s]/g, "");
    if (cleaned === "") return 0;
    if (!/^\d{1,7}$/.test(cleaned)) return null;
    var number = Number(cleaned);
    if (number > maximum) return null;
    return number;
}

AutoClicker.prototype.showIntervalDialog = function (id) {
    if (this.isClicking || this.countdownTimer) return;
    var marker = this.markerByID(id);
    if (!marker) return;

    var self = this;
    var pointNumber = this.markers.indexOf(marker) + 1;
    log("打开间隔编辑：点 " + pointNumber + "，当前 " + marker.delayMs + " ms");

    this.showDialog({
        key: "interval",
        windowTitle: tr("点击间隔"),
        title: tr("设置第 ") + pointNumber + tr(" 个点的点击间隔"),
        message: tr("输入 1–60,000 毫秒，表示点击这个点后等待多久再点击下一个点。回车保存，Esc 取消。"),
        fields: [{ key: "value", value: String(marker.delayMs), placeholder: tr("例如 750") }],
        buttons: [
            {
                title: tr("取消"),
                cancel: true,
                handler: function () {
                    log("间隔编辑已取消（点 " + pointNumber + "）");
                    self.statusNote = tr("已取消修改");
                    self.updateUI();
                }
            },
            {
                title: tr("保存"),
                isDefault: true,
                handler: function (values) {
                    var text = String(values.value || "").replace(/[,，\s]/g, "");
                    if (!/^\d{1,6}$/.test(text)) {
                        log("间隔输入无效（点 " + pointNumber + "）");
                        return { error: tr("请输入 1–60,000 之间的整数毫秒数。") };
                    }
                    var number = Number(text);
                    if (number < MIN_INTERVAL || number > MAX_INTERVAL) {
                        log("间隔超出范围（点 " + pointNumber + "）：" + number);
                        return { error: tr("范围是 1–60,000 毫秒，当前输入 ") + number + tr("。") };
                    }
                    marker.delayMs = number;
                    self.saveMarkers();
                    self.rebuildPointList();
                    self.statusNote = tr("第 ") + pointNumber + tr(" 个点：点击间隔 ") + number + tr(" 毫秒");
                    log("间隔已保存：点 " + pointNumber + " = " + number + " ms");
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

// 勾选框 + 主键输入框拼成 parseShortcut 能识别的文本
function shortcutTextFromValues(values) {
    var parts = [];
    if (values.ctrl) parts.push("Ctrl");
    if (values.option) parts.push("Option");
    if (values.shift) parts.push("Shift");
    if (values.cmd) parts.push("Cmd");
    var key = String(values.key || "").trim();
    if (key.length === 1) key = key.toUpperCase();
    if (key) parts.push(key);
    return parts.join("+");
}

AutoClicker.prototype.showShortcutDialog = function () {
    if (this.isClicking || this.countdownTimer) return;
    var self = this;
    var current = this.shortcut;
    log("打开快捷键编辑，当前 " + current.display);

    this.showDialog({
        key: "shortcut",
        windowTitle: tr("快捷键"),
        title: tr("设置开始/停止快捷键"),
        messageHeight: 40,
        message: tr("勾选修饰键，再输入一个主键：字母、数字、F1–F12、Enter、Space、Tab、Up/Down/Left/Right。Esc 固定为紧急停止键。"),
        checkboxes: [
            { key: "ctrl", label: "Ctrl", checked: Boolean(current.modifiers & MOD_CONTROL), width: 66 },
            { key: "option", label: "Option", checked: Boolean(current.modifiers & MOD_OPTION), width: 80 },
            { key: "shift", label: "Shift", checked: Boolean(current.modifiers & MOD_SHIFT), width: 70 },
            { key: "cmd", label: "Cmd", checked: Boolean(current.modifiers & MOD_COMMAND), width: 66 }
        ],
        fields: [{ key: "key", value: current.label, label: tr("主键"), width: 120, placeholder: tr("例如 C 或 F6") }],
        preview: function (values) {
            var text = shortcutTextFromValues(values);
            if (!text) return tr("将设为：（请勾选修饰键并输入主键）");
            var candidate = parseShortcut(text);
            if (!candidate) {
                var hasModifier = values.ctrl || values.option || values.shift || values.cmd;
                if (!hasModifier) return tr("将设为：（至少勾选一个修饰键）");
                if (!String(values.key || "").trim()) return tr("将设为：（请输入主键）");
                return tr("无法识别主键：") + String(values.key).trim();
            }
            if (candidate.keyCode === ESCAPE_KEY_CODE) return tr("Esc 不能作为主键");
            return tr("将设为：") + candidate.display;
        },
        buttons: [
            {
                title: tr("取消"),
                cancel: true,
                handler: function () {
                    log("快捷键编辑已取消");
                }
            },
            {
                title: tr("保存"),
                isDefault: true,
                handler: function (values) {
                    var candidate = parseShortcut(shortcutTextFromValues(values));
                    if (!candidate) {
                        log("快捷键格式无效");
                        return { error: tr("请至少勾选一个修饰键，并输入一个能识别的主键。"), field: "key" };
                    }
                    if (candidate.keyCode === ESCAPE_KEY_CODE) {
                        return { error: tr("Esc 已固定为紧急停止键，请换一个主键。"), field: "key" };
                    }
                    self.shortcut = candidate;
                    self.defaults.setObjectForKey(candidate.display, "shortcut");
                    self.defaults.synchronize;
                    self.applyShortcutToMenu();
                    self.statusNote = tr("开始/停止快捷键已改为 ") + candidate.display;
                    log("快捷键已保存：" + candidate.display);
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

function formatDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return tr("不限");
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    var parts = [];
    if (h) parts.push(h + tr(" 小时"));
    if (m) parts.push(m + tr(" 分钟"));
    if (s || parts.length === 0) parts.push(s + tr(" 秒"));
    return parts.join(" ");
}

function formatClock(totalSeconds) {
    var t = Math.max(0, Math.round(totalSeconds));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    return (h ? h + ":" : "") + (h ? pad(m) : m) + ":" + pad(s);
}

AutoClicker.prototype.showDurationDialog = function () {
    if (this.isClicking || this.countdownTimer) return;
    var self = this;
    var total = this.durationSeconds;
    log("打开持续时间编辑，当前 " + formatDuration(total));

    this.showDialog({
        key: "duration",
        windowTitle: tr("持续时间"),
        title: tr("设置持续时间"),
        messageHeight: 40,
        message: tr("运行这么长时间后自动停止。全部留空或为 0 表示不限时（一直运行到手动停止）。最长 24 小时。"),
        fields: [
            { key: "h", value: total ? Math.floor(total / 3600) : "", label: tr("小时"), width: 64, placeholder: "0" },
            { key: "m", value: total ? Math.floor((total % 3600) / 60) : "", label: tr("分钟"), width: 64, placeholder: "0" },
            { key: "s", value: total ? total % 60 : "", label: tr("秒"), width: 64, placeholder: "0" }
        ],
        preview: function (values) {
            var h = parseNonNegativeInteger(values.h, 24);
            var m = parseNonNegativeInteger(values.m, 59);
            var s = parseNonNegativeInteger(values.s, 59);
            if (h === null) return tr("小时应为 0–24 的整数");
            if (m === null) return tr("分钟应为 0–59 的整数");
            if (s === null) return tr("秒应为 0–59 的整数");
            var seconds = h * 3600 + m * 60 + s;
            if (seconds > 24 * 3600) return tr("最长 24 小时");
            return tr("将设为：") + formatDuration(seconds);
        },
        buttons: [
            { title: tr("取消"), cancel: true, handler: function () { log("持续时间编辑已取消"); } },
            {
                title: tr("保存"),
                isDefault: true,
                handler: function (values) {
                    var h = parseNonNegativeInteger(values.h, 24);
                    var m = parseNonNegativeInteger(values.m, 59);
                    var s = parseNonNegativeInteger(values.s, 59);
                    if (h === null) return { error: tr("小时应为 0–24 的整数。"), field: "h" };
                    if (m === null) return { error: tr("分钟应为 0–59 的整数。"), field: "m" };
                    if (s === null) return { error: tr("秒应为 0–59 的整数。"), field: "s" };
                    var seconds = h * 3600 + m * 60 + s;
                    if (seconds > 24 * 3600) return { error: tr("最长 24 小时。"), field: "h" };
                    self.durationSeconds = seconds;
                    self.defaults.setIntegerForKey(seconds, "durationSeconds");
                    self.defaults.synchronize;
                    self.statusNote = tr("持续时间：") + formatDuration(seconds);
                    log("持续时间已保存：" + seconds + " 秒");
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.showJitterDialog = function () {
    if (this.isClicking || this.countdownTimer) return;
    var self = this;
    log("打开随机扰动编辑，当前 ±" + this.jitterMs + " ms / ±" + this.jitterPx + " px");

    this.showDialog({
        key: "jitter",
        windowTitle: tr("随机扰动"),
        title: tr("设置随机扰动"),
        messageHeight: 56,
        message: tr("每次点击的间隔在设定值上下随机浮动（毫秒），点击位置在圆点周围随机偏移（像素）。都填 0 表示关闭。间隔浮动最大 ") + MAX_JITTER_MS + tr(" ms，位置偏移最大 ") + MAX_JITTER_PX + tr(" px。"),
        fields: [
            { key: "ms", value: this.jitterMs || "", label: tr("ms 间隔"), width: 80, labelWidth: 60, placeholder: "0" },
            { key: "px", value: this.jitterPx || "", label: tr("px 位置"), width: 80, labelWidth: 60, placeholder: "0" }
        ],
        preview: function (values) {
            var ms = parseNonNegativeInteger(values.ms, MAX_JITTER_MS);
            var px = parseNonNegativeInteger(values.px, MAX_JITTER_PX);
            if (ms === null) return tr("间隔浮动应为 0–") + MAX_JITTER_MS + tr(" 的整数");
            if (px === null) return tr("位置偏移应为 0–") + MAX_JITTER_PX + tr(" 的整数");
            if (!ms && !px) return tr("将设为：关闭");
            return tr("将设为：间隔 ±") + ms + tr(" ms，位置 ±") + px + " px";
        },
        buttons: [
            { title: tr("取消"), cancel: true, handler: function () { log("随机扰动编辑已取消"); } },
            {
                title: tr("保存"),
                isDefault: true,
                handler: function (values) {
                    var ms = parseNonNegativeInteger(values.ms, MAX_JITTER_MS);
                    var px = parseNonNegativeInteger(values.px, MAX_JITTER_PX);
                    if (ms === null) return { error: tr("间隔浮动应为 0–") + MAX_JITTER_MS + tr(" 的整数。"), field: "ms" };
                    if (px === null) return { error: tr("位置偏移应为 0–") + MAX_JITTER_PX + tr(" 的整数。"), field: "px" };
                    self.jitterMs = ms;
                    self.jitterPx = px;
                    self.defaults.setIntegerForKey(ms, "jitterMs");
                    self.defaults.setIntegerForKey(px, "jitterPx");
                    self.defaults.synchronize;
                    self.statusNote = tr("随机扰动：") + (ms || px ? "±" + ms + " ms / ±" + px + " px" : tr("关闭"));
                    log("随机扰动已保存：±" + ms + " ms / ±" + px + " px");
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

// 一次性改变所有圆点的大小（以各自中心为基准，点击坐标不变）。
AutoClicker.prototype.applyMarkerSize = function (size) {
    this.stopFlash();
    this.markerSize = size;
    var all = this.allMarkers();
    for (var i = 0; i < all.length; i += 1) {
        this.setMarkerSize(all[i], size);
    }
};

AutoClicker.prototype.showMarkerSizeDialog = function () {
    if (this.isClicking || this.countdownTimer) return;
    var self = this;
    var original = this.markerSize;
    log("打开圆点大小编辑，当前 " + original + " px");

    function parseSize(text) {
        var cleaned = String(text || "").replace(/[,，\s]|px/gi, "");
        if (!/^\d{1,3}$/.test(cleaned)) return null;
        var size = Number(cleaned);
        if (size < MIN_MARKER_SIZE || size > MAX_MARKER_SIZE) return null;
        return size;
    }

    function save(size) {
        self.applyMarkerSize(size);
        self.defaults.setIntegerForKey(size, "markerSize");
        self.defaults.synchronize;
        self.statusNote = tr("圆点大小：") + size + tr(" px（全部 ") + self.allMarkers().length + tr(" 个点已更新）");
        log("圆点大小已保存：" + size + " px");
        self.updateUI();
    }

    this.showDialog({
        key: "markerSize",
        windowTitle: tr("圆点大小"),
        title: tr("设置全部编号圆点的大小"),
        messageHeight: 56,
        message: tr("输入 ") + MIN_MARKER_SIZE + "–" + MAX_MARKER_SIZE + tr(" 像素（默认 ") + MARKER_SIZE + tr("）。所有圆点一起变，边输入边预览；") +
            tr("圆点中心（真正的点击位置）不变。圆点太大容易挡住目标，太小不好拖动。"),
        fields: [{ key: "size", value: String(original), label: "px", width: 80, labelWidth: 30, placeholder: String(MARKER_SIZE) }],
        // 不管窗口怎么关（取消、Esc、被别的窗口顶掉），没保存的预览大小都恢复成已保存的值。
        onClose: function () {
            var saved = clamp(jsNumber(self.defaults.integerForKey("markerSize")) || MARKER_SIZE, MIN_MARKER_SIZE, MAX_MARKER_SIZE);
            if (self.markerSize !== saved) self.applyMarkerSize(saved);
            self.updateUI();
        },
        preview: function (values) {
            var size = parseSize(values.size);
            if (size === null) return tr("请输入 ") + MIN_MARKER_SIZE + "–" + MAX_MARKER_SIZE + tr(" 的整数");
            // 实时预览：屏幕上的圆点立即变成输入的大小，按"取消"会恢复。
            if (size !== self.markerSize) self.applyMarkerSize(size);
            return tr("预览中：") + size + " px" + (size === original ? tr("（当前大小）") : tr("（原来 ") + original + tr(" px）"));
        },
        buttons: [
            {
                title: tr("取消"),
                cancel: true,
                handler: function () {
                    log("圆点大小编辑已取消，恢复 " + original + " px");
                }
            },
            {
                title: tr("恢复默认"),
                handler: function () {
                    save(MARKER_SIZE);
                    return null;
                }
            },
            {
                title: tr("保存"),
                isDefault: true,
                handler: function (values) {
                    var size = parseSize(values.size);
                    if (size === null) {
                        return { error: tr("请输入 ") + MIN_MARKER_SIZE + "–" + MAX_MARKER_SIZE + tr(" 之间的整数像素。") };
                    }
                    save(size);
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.showSaveLayoutDialog = function () {
    if (this.isClicking || this.countdownTimer) return;
    if (this.markers.length === 0) {
        this.showError(tr("没有可保存的点位"), tr("请先点击“放置”添加点位，再保存为方案。"));
        return;
    }
    var self = this;
    var count = this.markers.length;
    var defaultName = tr("方案 ") + (this.layouts.length + 1);
    while (this.layoutIndexByName(defaultName) >= 0) defaultName += "'";
    log("打开保存方案，当前 " + count + " 个点");

    this.showDialog({
        key: "saveLayout",
        windowTitle: tr("保存方案"),
        title: tr("把当前 ") + count + tr(" 个点保存为方案"),
        messageHeight: 40,
        message: tr("保存所有点的位置和点击间隔。以后在“方案”下拉菜单或菜单栏图标里点一下即可恢复整套布局。同名方案会被覆盖。"),
        allowAnyInput: true,
        fields: [{ key: "name", value: defaultName, placeholder: tr("例如 每日流程") }],
        preview: function (values) {
            var name = String(values.name || "").trim();
            if (!name) return tr("请输入方案名称");
            if (name.length > MAX_LAYOUT_NAME) return tr("名称最多 ") + MAX_LAYOUT_NAME + tr(" 个字");
            if (self.layoutIndexByName(name) >= 0) return tr("将覆盖已有方案「") + name + tr("」");
            return tr("将保存为「") + name + tr("」（") + count + tr(" 个点）");
        },
        buttons: [
            { title: tr("取消"), cancel: true, handler: function () { log("保存方案已取消"); } },
            {
                title: tr("保存"),
                isDefault: true,
                handler: function (values) {
                    var name = String(values.name || "").trim();
                    if (!name) return { error: tr("请输入方案名称。") };
                    if (name.length > MAX_LAYOUT_NAME) return { error: tr("名称最多 ") + MAX_LAYOUT_NAME + tr(" 个字。") };
                    var existing = self.layoutIndexByName(name);
                    if (existing < 0 && self.layouts.length >= MAX_LAYOUTS) {
                        return { error: tr("最多保存 ") + MAX_LAYOUTS + tr(" 个方案，请先删除不用的方案。") };
                    }
                    var points = [];
                    for (var i = 0; i < self.markers.length; i += 1) {
                        var marker = self.markers[i];
                        points.push({ x: marker.x, y: marker.y, delayMs: marker.delayMs });
                    }
                    var layout = { name: name, markers: points };
                    if (existing >= 0) self.layouts[existing] = layout;
                    else self.layouts.push(layout);
                    self.saveLayouts();
                    self.rebuildLayoutMenus();
                    self.statusNote = (existing >= 0 ? tr("已覆盖方案「") : tr("已保存方案「")) + name + tr("」");
                    log("方案已保存「" + name + "」：" + points.length + " 个点" + (existing >= 0 ? "（覆盖）" : ""));
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.showDeleteLayoutDialog = function (index) {
    if (this.isClicking || this.countdownTimer) return;
    var layout = this.layouts[index];
    if (!layout) return;
    var self = this;

    this.showDialog({
        key: "deleteLayout",
        windowTitle: tr("删除方案"),
        title: tr("删除方案「") + layout.name + tr("」？"),
        messageHeight: 24,
        message: tr("只删除保存的方案，不影响屏幕上当前的点位。"),
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("删除"),
                isDefault: true,
                handler: function () {
                    var current = self.layouts.indexOf(layout);
                    if (current >= 0) self.layouts.splice(current, 1);
                    self.saveLayouts();
                    self.rebuildLayoutMenus();
                    self.statusNote = tr("已删除方案「") + layout.name + tr("」");
                    log("删除方案「" + layout.name + "」");
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

// 一键调整所有点的间隔：
//   300      → 全部设为 300 ms
//   50%      → 全部按比例缩放（50% = 快一倍，200% = 慢一倍）；也可写 x0.5
//   +100/-100 → 全部加/减 100 ms
function parseIntervalAdjustment(text) {
    var cleaned = String(text || "").replace(/[,，\s]/g, "").replace(/％/g, "%").replace(/[×＊*]/g, "x");
    var match;
    if ((match = /^(\d{1,6})$/.exec(cleaned))) {
        var value = Number(match[1]);
        if (value < MIN_INTERVAL || value > MAX_INTERVAL) return { error: tr("统一间隔范围是 1–60,000 毫秒") };
        return { kind: "set", value: value };
    }
    if ((match = /^(\d{1,5}(?:\.\d{1,2})?)%$/.exec(cleaned))) {
        var percent = Number(match[1]);
        if (percent <= 0) return { error: tr("百分比必须大于 0") };
        return { kind: "scale", value: percent / 100 };
    }
    if ((match = /^x(\d{1,3}(?:\.\d{1,3})?)$/i.exec(cleaned))) {
        var factor = Number(match[1]);
        if (factor <= 0) return { error: tr("倍数必须大于 0") };
        return { kind: "scale", value: factor };
    }
    if ((match = /^([+\-－])(\d{1,6})$/.exec(cleaned))) {
        var offset = Number(match[2]);
        return { kind: "offset", value: match[1] === "+" ? offset : -offset };
    }
    return null;
}

function applyIntervalAdjustment(adjustment, delay) {
    var result = delay;
    if (adjustment.kind === "set") result = adjustment.value;
    else if (adjustment.kind === "scale") result = delay * adjustment.value;
    else if (adjustment.kind === "offset") result = delay + adjustment.value;
    return clamp(Math.round(result), MIN_INTERVAL, MAX_INTERVAL);
}

AutoClicker.prototype.showAdjustIntervalsDialog = function () {
    if (this.isClicking || this.countdownTimer) return;
    if (this.markers.length === 0) {
        this.showError(tr("还没有点击点"), tr("请先点击“放置”添加点位。"));
        return;
    }
    var self = this;
    log("打开全部间隔调整，" + this.markers.length + " 个点");

    this.showDialog({
        key: "adjustIntervals",
        windowTitle: tr("全部间隔"),
        title: tr("一键调整全部 ") + this.markers.length + tr(" 个点的点击间隔"),
        messageHeight: 56,
        message: tr("输入数字：全部统一设为该毫秒数（如 300）\n") +
            tr("输入百分比：按比例变快/变慢（50% = 快一倍，200% = 慢一倍）\n") +
            tr("输入 +N / -N：全部加/减 N 毫秒（如 -100）"),
        fields: [{ key: "value", value: "", placeholder: tr("例如 300、50%、-100") }],
        preview: function (values) {
            if (!String(values.value || "").trim()) return tr("（请输入调整方式）");
            var adjustment = parseIntervalAdjustment(values.value);
            if (!adjustment) return tr("无法识别，请输入如 300、50%、+100");
            if (adjustment.error) return adjustment.error;
            var parts = [];
            for (var i = 0; i < self.markers.length && i < 4; i += 1) {
                var delay = self.markers[i].delayMs;
                parts.push(delay + "→" + applyIntervalAdjustment(adjustment, delay));
            }
            return tr("将变为：") + parts.join(tr("，")) + (self.markers.length > 4 ? " …" : "") + " ms";
        },
        buttons: [
            { title: tr("取消"), cancel: true, handler: function () { log("全部间隔调整已取消"); } },
            {
                title: tr("应用"),
                isDefault: true,
                handler: function (values) {
                    var adjustment = parseIntervalAdjustment(values.value);
                    if (!adjustment) return { error: tr("请输入如 300、50%、x0.5、+100、-100。") };
                    if (adjustment.error) return { error: adjustment.error + tr("。") };
                    for (var i = 0; i < self.markers.length; i += 1) {
                        self.markers[i].delayMs = applyIntervalAdjustment(adjustment, self.markers[i].delayMs);
                    }
                    self.saveMarkers();
                    self.rebuildPointList();
                    self.statusNote = tr("已调整全部 ") + self.markers.length + tr(" 个点的间隔");
                    log("全部间隔已调整（" + String(values.value).trim() + "）：" +
                        self.markers.map(function (m) { return m.delayMs; }).join(", ") + " ms");
                    self.updateUI();
                    return null;
                }
            }
        ]
    });
};

AutoClicker.prototype.showPermissionDialog = function (fromLaunch) {
    this.trusted = jsBoolean($.AXIsProcessTrusted());
    this.updateUI();
    var self = this;
    log("打开权限窗口，trusted=" + this.trusted + (fromLaunch ? "（启动时）" : ""));

    if (this.trusted) {
        this.showDialog({
            key: "permission",
            windowTitle: tr("辅助功能"),
            title: tr("辅助功能权限正常"),
            message: tr("当前这个 AutoClicker 已经获得授权，可以生成鼠标点击。"),
            buttons: [{ title: tr("好"), isDefault: true, cancel: true }]
        });
        return;
    }

    var appPath = jsString($.NSBundle.mainBundle.bundlePath);
    this.showDialog({
        key: "permission",
        windowTitle: tr("辅助功能"),
        title: tr("系统还没有授权当前版本"),
        messageHeight: 96,
        message: tr("系统设置 → 隐私与安全性 → 辅助功能，打开“AutoClicker”开关。\n") +
            tr("如果列表里已经有“AutoClicker”但仍不生效：先用 − 删除它，再点 + 重新选择：\n") +
            appPath + tr("\n然后点“重新检查”。"),
        buttons: [
            { title: tr("取消"), cancel: true },
            {
                title: tr("重新检查"),
                handler: function () {
                    self.trusted = jsBoolean($.AXIsProcessTrusted());
                    self.updateUI();
                    log("重新检查权限：trusted=" + self.trusted);
                    if (self.trusted) {
                        self.statusNote = tr("辅助功能已授权");
                        self.updateUI();
                        return null;
                    }
                    return { keepOpen: true, note: tr("系统仍未授权，请按上面步骤操作后再点“重新检查”。") };
                }
            },
            {
                title: tr("打开系统设置"),
                isDefault: true,
                handler: function () {
                    self.openAccessibilitySettings();
                    return { keepOpen: true, note: tr("已打开系统设置，授权后请点“重新检查”。") };
                }
            }
        ]
    });
};

AutoClicker.prototype.showWelcome = function () {
    var self = this;
    this.showDialog({
        key: "welcome",
        windowTitle: tr("AutoClicker"),
        title: tr("多点序列模式已经准备好"),
        messageHeight: 72,
        message: tr("点击“放置”生成编号圆点，把它们拖到目标位置。程序会按 1 → 2 → 3 循环，每个点都能设置点击间隔。运行中按 Esc 可紧急停止。"),
        buttons: [
            {
                title: tr("辅助功能设置"),
                handler: function () {
                    self.openAccessibilitySettings();
                    return null;
                }
            },
            { title: tr("开始使用"), isDefault: true, cancel: true }
        ]
    });
};

// ---------------------------------------------------------------------------
// 点位列表
// ---------------------------------------------------------------------------

AutoClicker.prototype.rebuildPointList = function () {
    var rowHeight = POINT_ROW_HEIGHT;
    var documentHeight = Math.max(208, this.markers.length * rowHeight + 4);
    var documentView = $.AutoClickerFlippedView.alloc.initWithFrame(
        $.NSMakeRect(0, 0, 260, documentHeight)
    );
    this.intervalFields = [];

    if (this.markers.length === 0) {
        var emptyLabel = this.makeLabel(
            tr("点击“放置”放置点位"),
            $.NSMakeRect(15, 70, 230, 48),
            12, false, $.NSColor.secondaryLabelColor
        );
        emptyLabel.alignment = $.NSTextAlignmentCenter;
        emptyLabel.lineBreakMode = $.NSLineBreakByWordWrapping;
        documentView.addSubview(emptyLabel);
    }

    for (var i = 0; i < this.markers.length; i += 1) {
        var marker = this.markers[i];
        var y = 4 + i * rowHeight;

        // 选中的行：淡金色圆角背景（放在最底层）
        if (marker.id === this.selectedMarkerID) {
            var gold = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1.0, 0.78, 0.12, 1.0);
            var highlight = $.NSBox.alloc.initWithFrame($.NSMakeRect(2, y, 256, rowHeight - 2));
            highlight.boxType = $.NSBoxCustom;
            highlight.titlePosition = $.NSNoTitle;
            highlight.borderWidth = 1;
            highlight.cornerRadius = 6;
            highlight.borderColor = gold;
            highlight.fillColor = gold.colorWithAlphaComponent(0.25);
            documentView.addSubview(highlight);
        }

        var numberLabel = this.makeLabel(
            String(i + 1), $.NSMakeRect(6, y + 6, 24, 24), 14, true, $.NSColor.systemBlueColor
        );
        numberLabel.alignment = $.NSTextAlignmentCenter;
        documentView.addSubview(numberLabel);

        var positionLabel = this.makeLabel(
            Math.round(marker.x) + ", " + Math.round(marker.y),
            $.NSMakeRect(34, y + 7, 91, 22),
            10, false, $.NSColor.secondaryLabelColor
        );
        positionLabel.font = $.NSFont.monospacedSystemFontOfSizeWeight(10, $.NSFontWeightRegular);
        documentView.addSubview(positionLabel);

        // 盖在编号和坐标上面的透明按钮：点这一行的左半边即可选中该点。
        var selectButton = $.NSButton.alloc.initWithFrame($.NSMakeRect(2, y, 122, rowHeight - 2));
        selectButton.title = "";
        selectButton.bordered = false;
        selectButton.transparent = true;
        selectButton.tag = marker.id;
        selectButton.target = this.actionTarget;
        selectButton.action = $.NSSelectorFromString("selectPoint:");
        selectButton.toolTip = tr("选中第 ") + (i + 1) + tr(" 个点（圆点会闪烁）");
        selectButton.enabled = !this.isClicking && !this.countdownTimer;
        documentView.addSubview(selectButton);
        this.intervalFields.push({ id: marker.id, field: selectButton });

        var intervalButton = this.makeButton(
            marker.delayMs + " ms…", $.NSMakeRect(126, y + 3, 98, 28), "editInterval:"
        );
        intervalButton.tag = marker.id;
        intervalButton.enabled = !this.isClicking && !this.countdownTimer;
        documentView.addSubview(intervalButton);
        this.intervalFields.push({ id: marker.id, field: intervalButton });

        var deleteButton = this.makeButton(
            "×", $.NSMakeRect(229, y + 3, 27, 28), "deletePoint:"
        );
        deleteButton.tag = marker.id;
        deleteButton.enabled = !this.isClicking && !this.countdownTimer;
        documentView.addSubview(deleteButton);
    }

    this.replaceListDocument(this.pointsScrollView, documentView);
};

AutoClicker.prototype.updateUI = function () {
    if (!this.statusItem || !this.toolbar) return;

    var statusText = tr("● 已停止 · ") + this.markers.length + tr(" 个点位");
    var statusColor = $.NSColor.secondaryLabelColor;
    var symbol = "cursorarrow.click.2";

    if (this.isClicking) {
        statusText = tr("● 正在循环") +
            (this.runDeadline ? tr(" · 剩余 ") + formatClock((this.runDeadline - Date.now()) / 1000) : "") +
            tr("（按 Esc 停止）") + (this.dryRun ? tr(" · 演练模式") : "");
        statusColor = $.NSColor.systemGreenColor;
        symbol = "stop.circle.fill";
    } else if (this.countdownTimer) {
        statusText = "● " + this.countdownValue + tr(" 秒后开始（按 Esc 取消）");
        statusColor = $.NSColor.systemOrangeColor;
        symbol = "timer";
    } else if (this.deleteMode) {
        statusText = tr("● 删除：点击红色圆点");
        statusColor = $.NSColor.systemRedColor;
        symbol = "trash.circle";
    } else if (this.statusNote) {
        statusText = "● " + this.statusNote;
    }

    this.statusLabel.stringValue = statusText;
    this.statusLabel.textColor = statusColor;
    this.toolbar.title = tr("AutoClicker 工具栏 · ") + this.markers.length + tr(" 点");

    var editingAllowed = !this.isClicking && !this.countdownTimer;
    this.addButton.enabled = editingAllowed;
    this.deleteModeButton.enabled = editingAllowed;
    this.deleteModeButton.title = this.deleteMode ? tr("退出删除") : tr("删除");
    this.deleteAllButton.enabled = editingAllowed && this.markers.length > 0;
    this.modeButton.enabled = editingAllowed;
    this.switchModeMenuItem.enabled = editingAllowed;
    this.layoutPopup.enabled = editingAllowed;
    this.adjustIntervalsButton.enabled = editingAllowed && this.markers.length > 0;
    this.layoutMenuItem.enabled = editingAllowed && this.mode === "click";
    this.shortcutButton.enabled = editingAllowed;
    this.shortcutButton.title = tr("开始/停止快捷键：") + this.shortcut.display + "…";
    this.durationButton.enabled = editingAllowed;
    this.durationButton.title = tr("持续时间：") + formatDuration(this.durationSeconds) + "…";
    this.jitterButton.enabled = editingAllowed;
    this.markerSizeButton.enabled = editingAllowed;
    this.markerSizeButton.title = tr("圆点大小：") + this.markerSize + " px…";
    this.jitterButton.title = tr("随机扰动：") +
        (this.jitterMs || this.jitterPx ? "±" + this.jitterMs + " ms / ±" + this.jitterPx + " px" : tr("关")) + "…";

    this.startButton.title = this.isClicking
        ? tr("■ 停止循环")
        : (this.countdownTimer ? tr("取消开始") : tr("▶ 开始循环（3 秒后）"));
    this.startButton.enabled =
        this.isClicking || this.countdownTimer || this.markers.length > 0;

    this.permissionButton.title = this.trusted
        ? tr("辅助功能：已授权（重新检查）")
        : tr("辅助功能：未生效（检查 / 修复）");

    var emergency = tr("紧急停止：按 Esc");
    if (this.keyStateBroken) emergency += tr(" · 按键轮询失效");
    emergency += tr(" · 看门狗") + (this.watchdogStatus === tr("运行中") ? "✓" : "✗ " + this.watchdogStatus);
    this.emergencyLabel.stringValue = emergency;

    for (var i = 0; i < this.intervalFields.length; i += 1) {
        this.intervalFields[i].field.enabled = editingAllowed;
    }

    var image = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription(symbol, tr("AutoClicker"));
    if (!isNil(image)) {
        image.template = true;
        this.statusItem.button.image = image;
        this.statusItem.button.title = "";
    } else {
        this.statusItem.button.title = this.isClicking ? "■" : "🖱";
    }

    this.statusMenuItem.title = this.isClicking
        ? tr("状态：正在循环（按 Esc 停止）")
        : (this.countdownTimer ? tr("状态：") + this.countdownValue + tr(" 秒后开始") : tr("状态：已停止"));
    this.menuToggleItem.title = this.isClicking
        ? tr("停止循环")
        : (this.countdownTimer ? tr("取消开始") : tr("开始循环（3 秒后）"));
    this.menuToggleItem.enabled =
        this.isClicking || this.countdownTimer || (this.mode === "click" && this.markers.length > 0) ||
        this.mode === "script";
    this.pointCountMenuItem.title = tr("点击点：") + this.markers.length + tr(" 个");
    this.permissionMenuItem.title = this.trusted ? tr("辅助功能：已授权") : tr("辅助功能：尚未授权…");

    if (this.mode === "script") this.updateScriptUI();
    this.updateMarkerAppearance();
    this.updateMiniBar();
};

// ---------------------------------------------------------------------------
// 键盘：全局监听（其他应用在前台时）+ 菜单 key equivalent（本应用在前台时）+ 轮询
// ---------------------------------------------------------------------------

AutoClicker.prototype.installGlobalMonitor = function () {
    var self = this;
    try {
        this.globalMonitor = $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler(
            $.NSEventMaskKeyDown,
            function (event) {
                try {
                    self.handleGlobalKeyEvent(event);
                } catch (error) {
                    log("全局键盘监听处理出错：" + error);
                }
            }
        );
        log("全局键盘监听已安装：" + (isNil(this.globalMonitor) ? "返回 nil" : "对象有效") +
            "（需要辅助功能权限才会收到其他应用的按键）");
    } catch (error) {
        this.globalMonitor = null;
        log("全局键盘监听安装失败：" + error);
    }
};

AutoClicker.prototype.handleGlobalKeyEvent = function (event) {
    if (jsBoolean(event.isARepeat)) return;
    var keyCode = jsNumber(event.keyCode);
    if (keyCode === ESCAPE_KEY_CODE) {
        this.escapeDetected(tr("全局键盘监听"));
        return;
    }
    var modifiers = jsNumber(event.modifierFlags) & MODIFIER_MASK;
    if (keyCode === this.shortcut.keyCode && modifiers === this.shortcut.modifiers) {
        this.hotkeyDetected(tr("全局键盘监听"));
    }
};

AutoClicker.prototype.hotkeyDetected = function (source) {
    var now = Date.now();
    if (now - this.lastHotkeyTime < 250) return;
    this.lastHotkeyTime = now;
    log("快捷键触发（" + source + "），当前状态 " + this.currentStateName());
    // 开始/停止快捷键只在点击模式下启动连点；正在运行时任何情况下都能用它停止。
    if (this.mode !== "click" && this.mode !== "script" && this.currentStateName() === "idle") {
        log("还没选模式，忽略快捷键");
        return;
    }
    this.toggleFromHotkey();
};

AutoClicker.prototype.escapeDetected = function (source) {
    var state = this.currentStateName();
    log("Esc 检测（" + source + "），当前状态 " + state);
    if (state === "idle") return;
    this.emergencyStop();
};

AutoClicker.prototype.panelEscapePressed = function (panel) {
    var dialog = this.activeDialog;
    if (dialog && jsBoolean(panel.isEqual(dialog.panel))) {
        var buttons = dialog.spec.buttons || [];
        for (var i = 0; i < buttons.length; i += 1) {
            if (buttons[i].cancel) {
                this.dialogButtonPressed(i);
                return;
            }
        }
        this.closeDialog();
        return;
    }
    this.escapeDetected(tr("工具栏面板 Esc"));
};

AutoClicker.prototype.toggleFromToolbar = function () {
    if (this.isClicking) {
        this.stopSequence(tr("已手动停止"));
    } else if (this.countdownTimer) {
        this.cancelCountdown(tr("已取消开始"));
    } else {
        this.beginCountdown();
    }
};

AutoClicker.prototype.toggleFromHotkey = function () {
    if (this.isClicking) {
        this.stopSequence(tr("已用快捷键停止"));
    } else if (this.countdownTimer) {
        this.cancelCountdown(tr("已用快捷键取消"));
    } else {
        this.startSequenceImmediately();
    }
};

AutoClicker.prototype.emergencyStop = function () {
    if (this.isClicking) {
        this.stopSequence(tr("已按 Esc 紧急停止"));
    } else if (this.countdownTimer) {
        this.cancelCountdown(tr("已按 Esc 取消开始"));
    }
};

AutoClicker.prototype.escapeIsDown = function () {
    try {
        return jsBoolean($.CGEventSourceKeyState(
            $.kCGEventSourceStateCombinedSessionState,
            ESCAPE_KEY_CODE
        ));
    } catch (error) {
        if (!this.keyStateBroken) {
            this.keyStateBroken = true;
            log("CGEventSourceKeyState 调用失败：" + error);
            this.statusNote = tr("Esc 按键轮询失效，已停止以策安全");
            this.updateUI();
        }
        throw error;
    }
};

AutoClicker.prototype.startEmergencyKeyPolling = function () {
    if (this.emergencyKeyTimer) return;
    this.escapeWasDown = false;
    var self = this;
    this.emergencyKeyTimer = scheduleRepeating(ESC_POLL_SECONDS, function (timer) {
        var isDown = false;
        try {
            isDown = self.escapeIsDown();
        } catch (error) {
            // 轮询失效不能静默当成“没按下”：停止运行并提示。
            if (self.isClicking) self.stopSequence(tr("Esc 轮询失效，已停止以策安全"));
            else if (self.countdownTimer) self.cancelCountdown(tr("Esc 轮询失效，已取消"));
            return;
        }
        if (isDown && !self.escapeWasDown) {
            self.escapeWasDown = true;
            self.escapeDetected(tr("按键状态轮询"));
            return;
        }
        self.escapeWasDown = isDown;
    });
};

AutoClicker.prototype.stopEmergencyKeyPolling = function () {
    if (this.emergencyKeyTimer) this.emergencyKeyTimer.invalidate;
    this.emergencyKeyTimer = null;
    this.escapeWasDown = false;
};

// ---------------------------------------------------------------------------
// 运行控制
// ---------------------------------------------------------------------------

AutoClicker.prototype.pointIsOnScreen = function (marker) {
    var appPoint = cgPointToAppKit(marker.x, marker.y);
    var screens = $.NSScreen.screens;
    for (var i = 0; i < jsNumber(screens.count); i += 1) {
        if (pointInsideRect(appPoint.x, appPoint.y, screens.objectAtIndex(i).frame)) return true;
    }
    return false;
};

AutoClicker.prototype.pointIsCoveredByToolbar = function (marker) {
    var frame = this.runCoverFrame(this.toolbar);
    if (!frame) return false;
    var appPoint = cgPointToAppKit(marker.x, marker.y);
    return pointInsideRect(appPoint.x, appPoint.y, frame);
};

AutoClicker.prototype.validateBeforeStart = function () {
    if (this.mode === "script") return this.validateScriptBeforeStart();
    if (this.markers.length === 0) {
        this.showError(tr("还没有点击点"), tr("请先点击“放置”，并把编号圆点拖到目标位置。"));
        return false;
    }

    for (var i = 0; i < this.markers.length; i += 1) {
        var marker = this.markers[i];
        if (!this.pointIsOnScreen(marker)) {
            this.showError(
                tr("第 ") + (i + 1) + tr(" 个点不在当前屏幕内"),
                tr("显示器排列可能发生了变化，请重新放置这个点击点。")
            );
            return false;
        }
        if (this.pointIsCoveredByToolbar(marker)) {
            this.showError(
                tr("第 ") + (i + 1) + tr(" 个点被") + (this.autoMinimize || this.minimized ? tr("最小化小条") : tr("工具栏")) + tr("挡住了"),
                tr("请先移动") + (this.autoMinimize || this.minimized ? tr("小条（最小化后拖动它）") : tr("工具栏")) + tr("或拖动点击点，再开始循环。")
            );
            return false;
        }
    }

    // 演练模式不发送真实点击，不需要辅助功能权限，便于在授权前验证停止逻辑。
    this.dryRun = jsBoolean(this.defaults.boolForKey("dryRun"));
    if (!this.dryRun && !this.ensurePermission()) return false;
    return true;
};

AutoClicker.prototype.beginCountdown = function () {
    if (!this.validateBeforeStart()) return;

    this.closeDialog();
    this.stopFlash();
    this.deleteMode = false;
    this.autoMinimizeOnStart();
    this.countdownValue = 3;
    this.runGeneration += 1;
    var generation = this.runGeneration;
    var self = this;
    log("倒计时开始（第 " + generation + " 轮）");

    this.countdownTimer = scheduleRepeating(1.0, function (timer) {
        if (generation !== self.runGeneration) {
            timer.invalidate;
            return;
        }
        self.countdownValue -= 1;
        if (self.countdownValue <= 0) {
            timer.invalidate;
            self.countdownTimer = null;
            self.startSequenceNow(generation);
        } else {
            self.updateUI();
        }
    });
    this.startEmergencyKeyPolling();
    this.writeState();
    this.updateUI();
};

AutoClicker.prototype.cancelCountdown = function (message) {
    var generation = this.runGeneration;
    this.runGeneration += 1;
    if (this.countdownTimer) this.countdownTimer.invalidate;
    this.countdownTimer = null;
    this.countdownValue = 0;
    this.stopEmergencyKeyPolling();
    this.statusNote = message || tr("已取消开始");
    log("倒计时取消（第 " + generation + " 轮）：" + this.statusNote);
    this.writeState();
    this.autoRestoreAfterStop();
    this.updateUI();
};

AutoClicker.prototype.startSequenceImmediately = function () {
    if (!this.validateBeforeStart()) return;
    this.closeDialog();
    this.stopFlash();
    this.deleteMode = false;
    this.autoMinimizeOnStart();
    this.runGeneration += 1;
    log("快捷键立即开始（第 " + this.runGeneration + " 轮）");
    this.startSequenceNow(this.runGeneration);
};

AutoClicker.prototype.startSequenceNow = function (generation) {
    if (generation !== this.runGeneration) return;
    var scriptRun = this.mode === "script";
    this.dryRun = jsBoolean(this.defaults.boolForKey("dryRun")) || (scriptRun && this.scriptDryRun);
    if (!this.trusted && !this.dryRun) return;
    if (!scriptRun && this.markers.length === 0) return;

    this.isClicking = true;
    this.currentIndex = 0;
    this.clickCount = 0;
    this.statusNote = "";
    this.runDeadline = 0;
    var self = this;
    if (this.durationSeconds > 0) {
        this.runDeadline = Date.now() + this.durationSeconds * 1000;
        this.durationTimer = scheduleOnce(this.durationSeconds, function (timer) {
            if (!self.isClicking || generation !== self.runGeneration) return;
            log("持续时间到（" + formatDuration(self.durationSeconds) + "），自动停止");
            self.stopSequence(tr("已运行 ") + formatDuration(self.durationSeconds) + tr("，按设定停止"));
        });
    }
    this.startEmergencyKeyPolling();
    this.writeState();
    this.updateUI();
    log("开始运行（第 " + generation + " 轮）" + (this.dryRun ? "【演练模式，不发送真实点击】" : "") +
        (this.durationSeconds ? "，持续 " + formatDuration(this.durationSeconds) : "") +
        (this.jitterMs || this.jitterPx ? "，扰动 ±" + this.jitterMs + " ms / ±" + this.jitterPx + " px" : ""));

    // 仅用于测试看门狗：模拟主线程卡死 N 秒（defaults write com.charlie.autoclicker debugSimulateHangSeconds -int N）。
    var hangSeconds = jsNumber(this.defaults.integerForKey("debugSimulateHangSeconds"));
    if (hangSeconds > 0) {
        log("debugSimulateHangSeconds=" + hangSeconds + "，开始模拟主线程卡死");
        var until = Date.now() + hangSeconds * 1000;
        while (Date.now() < until) {}
        log("模拟卡死结束");
    }

    if (scriptRun) this.startScriptEngine(generation);
    else this.performSequenceStep(generation);
};

AutoClicker.prototype.performSequenceStep = function (generation) {
    if (!this.isClicking || generation !== this.runGeneration) return;
    if (this.markers.length === 0) {
        this.stopSequence(tr("点击点已为空"));
        return;
    }

    // 每次发送点击前先同步检查 Esc 是否已经按下，避免"预先按住 Esc 仍然发出第一下"。
    var escDown = false;
    try {
        escDown = this.escapeIsDown();
    } catch (error) {
        this.stopSequence(tr("Esc 轮询失效，已停止以策安全"));
        return;
    }
    if (escDown) {
        log("发送点击前检测到 Esc 已按下，跳过并停止");
        this.stopSequence(tr("检测到 Esc 已按下，未发送点击"));
        return;
    }

    this.sequenceTimer = null;
    var marker = this.markers[this.currentIndex];
    var clickX = marker.x, clickY = marker.y;
    if (this.jitterPx > 0) {
        clickX += Math.round((Math.random() * 2 - 1) * this.jitterPx);
        clickY += Math.round((Math.random() * 2 - 1) * this.jitterPx);
    }
    this.postLeftClick(clickX, clickY, this.currentIndex + 1);
    var delay = marker.delayMs;
    if (this.jitterMs > 0) {
        delay = clamp(Math.round(delay + (Math.random() * 2 - 1) * this.jitterMs), MIN_INTERVAL, MAX_INTERVAL);
    }
    this.currentIndex = (this.currentIndex + 1) % this.markers.length;

    var self = this;
    this.sequenceTimer = scheduleOnce(delay / 1000.0, function (timer) {
        if (!self.isClicking || generation !== self.runGeneration) return;
        self.performSequenceStep(generation);
    });
};

AutoClicker.prototype.stopSequence = function (message) {
    var wasRunning = this.isClicking;
    var generation = this.runGeneration;
    this.isClicking = false;
    this.runGeneration += 1;
    if (this.sequenceTimer) this.sequenceTimer.invalidate;
    this.sequenceTimer = null;
    if (this.durationTimer) this.durationTimer.invalidate;
    this.durationTimer = null;
    this.runDeadline = 0;
    this.stopEmergencyKeyPolling();
    this.stopScriptEngine();
    this.currentIndex = 0;
    this.statusNote = message || tr("已停止");
    this.writeState();
    if (wasRunning) {
        log("停止运行（第 " + generation + " 轮）：" + this.statusNote +
            "，本轮共发送 " + this.clickCount + " 次点击" + (this.dryRun ? "（演练）" : ""));
    }
    this.showMarkerWindows();
    this.autoRestoreAfterStop();
    this.updateUI();
};

AutoClicker.prototype.postLeftClick = function (x, y, pointNumber) {
    this.clickCount += 1;
    var shouldLog = this.clickCount <= 5 || this.clickCount % 100 === 0 ||
        (this.dryRun && this.clickCount <= 40);
    if (this.dryRun) {
        if (shouldLog) {
            log("演练点击 #" + this.clickCount + " 点 " + pointNumber +
                " (" + Math.round(x) + ", " + Math.round(y) + ")");
        }
        return;
    }

    var point = $.CGPointMake(Number(x), Number(y));
    var down = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
    var up = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);

    if (down && up) {
        // 清空修饰键标志：用 ⌃⌥C 启动时用户手指还按着修饰键，否则第一下会变成 Ctrl-点击（右键菜单）。
        $.CGEventSetFlags(down, 0);
        $.CGEventSetFlags(up, 0);
        $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, 1);
        $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, 1);
        $.CGEventPost($.kCGHIDEventTap, down);
        $.CGEventPost($.kCGHIDEventTap, up);
        if (shouldLog) {
            log("点击 #" + this.clickCount + " 点 " + pointNumber +
                " (" + Math.round(x) + ", " + Math.round(y) + ")");
        }
    } else {
        log("创建鼠标事件失败（点 " + pointNumber + "）");
    }
};

// ---------------------------------------------------------------------------
// 辅助功能权限
// ---------------------------------------------------------------------------

AutoClicker.prototype.ensurePermission = function () {
    this.trusted = jsBoolean($.AXIsProcessTrusted());
    this.updateUI();
    if (this.trusted) return true;
    log("开始前检查：辅助功能未授权");
    this.showPermissionDialog(false);
    return false;
};

AutoClicker.prototype.pollPermission = function () {
    var wasTrusted = this.trusted;
    this.trusted = jsBoolean($.AXIsProcessTrusted());
    if (wasTrusted !== this.trusted) {
        log("辅助功能权限变化：" + wasTrusted + " → " + this.trusted);
    }
    if (wasTrusted && !this.trusted) {
        if (this.countdownTimer) this.cancelCountdown(tr("权限已被关闭"));
        if (this.isClicking) this.stopSequence(tr("权限已被关闭，已停止"));
    }
    if (!wasTrusted && this.trusted && this.activeDialog &&
        this.activeDialog.key === "permission") {
        this.closeDialog();
        this.statusNote = tr("辅助功能已授权");
    }
    if (wasTrusted !== this.trusted) this.updateUI();
};

AutoClicker.prototype.openAccessibilitySettings = function () {
    var modern = $.NSURL.URLWithString(
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"
    );
    var opened = jsBoolean($.NSWorkspace.sharedWorkspace.openURL(modern));
    if (!opened) {
        var legacy = $.NSURL.URLWithString(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
        $.NSWorkspace.sharedWorkspace.openURL(legacy);
    }
    log("打开系统设置（辅助功能）");
};

// ---------------------------------------------------------------------------
// 退出
// ---------------------------------------------------------------------------

AutoClicker.prototype.cleanup = function () {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.runGeneration += 1;
    this.isClicking = false;
    if (this.sequenceTimer) this.sequenceTimer.invalidate;
    if (this.durationTimer) this.durationTimer.invalidate;
    if (this.countdownTimer) this.countdownTimer.invalidate;
    if (this.permissionTimer) this.permissionTimer.invalidate;
    if (this.emergencyKeyTimer) this.emergencyKeyTimer.invalidate;
    if (this.heartbeatTimer) this.heartbeatTimer.invalidate;
    if (this.flashTimer) this.flashTimer.invalidate;
    this.flashTimer = null;
    if (this.haloPanel) this.haloPanel.orderOut(null);
    if (this.modeWindow) this.modeWindow.orderOut(null);
    this.stopScriptEngine();
    this.stopEye();
    this.stopScriptEditTimer();
    this.stopRemote(false);
    if (this.miniBar) this.miniBar.orderOut(null);
    if (this.remotePanel) this.remotePanel.orderOut(null);
    if (this.overlay) this.overlay.panel.orderOut(null);
    if (this.scriptToolbar) this.scriptToolbar.orderOut(null);
    for (var s = 0; s < this.scriptPoints.length; s += 1) {
        if (this.scriptPoints[s].panel) this.scriptPoints[s].panel.orderOut(null);
    }

    if (this.globalMonitor && !isNil(this.globalMonitor)) {
        $.NSEvent.removeMonitor(this.globalMonitor);
    }
    this.globalMonitor = null;

    this.closeDialog();
    for (var i = 0; i < this.markers.length; i += 1) {
        if (this.markers[i].panel) this.markers[i].panel.orderOut(null);
    }
    if (this.toolbar) this.toolbar.orderOut(null);

    if (this.watchdogTask && jsBoolean(this.watchdogTask.running)) {
        this.watchdogTask.terminate;
    }
    this.watchdogTask = null;
    writeTextFile(STATE_PATH, JSON.stringify({ state: "quit", ts: Date.now() }));
    log("==== 退出");
};

function run(argv) {
    if (!appController) {
        setupPaths();
        appController = new AutoClicker();
        appController.start();
        appController.restoreModeAfterRelaunch();
    }
}

function idle() {
    return 2;
}

function quit() {
    if (appController) appController.cleanup();
}
