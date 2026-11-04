// AutoClicker · 最小化小条 + 手机遥控
//
// 构建时拼接在 AutoClicker.js、ScriptMode.js 后面（见 build-app.sh），共用同一个 AutoClicker 原型。
// 按钮命令沿用脚本模式的 scriptCommand:（命令写在 identifier 里），由 handleExtraCommand 处理。
//
// 手机遥控：主程序用 NSTask 启动 remote.py（Python 自带库写的小网页服务），
// 和"眼睛"一样用文件通信：主程序每 0.5 秒写 remote-status.json，手机按的按钮由 remote.py 写进 remote-command.json。

ObjC.import("CoreImage");   // 二维码（CIQRCodeGenerator）

var MINI_BAR_WIDTH = 330;
var MINI_BAR_HEIGHT = 44;
var REMOTE_PORT = 8765;
var REMOTE_TICK_SECONDS = 0.5;
var REMOTE_COMMAND_MAX_AGE_MS = 10000;   // 太旧的手机命令不执行
var REMOTE_RESTART_GAP_MS = 3000;
var REMOTE_PANEL_WIDTH = 380;
var REMOTE_PANEL_HEIGHT = 540;

var REMOTE_STATUS_PATH = "";
var REMOTE_COMMAND_PATH = "";
var REMOTE_INFO_PATH = "";
var REMOTE_STDERR_PATH = "";

// 小条和遥控面板上的按钮：应用在后台时第一下点击也要生效（不用先点一下激活窗口）
ObjC.registerSubclass({
    name: "AutoClickerFirstMouseButton",
    superclass: "NSButton",
    methods: {
        "acceptsFirstMouse:": {
            types: ["bool", ["id"]],
            implementation: function (event) { return true; }
        }
    }
});

function randomRemoteKey() {
    return jsString($.NSUUID.UUID.UUIDString).replace(/-/g, "").slice(0, 12).toLowerCase();
}

AutoClicker.prototype.initExtras = function () {
    REMOTE_STATUS_PATH = SUPPORT_DIR + "/remote-status.json";
    REMOTE_COMMAND_PATH = SUPPORT_DIR + "/remote-command.json";
    REMOTE_INFO_PATH = SUPPORT_DIR + "/remote-info.json";
    REMOTE_STDERR_PATH = SUPPORT_DIR + "/remote-stderr.log";

    this.minimized = false;
    this.minimizedByAuto = false;
    this.miniBar = null;
    this.autoMinimizeBoxes = [];
    // 没设置过时默认勾上
    this.autoMinimize = isNil(this.defaults.objectForKey("autoMinimize")) ? true : jsBoolean(this.defaults.boolForKey("autoMinimize"));

    this.remoteKey = jsString(this.defaults.stringForKey("remoteKey"));
    if (!/^[0-9a-z]{8,}$/.test(this.remoteKey)) {
        this.remoteKey = randomRemoteKey();
        this.defaults.setObjectForKey(this.remoteKey, "remoteKey");
        this.defaults.synchronize;
    }
    this.remoteTask = null;
    this.remoteTimer = null;
    this.remoteInfo = null;
    this.remoteError = "";
    this.remoteLastStart = 0;
    this.remoteRestarts = 0;
    this.remoteLastCommandID = null;
    this.remotePanel = null;
    this.remoteImageStates = {};
    this.lastErrorText = "";
    this.lastErrorTime = 0;

    // 上次关应用时遥控是开着的：启动后自动打开（稍等一下，等界面建好）
    if (jsBoolean(this.defaults.boolForKey("remoteEnabled"))) {
        var self = this;
        scheduleOnce(1.5, function () { self.startRemote(); });
    }
};

// 工具栏 / 小条 / 遥控面板 / 菜单栏里的命令；返回 true 表示已处理
AutoClicker.prototype.handleExtraCommand = function (name, sender) {
    switch (name) {
    case "lang.toggle": this.toggleLanguage(); return true;
    case "mini.minimize": this.minimizeToolbar(false); return true;
    case "mini.restore": this.restoreToolbar(true); return true;
    case "mini.toggle":
        if (this.mode !== "click" && this.mode !== "script") return true;
        this.toggleFromToolbar();
        return true;
    case "autoMin":
        this.autoMinimize = jsNumber(sender.state) === 1;
        this.defaults.setBoolForKey(this.autoMinimize, "autoMinimize");
        this.defaults.synchronize;
        this.statusNote = this.autoMinimize ? tr("开始后会自动最小化，停止后自动展开") : tr("开始后不自动最小化");
        log(this.statusNote);
        this.updateUI();
        return true;
    case "remote.panel": this.showRemotePanel(); return true;
    case "remote.toggle":
        if (this.remoteTask) this.stopRemote(true); else this.startRemote();
        this.updateRemotePanel();
        return true;
    case "remote.newKey": this.changeRemoteKey(); return true;
    case "remote.copy": this.copyRemoteURL(); return true;
    }
    return false;
};

// "开始后自动最小化"勾选框（两个工具栏各一个，保持同步）
AutoClicker.prototype.makeAutoMinimizeBox = function (frame) {
    var box = $.NSButton.alloc.initWithFrame(frame);
    box.setButtonType($.NSButtonTypeSwitch);
    box.title = tr("开始后自动最小化（停止后自动展开）");
    box.state = this.autoMinimize ? 1 : 0;
    box.identifier = "autoMin";
    box.target = this.scriptTarget;
    box.action = $.NSSelectorFromString("scriptCommand:");
    this.autoMinimizeBoxes.push(box);
    return box;
};

// 工具栏顶部的小按钮（走 scriptCommand:）
// 按钮上显示的是要切换到的语言，用那种语言自己的写法，这样看不懂当前语言的人也认得出来
AutoClicker.prototype.otherLanguageName = function () {
    return currentLanguage() === "zh" ? "English" : "中文";
};

// 界面文字在创建窗口时就定下了，所以切换语言靠重启应用；重启后回到原来的模式。所有设置都是改动时就保存的，不会丢。
AutoClicker.prototype.toggleLanguage = function () {
    if (this.isClicking || this.countdownTimer) {
        this.statusNote = tr("运行中不能切换语言，请先停止");
        this.updateUI();
        return;
    }
    var next = currentLanguage() === "zh" ? "en" : "zh";
    log("切换语言：" + next);
    this.defaults.setObjectForKey(next, "language");
    if (this.mode) this.defaults.setObjectForKey(this.mode, "relaunchMode");
    this.defaults.synchronize;
    var task = $.NSTask.alloc.init;
    task.launchPath = "/bin/sh";
    task.arguments = $(["-c", "sleep 0.8; /usr/bin/open \"$0\"", jsString($.NSBundle.mainBundle.bundlePath)]);
    task.launch;
    this.cleanup();
    $.NSApplication.sharedApplication.terminate($());
};

AutoClicker.prototype.restoreModeAfterRelaunch = function () {
    var mode = jsString(this.defaults.stringForKey("relaunchMode"));
    if (!mode) return;
    this.defaults.removeObjectForKey("relaunchMode");
    if (mode === "click" || mode === "script") this.chooseMode(mode);
};

AutoClicker.prototype.extraButton = function (title, frame, command, tip) {
    var button = $.NSButton.alloc.initWithFrame(frame);
    button.title = title;
    button.bezelStyle = $.NSBezelStyleRounded;
    button.identifier = command;
    button.target = this.scriptTarget;
    button.action = $.NSSelectorFromString("scriptCommand:");
    if (tip) button.toolTip = tip;
    return button;
};

// ---------------------------------------------------------------------------
// 最小化小条
// ---------------------------------------------------------------------------

AutoClicker.prototype.buildMiniBar = function () {
    var W = MINI_BAR_WIDTH, H = MINI_BAR_HEIGHT;
    var visible = primaryScreenFrame();
    var x = Number(this.defaults.doubleForKey("miniBarX"));
    var y = Number(this.defaults.doubleForKey("miniBarY"));
    if (!x && !y) {
        x = Number(visible.origin.x) + Number(visible.size.width) - W - 24;
        y = Number(visible.origin.y) + Number(visible.size.height) - H - 12;
    }
    var panel = $.AutoClickerPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(x, y, W, H), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false
    );
    panel.releasedWhenClosed = false;
    panel.floatingPanel = true;
    panel.hidesOnDeactivate = false;
    panel.level = $.NSFloatingWindowLevel;
    panel.opaque = false;
    panel.backgroundColor = $.NSColor.clearColor;
    panel.hasShadow = true;
    panel.movableByWindowBackground = true;   // 按住空白处就能拖动
    panel.collectionBehavior =
        $.NSWindowCollectionBehaviorCanJoinAllSpaces |
        $.NSWindowCollectionBehaviorFullScreenAuxiliary;

    var content = $.AutoClickerFlippedView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    panel.contentView = content;
    var back = $.NSBox.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    back.boxType = $.NSBoxCustom;
    back.titlePosition = $.NSNoTitle;
    back.borderWidth = 1;
    back.cornerRadius = 10;
    back.borderColor = $.NSColor.separatorColor;
    back.fillColor = $.NSColor.windowBackgroundColor;
    content.addSubview(back);

    this.miniDot = this.makeLabel("●", $.NSMakeRect(10, 12, 16, 20), 14, true, $.NSColor.secondaryLabelColor);
    content.addSubview(this.miniDot);
    this.miniLabel = this.makeLabel("", $.NSMakeRect(26, 13, W - 26 - 104, 18), 12, true, $.NSColor.labelColor);
    this.miniLabel.lineBreakMode = $.NSLineBreakByTruncatingTail;
    content.addSubview(this.miniLabel);

    this.miniToggleButton = $.AutoClickerFirstMouseButton.alloc.initWithFrame($.NSMakeRect(W - 100, 8, 54, 28));
    this.miniToggleButton.bezelStyle = $.NSBezelStyleRounded;
    this.miniToggleButton.identifier = "mini.toggle";
    this.miniToggleButton.target = this.scriptTarget;
    this.miniToggleButton.action = $.NSSelectorFromString("scriptCommand:");
    content.addSubview(this.miniToggleButton);

    var expand = $.AutoClickerFirstMouseButton.alloc.initWithFrame($.NSMakeRect(W - 44, 8, 36, 28));
    expand.bezelStyle = $.NSBezelStyleRounded;
    expand.title = "⤢";
    expand.identifier = "mini.restore";
    expand.target = this.scriptTarget;
    expand.action = $.NSSelectorFromString("scriptCommand:");
    content.addSubview(expand);

    this.miniBar = panel;
};

AutoClicker.prototype.miniBarFrame = function () {
    if (!this.miniBar) this.buildMiniBar();
    return this.miniBar.frame;
};

// 运行时会一直显示在屏幕上的那个窗口：会自动最小化（或已经最小化）就是小条，否则是工具栏
AutoClicker.prototype.runCoverFrame = function (toolbar) {
    if (this.autoMinimize || this.minimized) return this.miniBarFrame();
    return jsBoolean(toolbar.visible) ? toolbar.frame : null;
};

AutoClicker.prototype.minimizeToolbar = function (auto) {
    if (this.mode !== "click" && this.mode !== "script") return;
    if (!this.miniBar) this.buildMiniBar();
    this.closeDialog();
    this.stopFlash();
    this.minimized = true;
    this.minimizedByAuto = Boolean(auto);
    this.currentToolbar().orderOut($());
    this.miniBar.orderFrontRegardless;
    log("工具栏最小化" + (auto ? "（开始后自动）" : ""));
    this.updateMiniBar();
};

// activate：手动展开时把 AutoClicker 切到前台；停止后自动展开时不抢前台窗口的焦点
AutoClicker.prototype.restoreToolbar = function (activate) {
    if (!this.minimized) return;
    this.minimized = false;
    this.minimizedByAuto = false;
    this.hideMiniBar();
    if (this.mode !== "click" && this.mode !== "script") return;
    if (activate) {
        $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
        this.currentToolbar().makeKeyAndOrderFront($());
    } else {
        this.currentToolbar().orderFrontRegardless;
    }
    log("工具栏展开");
    this.updateUI();
};

AutoClicker.prototype.hideMiniBar = function () {
    if (!this.miniBar) return;
    var frame = this.miniBar.frame;
    this.defaults.setDoubleForKey(Number(frame.origin.x), "miniBarX");
    this.defaults.setDoubleForKey(Number(frame.origin.y), "miniBarY");
    this.defaults.synchronize;
    this.miniBar.orderOut($());
    this.minimized = false;
};

AutoClicker.prototype.autoMinimizeOnStart = function () {
    if (this.autoMinimize && !this.minimized) this.minimizeToolbar(true);
};

AutoClicker.prototype.autoRestoreAfterStop = function () {
    if (this.minimized && this.minimizedByAuto) this.restoreToolbar(false);
};

// 一行状态：小条和手机网页共用
AutoClicker.prototype.shortStatus = function () {
    if (this.isClicking) {
        var text = tr("运行中 · ") + this.clickCount + tr(" 次");
        if (this.runDeadline) text += tr(" · 剩余 ") + formatClock((this.runDeadline - Date.now()) / 1000);
        if (this.dryRun) text += tr(" · 演练");
        return { text: text, color: $.NSColor.systemGreenColor, state: "running" };
    }
    if (this.countdownTimer) {
        return { text: this.countdownValue + tr(" 秒后开始（Esc 取消）"), color: $.NSColor.systemOrangeColor, state: "countdown" };
    }
    return { text: tr("已停止") + (this.statusNote ? " · " + this.statusNote : ""), color: $.NSColor.secondaryLabelColor, state: "idle" };
};

AutoClicker.prototype.updateMiniBar = function () {
    for (var i = 0; i < this.autoMinimizeBoxes.length; i += 1) this.autoMinimizeBoxes[i].state = this.autoMinimize ? 1 : 0;
    if (!this.miniBar || !this.minimized) return;
    var status = this.shortStatus();
    var text = status.text;
    // 脚本模式运行时，显示正在做什么（例如"规则 2「开始」→ …"）
    if (this.mode === "script" && this.isClicking && this.activityLabel) {
        var activity = jsString(this.activityLabel.stringValue);
        if (activity) text = activity + " · " + this.clickCount + tr(" 次");
    }
    this.miniLabel.stringValue = text;
    this.miniLabel.toolTip = text;
    this.miniDot.textColor = status.color;
    this.miniToggleButton.title = this.isClicking || this.countdownTimer ? "■" : "▶";
    this.miniToggleButton.toolTip = this.isClicking || this.countdownTimer ? tr("停止") : tr("开始（3 秒后）");
};

// ---------------------------------------------------------------------------
// 手机遥控：网页服务进程
// ---------------------------------------------------------------------------

AutoClicker.prototype.remoteScriptPath = function () {
    return jsString($.NSBundle.mainBundle.resourcePath) + "/remote.py";
};

// 网页服务只用 Python 自带的库：优先用眼睛已经找到的 python3，没有就用系统自带的
AutoClicker.prototype.remotePython = function () {
    if (this.pythonPath) return this.pythonPath;
    var found = this.ensurePython();
    if (found.ok && this.pythonPath) return this.pythonPath;
    var fm = $.NSFileManager.defaultManager;
    var candidates = ["/Library/Frameworks/Python.framework/Versions/Current/bin/python3", "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3", "/usr/bin/python3"];
    for (var i = 0; i < candidates.length; i += 1) {
        if (fm.isExecutableFileAtPath(candidates[i])) return candidates[i];
    }
    return null;
};

AutoClicker.prototype.startRemote = function () {
    if (this.remoteTask && jsBoolean(this.remoteTask.running)) return;
    var python = this.remotePython();
    if (!python) {
        this.remoteError = tr("找不到 python3，无法打开手机遥控");
        log(this.remoteError);
        this.updateRemotePanel();
        return;
    }
    var fm = $.NSFileManager.defaultManager;
    fm.removeItemAtPathError(REMOTE_INFO_PATH, $());
    fm.removeItemAtPathError(REMOTE_COMMAND_PATH, $());
    if (!fm.fileExistsAtPath(REMOTE_STDERR_PATH)) fm.createFileAtPathContentsAttributes(REMOTE_STDERR_PATH, $(), $());
    this.writeRemoteStatus();
    try {
        var task = $.NSTask.alloc.init;
        task.launchPath = python;
        task.arguments = $([this.remoteScriptPath(), "serve", String(REMOTE_PORT), this.remoteKey,
            REMOTE_STATUS_PATH, REMOTE_COMMAND_PATH, REMOTE_INFO_PATH,
            String(jsNumber($.NSProcessInfo.processInfo.processIdentifier)), currentLanguage()]);
        var errorHandle = $.NSFileHandle.fileHandleForWritingAtPath(REMOTE_STDERR_PATH);
        if (!isNil(errorHandle)) {
            if (jsNumber(errorHandle.seekToEndOfFile) > 1024 * 1024) errorHandle.truncateFileAtOffset(0);
            task.standardError = errorHandle;
            task.standardOutput = errorHandle;
        }
        task.launch;
        this.remoteTask = task;
        this.remoteLastStart = Date.now();
        this.remoteInfo = null;
        this.remoteError = "";
        log("手机遥控已打开，网页服务 pid " + jsNumber(task.processIdentifier));
    } catch (error) {
        this.remoteTask = null;
        this.remoteError = tr("网页服务启动失败：") + error;
        log(this.remoteError);
    }
    this.defaults.setBoolForKey(true, "remoteEnabled");
    this.defaults.synchronize;
    var self = this;
    if (!this.remoteTimer) {
        this.remoteTimer = scheduleRepeating(REMOTE_TICK_SECONDS, function () {
            try { self.remoteTick(); } catch (error) { log("手机遥控出错：" + error); }
        });
    }
    this.updateRemotePanel();
};

// byUser：用户手动关掉时记住"关"，下次启动不再自动打开
AutoClicker.prototype.stopRemote = function (byUser) {
    if (this.remoteTimer) this.remoteTimer.invalidate;
    this.remoteTimer = null;
    if (this.remoteTask && jsBoolean(this.remoteTask.running)) this.remoteTask.terminate;
    this.remoteTask = null;
    this.remoteInfo = null;
    if (byUser) {
        this.defaults.setBoolForKey(false, "remoteEnabled");
        this.defaults.synchronize;
        log("手机遥控已关闭");
    }
};

AutoClicker.prototype.remoteTick = function () {
    this.writeRemoteStatus();
    if (!this.remoteInfo) {
        var infoText = readTextFile(REMOTE_INFO_PATH);
        if (infoText) {
            try {
                var info = JSON.parse(infoText);
                if (info.ok) {
                    this.remoteInfo = info;
                    log("手机遥控网址：" + this.remoteURL(false) + "（备用 " + this.remoteURL(true) + "）");
                } else {
                    this.remoteError = info.error || tr("网页服务启动失败");
                }
            } catch (error) { /* 文件还没写完，下次再读 */ }
            this.updateRemotePanel();
        }
    }
    this.readRemoteCommand();

    // 网页服务意外退出：隔 3 秒自动重启
    if (this.remoteTask && !jsBoolean(this.remoteTask.running) && Date.now() - this.remoteLastStart > REMOTE_RESTART_GAP_MS) {
        log("手机遥控网页服务已退出（退出码 " + jsNumber(this.remoteTask.terminationStatus) + "），自动重启");
        this.remoteRestarts += 1;
        this.remoteTask = null;
        if (this.remoteRestarts <= 5) this.startRemote();
        else {
            this.remoteError = tr("网页服务反复退出，已放弃。详情见 remote-stderr.log");
            this.stopRemote(false);
            this.updateRemotePanel();
        }
    }
};

AutoClicker.prototype.writeRemoteStatus = function () {
    var status = this.shortStatus();
    var modeName = this.mode === "script" ? tr("脚本模式") : (this.mode === "click" ? tr("点击模式") : tr("还没选模式（请在电脑上选）"));
    var payload = {
        ts: Date.now(),
        mode: this.mode || "",
        modeName: modeName,
        state: status.state,
        statusText: status.text,
        clicks: this.clickCount,
        dryRun: Boolean(this.isClicking ? this.dryRun : (this.mode === "script" ? this.scriptDryRun : jsBoolean(this.defaults.boolForKey("dryRun")))),
        remaining: this.isClicking && this.runDeadline ? formatClock((this.runDeadline - Date.now()) / 1000) : "",
        canStart: this.mode === "click" || this.mode === "script",
        error: this.lastErrorText && Date.now() - this.lastErrorTime < 60000 ? this.lastErrorText : "",
        activity: "",
        idleLeft: "",
        eye: "",
        images: []
    };
    if (this.mode === "script") {
        if (this.isClicking) {
            payload.activity = this.activityLabel ? jsString(this.activityLabel.stringValue) : "";
            payload.eye = this.eyeStatus + (this.eyeLastFrameMs ? tr(" · 每帧 ") + this.eyeLastFrameMs + " ms" : "");
            var left = this.script.idleStopMinutes * 60000 - (Date.now() - this.lastMatchTime);
            payload.idleLeft = formatClock(Math.max(0, left) / 1000);
        }
        var states = this.isClicking ? this.remoteImageStates : {};
        payload.images = this.script.images.map(function (image) {
            var s = states[image.id];
            return { name: image.name, threshold: image.threshold, score: s ? s.score : null, found: Boolean(s && s.found) };
        });
    }
    writeTextFile(REMOTE_STATUS_PATH, JSON.stringify(payload));
};

AutoClicker.prototype.readRemoteCommand = function () {
    var text = readTextFile(REMOTE_COMMAND_PATH);
    if (!text) return;
    var command;
    try { command = JSON.parse(text); } catch (error) { return; }
    if (!command || command.id === this.remoteLastCommandID) return;
    this.remoteLastCommandID = command.id;
    if (Date.now() - Number(command.ts) > REMOTE_COMMAND_MAX_AGE_MS) return;
    log("手机遥控命令：" + command.cmd + "，当前状态 " + this.currentStateName());
    if (command.cmd === "stop") {
        if (this.isClicking) this.stopSequence(tr("已用手机停止"));
        else if (this.countdownTimer) this.cancelCountdown(tr("已用手机取消开始"));
    } else if (command.cmd === "start") {
        if (this.isClicking || this.countdownTimer) return;
        if (this.mode !== "click" && this.mode !== "script") {
            this.noteError(tr("还没选模式"), tr("请先在电脑上选择“点击”或“脚本”模式。"));
            return;
        }
        this.lastErrorText = "";
        this.beginCountdown();   // 和点工具栏的"开始"一样：先检查，3 秒倒计时
    }
    this.writeRemoteStatus();
};

// 记下最近一次错误提示，手机网页上也能看到
AutoClicker.prototype.noteError = function (title, detail) {
    this.lastErrorText = title + tr("：") + detail;
    this.lastErrorTime = Date.now();
};

AutoClicker.prototype.remoteURL = function (useIP) {
    if (!this.remoteInfo) return "";
    var host = useIP ? this.remoteInfo.ip : this.remoteInfo.host;
    if (!host) return "";
    return "http://" + host + ":" + this.remoteInfo.port + "/?key=" + this.remoteKey;
};

AutoClicker.prototype.changeRemoteKey = function () {
    this.remoteKey = randomRemoteKey();
    this.defaults.setObjectForKey(this.remoteKey, "remoteKey");
    this.defaults.synchronize;
    log("手机遥控已换密码");
    if (this.remoteTask) {
        this.stopRemote(false);
        this.startRemote();
    }
    this.statusNote = tr("已换新密码，手机需要重新扫码");
    this.updateRemotePanel();
    this.updateUI();
};

AutoClicker.prototype.copyRemoteURL = function () {
    var url = this.remoteURL(false);
    if (!url) return;
    var board = $.NSPasteboard.generalPasteboard;
    board.clearContents;
    board.setStringForType($(url), $.NSPasteboardTypeString);
    this.remoteCopyNote = tr("已复制网址");
    this.updateRemotePanel();
};

// ---------------------------------------------------------------------------
// 手机遥控：二维码面板
// ---------------------------------------------------------------------------

function qrImageForText(text, scale) {
    var data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
    var filter = $.CIFilter.filterWithName("CIQRCodeGenerator");
    filter.setValueForKey(data, "inputMessage");
    filter.setValueForKey($("M"), "inputCorrectionLevel");
    // 放大时不插值，二维码边缘保持清晰
    var scaled = filter.outputImage.imageByApplyingTransform($.CGAffineTransformMakeScale(scale, scale));
    var rep = $.NSCIImageRep.imageRepWithCIImage(scaled);
    var image = $.NSImage.alloc.initWithSize(rep.size);
    image.addRepresentation(rep);
    return image;
}

AutoClicker.prototype.buildRemotePanel = function () {
    var W = REMOTE_PANEL_WIDTH, H = REMOTE_PANEL_HEIGHT;
    var visible = primaryScreenFrame();
    var x = Number(visible.origin.x) + (Number(visible.size.width) - W) / 2;
    var y = Number(visible.origin.y) + (Number(visible.size.height) - H) / 2;
    var panel = $.AutoClickerPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(x, y, W, H),
        $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
        $.NSBackingStoreBuffered, false
    );
    panel.title = tr("手机遥控");
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

    this.remoteStateLabel = this.makeLabel("", $.NSMakeRect(20, 16, W - 150, 24), 15, true, $.NSColor.labelColor);
    content.addSubview(this.remoteStateLabel);
    this.remoteToggleButton = this.extraButton("", $.NSMakeRect(W - 130, 12, 110, 30), "remote.toggle");
    content.addSubview(this.remoteToggleButton);

    this.remoteQRView = $.NSImageView.alloc.initWithFrame($.NSMakeRect((W - 240) / 2, 52, 240, 240));
    this.remoteQRView.imageScaling = $.NSImageScaleProportionallyUpOrDown;
    content.addSubview(this.remoteQRView);
    this.remoteQRPlaceholder = this.makeLabel("", $.NSMakeRect(40, 150, W - 80, 44), 13, false, secondary);
    this.remoteQRPlaceholder.alignment = $.NSTextAlignmentCenter;
    this.remoteQRPlaceholder.lineBreakMode = $.NSLineBreakByWordWrapping;
    content.addSubview(this.remoteQRPlaceholder);

    this.remoteURLLabel = this.makeLabel("", $.NSMakeRect(20, 302, W - 40, 36), 12, false, $.NSColor.labelColor);
    this.remoteURLLabel.selectable = true;
    this.remoteURLLabel.lineBreakMode = $.NSLineBreakByCharWrapping;
    content.addSubview(this.remoteURLLabel);
    this.remoteIPLabel = this.makeLabel("", $.NSMakeRect(20, 340, W - 40, 32), 11, false, secondary);
    this.remoteIPLabel.selectable = true;
    this.remoteIPLabel.lineBreakMode = $.NSLineBreakByCharWrapping;
    content.addSubview(this.remoteIPLabel);

    var hint = this.makeLabel(
        tr("手机和电脑连同一个 Wi‑Fi，用手机相机扫码打开，建议存成书签。换 Wi‑Fi 不用重新扫码；只有点“换密码”后才要重扫。") +
        tr("手机上可以看状态、开始和停止，不能改设置。第一次打开时如果 Mac 问是否允许 Python 接受连接，请点“允许”。"),
        $.NSMakeRect(20, 378, W - 40, 76), 11, false, secondary
    );
    hint.lineBreakMode = $.NSLineBreakByWordWrapping;
    content.addSubview(hint);

    this.remoteErrorLabel = this.makeLabel("", $.NSMakeRect(20, 456, W - 40, 32), 11, true, $.NSColor.systemRedColor);
    this.remoteErrorLabel.lineBreakMode = $.NSLineBreakByWordWrapping;
    content.addSubview(this.remoteErrorLabel);

    this.remoteCopyButton = this.extraButton(tr("复制网址"), $.NSMakeRect(20, 494, 160, 30), "remote.copy");
    content.addSubview(this.remoteCopyButton);
    this.remoteKeyButton = this.extraButton(tr("换密码"), $.NSMakeRect(W - 180, 494, 160, 30), "remote.newKey",
        tr("换一个新密码，旧的书签和二维码都会失效"));
    content.addSubview(this.remoteKeyButton);

    this.remotePanel = panel;
};

AutoClicker.prototype.showRemotePanel = function () {
    if (!this.remotePanel) this.buildRemotePanel();
    this.remoteCopyNote = "";
    this.updateRemotePanel();
    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
    this.remotePanel.makeKeyAndOrderFront($());
};

AutoClicker.prototype.updateRemotePanel = function () {
    if (!this.remotePanel) return;
    var on = Boolean(this.remoteTask);
    var url = this.remoteURL(false);
    this.remoteStateLabel.stringValue = on ? (url ? tr("手机遥控：已打开 ✓") : tr("手机遥控：正在打开…")) : tr("手机遥控：已关闭");
    this.remoteStateLabel.textColor = on && url ? $.NSColor.systemGreenColor : $.NSColor.labelColor;
    this.remoteToggleButton.title = on ? tr("关闭遥控") : tr("打开遥控");

    if (on && url) {
        if (this.remoteQRText !== url) {
            this.remoteQRView.image = qrImageForText(url, 8);
            this.remoteQRText = url;
        }
        this.remoteQRView.hidden = false;
        this.remoteQRPlaceholder.stringValue = "";
        this.remoteURLLabel.stringValue = url;
        var ipURL = this.remoteURL(true);
        this.remoteIPLabel.stringValue = ipURL ? tr("扫码打不开时试试这个（只在当前 Wi‑Fi 有效）：") + ipURL : "";
    } else {
        this.remoteQRView.hidden = true;
        this.remoteQRPlaceholder.stringValue = on ? tr("正在启动网页服务…") : tr("点右上角“打开遥控”后，这里会显示二维码");
        this.remoteURLLabel.stringValue = "";
        this.remoteIPLabel.stringValue = "";
    }
    this.remoteErrorLabel.stringValue = this.remoteError || "";
    this.remoteCopyButton.enabled = Boolean(url);
    this.remoteCopyButton.title = this.remoteCopyNote || tr("复制网址");
};
