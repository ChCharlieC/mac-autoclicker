// 界面语言（中文 / English）。
//   tr("中文") 返回当前语言的文字；中文原文就是查表用的 key。
//   语言存在 defaults 的 language 键；没设过就跟随系统语言。切换语言后重启应用生效。
//   日志（log）不翻译，一直是中文。

ObjC.import("Foundation");

var I18N_LANG = null;

function currentLanguage() {
    if (I18N_LANG) return I18N_LANG;
    var saved = ObjC.unwrap($.NSUserDefaults.standardUserDefaults.stringForKey("language"));
    if (saved === "zh" || saved === "en") {
        I18N_LANG = saved;
    } else {
        var preferred = ObjC.deepUnwrap($.NSLocale.preferredLanguages) || [];
        I18N_LANG = String(preferred[0] || "en").indexOf("zh") === 0 ? "zh" : "en";
    }
    return I18N_LANG;
}

// 没有汉字的片段（括号、引号、标点）不进对照表，英文下统一换成半角
var I18N_PUNCTUATION = { "（": " (", "）": ")", "「": "“", "」": "”", "，": ", ", "：": ": ", "。": ". ", "、": ", ", "？": "?", "；": "; " };

function tr(text) {
    if (currentLanguage() === "zh") return text;
    var english = I18N_EN[text];
    if (english !== undefined) return english;
    return String(text).replace(/[（）「」，：。、？；]/g, function (mark) { return I18N_PUNCTUATION[mark]; });
}

var I18N_EN = {
    // 内部来源标记，只出现在日志和比较里
    "列表": "list", "圆点": "dot", "菜单 key equivalent": "menu key equivalent", "编辑": "Edit",
    "全局键盘监听": "global key monitor", "工具栏面板 Esc": "toolbar Esc", "按键状态轮询": "key state polling",

    // 看门狗和菜单
    "未启动": "not started", "缺少脚本": "script missing", "运行中": "running", "启动失败": "failed to start", "已退出": "exited",
    "看门狗进程多次退出，Esc 强制退出保障不可用": "Watchdog keeps exiting; Esc force-quit protection is unavailable",
    "上次被看门狗强制退出：": "Force-quit by the watchdog last time: ",
    "状态：已停止": "Status: stopped", "开始循环（3 秒后）": "Start loop (in 3s)", "点击点：0 个": "Points: 0",
    "载入方案": "Load layout", "显示工具栏": "Show toolbar", "切换模式…": "Switch mode…", "最小化工具栏": "Minimize toolbar", "手机遥控…": "Phone remote…",
    "辅助功能：尚未授权…": "Accessibility: not allowed…", "紧急停止：按 Esc": "Emergency stop: Esc", "打开日志文件": "Open log file", "退出 AutoClicker": "Quit AutoClicker",
    "紧急停止": "Emergency stop", "开始/停止": "Start/Stop", "开始/停止（": "Start/Stop (",

    // 点击模式工具栏
    "AutoClicker 工具栏": "AutoClicker toolbar", "手机遥控：用手机看状态、开始和停止": "Phone remote: view status, start and stop from your phone",
    "最小化：收成一条小条，不挡住屏幕": "Minimize to a small bar so it doesn't cover the screen", "⇄ 模式": "⇄ Mode", "回到模式选择页": "Back to mode selection", "● 已停止": "● Stopped",
    "放置": "Place", "删除": "Delete", "全部删除": "Delete all", "放置后，把屏幕上的编号圆点拖到目标位置。按创建顺序 1 → 2 → 3 循环。": "After placing, drag the numbered dots to your targets. They loop in order: 1 → 2 → 3.",
    "坐标": "Position", "点击间隔": "Interval", "全部间隔…": "All intervals…", "开始/停止快捷键：Ctrl+Option+C…": "Hotkey: Ctrl+Option+C…", "持续时间：不限…": "Duration: unlimited…",
    "随机扰动：关…": "Jitter: off…", "圆点大小：52 px…": "Dot size: 52 px…", "辅助功能：未生效（检查 / 修复）": "Accessibility: inactive (check / fix)",
    "系统设置 → 隐私与安全性 → 辅助功能 → 打开“AutoClicker”": "System Settings → Privacy & Security → Accessibility → turn on “AutoClicker”",
    "▶ 开始循环（3 秒后）": "▶ Start loop (in 3s)", "方案": "Layouts", "方案（": "Layouts (", "还没有保存的方案": "No saved layouts yet", "载入：": "Load: ", " 点）": " points)",
    "把当前点位保存为方案…": "Save current points as a layout…", "删除方案": "Delete layout", "选择模式": "Choose a mode", "点击": "Click", "放置编号点位，从上往下循环连点": "Place numbered points and click them in a loop",
    "脚本": "Script", "识别屏幕上的图片，按规则点击；没对上就连点": "Recognize images on screen and click by your rules",

    // 点击点
    "第 ": "Point ", " 个点击点（拖动调整位置）": " (drag to move)", "已选中第 ": "Selected point ", " 个点（可拖动）": " (drag to move)", " 个点位置已保存": " position saved",
    "点击点太多": "Too many points", "最多可以放置 ": "You can place up to ", " 个点击点。": " points.", "已添加第 ": "Added point ", " 个点，请拖动圆点到目标位置": ". Drag the dot to your target",
    "没有可删除的点": "No points to delete", "请先点击“放置”添加一个点位。": "Click “Place” to add a point first.", "删除：点击任意红色圆点即可删除": "Delete: click any red dot to remove it", "已退出删除": "Left delete mode",
    "已删除点击点，剩余 ": "Point deleted. Remaining: ", " 个": " ", "当前没有任何点位。": "There are no points.", "删除全部 ": "Delete all ", " 个点位？": " points?",
    "屏幕上的所有编号圆点都会被删除，不能撤销。已保存的方案不受影响，可以随时从“方案”里重新载入。": "All numbered dots on screen will be removed. This can't be undone. Saved layouts aren't affected and can be reloaded from “Layouts”.",
    "取消": "Cancel", "已删除全部 ": "Deleted all ", " 个点位": " points", "已选中点位 ": "Selected point ", " 个点": "", "已载入方案「": "Loaded layout “", " 个点）": " points)",
    "处理失败：": "Failed: ", "好": "OK", "设置第 ": "Set point ", " 个点的点击间隔": " click interval", "输入 1–60,000 毫秒，表示点击这个点后等待多久再点击下一个点。回车保存，Esc 取消。": "Enter 1–60,000 ms: how long to wait after this point before clicking the next. Return saves, Esc cancels.",
    "例如 750": "e.g. 750", "已取消修改": "Change cancelled", "保存": "Save", "请输入 1–60,000 之间的整数毫秒数。": "Enter a whole number from 1 to 60,000 ms.", "范围是 1–60,000 毫秒，当前输入 ": "The range is 1–60,000 ms. You entered ",
    " 个点：点击间隔 ": " interval: ", " 毫秒": " ms",

    // 快捷键、持续时间、随机扰动
    "快捷键": "Hotkey", "设置开始/停止快捷键": "Set the start/stop hotkey", "勾选修饰键，再输入一个主键：字母、数字、F1–F12、Enter、Space、Tab、Up/Down/Left/Right。Esc 固定为紧急停止键。": "Tick the modifier keys and enter a main key: letter, number, F1–F12, Enter, Space, Tab, Up/Down/Left/Right. Esc is reserved for emergency stop.",
    "主键": "Key", "例如 C 或 F6": "e.g. C or F6", "将设为：（请勾选修饰键并输入主键）": "Will be: (tick a modifier and enter a key)", "将设为：（至少勾选一个修饰键）": "Will be: (tick at least one modifier)", "将设为：（请输入主键）": "Will be: (enter a key)",
    "无法识别主键：": "Unknown key: ", "Esc 不能作为主键": "Esc can't be the main key", "将设为：": "Will be: ", "请至少勾选一个修饰键，并输入一个能识别的主键。": "Tick at least one modifier and enter a valid key.", "Esc 已固定为紧急停止键，请换一个主键。": "Esc is reserved for emergency stop. Choose another key.",
    "开始/停止快捷键已改为 ": "Hotkey changed to ", "不限": "unlimited", " 小时": " h", " 分钟": " min", " 秒": " s", "持续时间": "Duration", "设置持续时间": "Set duration", "运行这么长时间后自动停止。全部留空或为 0 表示不限时（一直运行到手动停止）。最长 24 小时。": "Stops automatically after this long. Leave empty or 0 for no limit (runs until you stop it). Maximum 24 hours.",
    "小时": "h", "分钟": "min", "秒": "s", "小时应为 0–24 的整数": "Hours must be a whole number from 0 to 24", "分钟应为 0–59 的整数": "Minutes must be a whole number from 0 to 59", "秒应为 0–59 的整数": "Seconds must be a whole number from 0 to 59", "最长 24 小时": "Maximum 24 hours",
    "小时应为 0–24 的整数。": "Hours must be a whole number from 0 to 24.", "分钟应为 0–59 的整数。": "Minutes must be a whole number from 0 to 59.", "秒应为 0–59 的整数。": "Seconds must be a whole number from 0 to 59.", "最长 24 小时。": "Maximum 24 hours.", "持续时间：": "Duration: ",
    "随机扰动": "Jitter", "设置随机扰动": "Set jitter", "每次点击的间隔在设定值上下随机浮动（毫秒），点击位置在圆点周围随机偏移（像素）。都填 0 表示关闭。间隔浮动最大 ": "Randomly varies each click's interval (ms) and position around the dot (px). Enter 0 for both to turn it off. Max interval variation ",
    " ms，位置偏移最大 ": " ms, max position offset ", "ms 间隔": "ms time", "px 位置": "px pos", "间隔浮动应为 0–": "Interval variation must be 0–", " 的整数": " (whole number)", "位置偏移应为 0–": "Position offset must be 0–", "将设为：关闭": "Will be: off", "将设为：间隔 ±": "Will be: interval ±", " ms，位置 ±": " ms, position ±", " 的整数。": " (whole number).",
    "随机扰动：": "Jitter: ", "关闭": "off", "圆点大小：": "Dot size: ", " px（全部 ": " px (all ", " 个点已更新）": " points updated)", "圆点大小": "Dot size", "设置全部编号圆点的大小": "Set the size of all numbered dots", "输入 ": "Enter ", " 像素（默认 ": " px (default ", "）。所有圆点一起变，边输入边预览；": "). All dots change together with a live preview; ",
    "圆点中心（真正的点击位置）不变。圆点太大容易挡住目标，太小不好拖动。": "the dot's center (the actual click position) doesn't move. Large dots can hide your target; small ones are harder to drag.", "请输入 ": "Enter ", "预览中：": "Preview: ", "（当前大小）": " (current size)", "（原来 ": " (was ", "恢复默认": "Reset", " 之间的整数像素。": " px (whole number).",

    // 方案
    "没有可保存的点位": "No points to save", "请先点击“放置”添加点位，再保存为方案。": "Click “Place” to add points first, then save them as a layout.", "方案 ": "Layout ", "保存方案": "Save layout", "把当前 ": "Save the current ", " 个点保存为方案": " points as a layout",
    "保存所有点的位置和点击间隔。以后在“方案”下拉菜单或菜单栏图标里点一下即可恢复整套布局。同名方案会被覆盖。": "Saves every point's position and interval. Restore the whole set from the “Layouts” menu or the menu bar icon. A layout with the same name is replaced.",
    "例如 每日流程": "e.g. Daily run", "请输入方案名称": "Enter a layout name", "名称最多 ": "Names can be up to ", " 个字": " characters", "将覆盖已有方案「": "Will replace layout “", "将保存为「": "Will save as “", "请输入方案名称。": "Enter a layout name.", " 个字。": " characters.", "最多保存 ": "You can save up to ", " 个方案，请先删除不用的方案。": " layouts. Delete one you don't need first.",
    "已覆盖方案「": "Replaced layout “", "已保存方案「": "Saved layout “", "删除方案「": "Delete layout “", "只删除保存的方案，不影响屏幕上当前的点位。": "Only the saved layout is deleted. Points on screen aren't affected.", "已删除方案「": "Deleted layout “",
    "统一间隔范围是 1–60,000 毫秒": "The interval range is 1–60,000 ms", "百分比必须大于 0": "The percentage must be above 0", "倍数必须大于 0": "The multiplier must be above 0", "还没有点击点": "No points yet", "请先点击“放置”添加点位。": "Click “Place” to add points first.", "全部间隔": "All intervals", "一键调整全部 ": "Adjust the interval of all ",
    "输入数字：全部统一设为该毫秒数（如 300）\n": "Number: set all to that many ms (e.g. 300)\n", "输入百分比：按比例变快/变慢（50% = 快一倍，200% = 慢一倍）\n": "Percent: scale all (50% = twice as fast, 200% = half as fast)\n", "输入 +N / -N：全部加/减 N 毫秒（如 -100）": "+N / -N: add or subtract N ms (e.g. -100)",
    "例如 300、50%、-100": "e.g. 300, 50%, -100", "（请输入调整方式）": "(enter an adjustment)", "无法识别，请输入如 300、50%、+100": "Not recognized. Try 300, 50%, +100", "将变为：": "Will become: ", "应用": "Apply", "请输入如 300、50%、x0.5、+100、-100。": "Enter something like 300, 50%, x0.5, +100 or -100.", "已调整全部 ": "Adjusted all ", " 个点的间隔": " intervals",

    // 权限
    "辅助功能": "Accessibility", "辅助功能权限正常": "Accessibility permission is OK", "当前这个 AutoClicker 已经获得授权，可以生成鼠标点击。": "This copy of AutoClicker is allowed to generate mouse clicks.", "系统还没有授权当前版本": "macOS hasn't allowed this version yet",
    "系统设置 → 隐私与安全性 → 辅助功能，打开“AutoClicker”开关。\n": "System Settings → Privacy & Security → Accessibility, turn on “AutoClicker”.\n", "如果列表里已经有“AutoClicker”但仍不生效：先用 − 删除它，再点 + 重新选择：\n": "If “AutoClicker” is listed but doesn't work: remove it with −, then add it again with +:\n", "\n然后点“重新检查”。": "\nThen click “Check again”.",
    "重新检查": "Check again", "辅助功能已授权": "Accessibility allowed", "系统仍未授权，请按上面步骤操作后再点“重新检查”。": "Still not allowed. Follow the steps above, then click “Check again”.", "打开系统设置": "Open System Settings", "已打开系统设置，授权后请点“重新检查”。": "System Settings opened. Allow it, then click “Check again”.",
    "多点序列模式已经准备好": "Click mode is ready", "点击“放置”生成编号圆点，把它们拖到目标位置。程序会按 1 → 2 → 3 循环，每个点都能设置点击间隔。运行中按 Esc 可紧急停止。": "Click “Place” to create numbered dots and drag them to your targets. They loop 1 → 2 → 3, each with its own interval. Press Esc at any time for an emergency stop.", "辅助功能设置": "Accessibility settings", "开始使用": "Get started",

    // 点击模式状态
    "点击“放置”放置点位": "Click “Place” to add points", "选中第 ": "Select point ", " 个点（圆点会闪烁）": " (its dot will flash)", "● 已停止 · ": "● Stopped · ", "● 正在循环": "● Looping", " · 剩余 ": " · left ", "（按 Esc 停止）": " (Esc to stop)", " · 演练模式": " · Dry run", " 秒后开始（按 Esc 取消）": "s to start (Esc cancels)", "● 删除：点击红色圆点": "● Delete: click a red dot",
    "AutoClicker 工具栏 · ": "AutoClicker toolbar · ", " 点": " points", "退出删除": "Exit delete", "开始/停止快捷键：": "Hotkey: ", "关": "off", "■ 停止循环": "■ Stop loop", "取消开始": "Cancel start", "辅助功能：已授权（重新检查）": "Accessibility: OK (check again)", " · 按键轮询失效": " · key polling failed", " · 看门狗": " · Watchdog",
    "状态：正在循环（按 Esc 停止）": "Status: looping (Esc to stop)", "状态：": "Status: ", " 秒后开始": "s to start", "停止循环": "Stop loop", "点击点：": "Points: ", "辅助功能：已授权": "Accessibility: OK", "已手动停止": "Stopped manually", "已取消开始": "Start cancelled", "已用快捷键停止": "Stopped by hotkey", "已用快捷键取消": "Cancelled by hotkey", "已按 Esc 紧急停止": "Emergency stop (Esc)", "已按 Esc 取消开始": "Start cancelled (Esc)",
    "Esc 按键轮询失效，已停止以策安全": "Esc key polling failed. Stopped for safety", "Esc 轮询失效，已停止以策安全": "Esc polling failed. Stopped for safety", "Esc 轮询失效，已取消": "Esc polling failed. Cancelled", "请先点击“放置”，并把编号圆点拖到目标位置。": "Click “Place” first, then drag the numbered dots to your targets.", " 个点不在当前屏幕内": " is off screen", "显示器排列可能发生了变化，请重新放置这个点击点。": "Your display arrangement may have changed. Place this point again.",
    " 个点被": " is covered by the ", "最小化小条": "mini bar", "工具栏": "toolbar", "挡住了": "", "请先移动": "Move the ", "小条（最小化后拖动它）": "mini bar (minimize, then drag it)", "或拖动点击点，再开始循环。": " or drag the point, then start again.", "已运行 ": "Ran for ", "，按设定停止": ". Stopped as set", "点击点已为空": "No points left", "检测到 Esc 已按下，未发送点击": "Esc is down. Click not sent", "已停止": "Stopped", "权限已被关闭": "Permission was turned off", "权限已被关闭，已停止": "Permission was turned off. Stopped",

    // 脚本模式：基础
    "点击点位": "Click point", "运行点击方案": "Run layout", "等待": "Wait", "超时": "Timed out", "图片": "Images", "点位 ": "Point ", "未知应用": "Unknown app", "还没有选择窗口，点“选一个窗口…”": "No window chosen. Click “Pick window…”", "窗口：": "Window: ", "，会跟着窗口移动）": ", follows the window)", "（现在找不到这个窗口）": " (window not found right now)",
    "还没有框选区域，点“框选区域…”": "No area selected. Click “Select area…”", "区域：从 (": "Area: from (", ") 开始 ": "), size ", "整个屏幕（": "Full screen (", "AutoClicker · 脚本模式": "AutoClicker · Script mode", "脚本模式": "Script mode", "— 最小化": "— Minimize", "收成一条小条，不挡住屏幕": "Shrink to a small bar so it doesn't cover the screen", "📱 手机遥控": "📱 Remote", "用手机看状态、开始和停止": "View status, start and stop from your phone",
    "扫描范围": "Scan area", "整个屏幕": "Full screen", "选一个窗口…": "Pick window…", "框选区域…": "Select area…", "图片（框选或上传）": "Images", "清空": "Clear", "上传": "Upload", "取样": "Sample", "点位": "Points", "导入…": "Import…", "从点击模式现在的点位，或点击模式保存过的方案导入": "Import from Click mode's current points or a saved layout", "圆点大小…": "Dot size…", "屏幕录制": "Screen Recording",
    "规则（从上往下，执行第一条成立的）": "Rules (first match runs)", "添加规则": "Add rule", "以上都没对上 → 连点": "No rule matched →", "越高反应越快，也越占 CPU": "Higher reacts faster but uses more CPU", "提示：这个时间要比一轮完整流程的时长更长": "Tip: make this longer than one full round of your task", "演练（只识别不点击）": "Dry run (no clicks)", "▶ 开始脚本（3 秒后）": "▶ Start script (in 3s)",
    "点“取样”框住按钮或文字，或者“上传”一张图片": "Click “Sample” to box a button or text, or “Upload” an image", "（上传": " (uploaded", "，已记住大小 ": ", size remembered: ", "，运行时自动找大小": ", size found automatically at run time", "改名": "Rename", "门槛 ": "Min ", "相似度达到这个值才算“看到”": "Similarity must reach this value to count as “seen”", "点“放置”添加点位，或“从点击模式导入”": "Click “Place” to add points, or “Import…” from Click mode", "相对窗口左上角的位置": "Relative to the window's top-left corner", "屏幕坐标": "Screen position", "默认连点时，点完这个点后等多久再点下一个": "When looping by default: how long to wait before the next point",

    // 规则
    "规则 ": "Rule ", "每轮之间再等 ": "wait between rounds: ", "一直运行，直到下面的条件满足（": "Run until met (", "运行 1 轮…": "Run 1 round…", "运行 ": "Run ", " 轮，": " rounds, ", "每次间隔 ": "every ", "一直点，直到下面的条件满足（": "Click until met (", "点 1 次…": "Click once…", "点 ": "Click ", " 次，": " times, ",
    "点“添加规则”。例如：看到[开始按钮] → 点击[图片中心]": "Click “Add rule”. For example: see [Start button] → click [a point]", "（选择图片）": "(choose image)", "（选择点位）": "(choose point)", "按住这里上下拖动，可以把整条规则移到任意位置（例如拖到第一）": "Drag up or down to move this rule anywhere (for example, to the top)", "起名字…": "Name…", "给这条规则起个名字，方便区分（序号还是会显示）": "Name this rule so it's easy to tell apart (its number still shows)", "+ 条件": "+ Cond", "给这条规则再加一个条件": "Add another condition to this rule",
    "把整条规则往上移一位（越靠上越优先）": "Move this rule up (higher rules run first)", "把整条规则往下移一位": "Move this rule down", "删除整条规则": "Delete this rule", "如果": "If", "并且": "And", "或者": "Or", "看到": "Seen", "没看到": "Unseen", "（图片已删除）": "(image deleted)", "就": "Do", "（点位已删除）": "(point deleted)", "（选择点击方案）": "(choose layout)", "（已删除，用副本）": "(deleted, using a copy)",
    "运行「": "Run “", "」的全部 ": "”: all ", " 个点，按方案里的顺序和间隔": " points, in the layout's order and intervals", "只能选点击模式里保存的方案": "Only layouts saved in Click mode can be chosen", "冷却 ": "Cool ", "冷却是时间（秒）：这条规则做完动作后，等这么多秒才重新检查规则、恢复默认连点。和扫描次数、点击次数无关": "Cooldown is time in seconds: after this rule acts, wait this long before checking rules or resuming default clicks. It's unrelated to scan or click counts",
    "次数": "Reps", "点这里填点几次、每次间隔多久，或改成“一直点，直到……”": "Set how many clicks and the interval, or switch to “keep clicking until…”", "直到": "Until", "满足这个条件就停止点击。最多连续点 ": "Stops clicking when this is met. Clicks for at most ", " 分钟；按 Esc 随时停止": " min; press Esc to stop at any time", " 第 ": " point ", "（点击模式里已删除，用保存的副本）": " (deleted in Click mode, using the saved copy)",
    "默认连点": "Default clicks", "什么都不做": "Do nothing", "运行点击方案「": "Run layout “", "（还没有点位）": "(no points yet)", "全部点位（": "All points (", " 个）": ")", "连点脚本模式的点位：": "Click script points:", "    全部点位（按列表顺序）": "    All points (list order)", "或者循环运行点击模式的方案：": "Or loop a Click mode layout:", "（点击模式还没有保存过方案）": "(no layouts saved in Click mode)", "“什么都不做”= 只有规则成立时才点击": "“Do nothing” = click only when a rule matches",

    // 脚本模式状态
    " 张图片 · ": " images · ", " 个点位 · ": " points · ", " 条规则": " rules", "● 脚本运行中": "● Script running", " · 演练模式（不点击）": " · Dry run (no clicks)", " 分钟没识别到就停止…": " min with no match → stop…", "每秒扫描 ": "Scans/sec: ", " 次…": "…", "■ 停止脚本": "■ Stop script", "辅助功能：未授权…": "Accessibility: not allowed…", "屏幕录制：已授权": "Screen Recording: OK", "屏幕录制：未授权…": "Screen Recording: not allowed…", "识别进程（眼睛）：": "Recognition process: ", " · 每帧 ": " · per frame ",
    "演练模式：开始后只识别、显示相似度，不点击也不按键": "Dry run: recognizes and shows similarity, without clicking", "已关闭演练模式": "Dry run off", "以上都没对上 → 什么都不做": "No rule matched → do nothing", "以上都没对上 → 循环运行点击方案「": "No rule matched → loop layout “", "已删除": "Deleted ", "：运行点击方案「": ": run layout “", "原来的规则 ": "Former rule ", " 已移到第 ": " moved to position ", " 位": "",
    "规则改名": "Rename rule", "给规则 ": "Name rule ", " 起名字": "", "例如“开始”“结果”“关闭弹窗”。前面的序号（第几条）会一直显示，留空就是不起名字。": "For example “Start”, “Results”, “Close popup”. The rule's number always shows. Leave empty for no name.", "名字最多 ": "Names can be up to ", " 已命名为「": " named “", " 已去掉名字": " name removed", "规则太多": "Too many rules", "最多 ": "Maximum: ", " 条规则。": " rules.", "已添加规则 ": "Added rule ",
    "扫描范围：整个屏幕": "Scan area: full screen", "拖动框选要扫描的区域（Esc 取消）": "Drag to select the area to scan (Esc cancels)", "扫描范围：框选的区域 ": "Scan area: selected area ", "选择窗口": "Choose window", "没有找到可用的窗口（需要“屏幕录制”权限才能看到窗口标题）": "No windows found (Screen Recording permission is needed to see window titles)", "扫描范围：窗口「": "Scan area: window “", "已取消框选": "Selection cancelled",

    // Python 和图片
    "应用里缺少 eye.py，请重新运行 build-app.sh": "eye.py is missing from the app. Run build-app.sh again", "没有找到 python3": "python3 not found", "无法运行": "couldn't run", "需要 Python 依赖": "Python packages needed", "识别进程（眼睛）无法启动": "The recognition process couldn't start", "需要 Python 3 并安装 opencv-python、numpy、mss。请在“终端”里运行：\n": "Python 3 with opencv-python, numpy and mss is required. Run this in Terminal:\n", "如果装在别的 Python 里，可以指定路径：defaults write com.charlie.autoclicker pythonPath /路径/python3\n": "If they're installed in another Python, set its path: defaults write com.charlie.autoclicker pythonPath /path/to/python3\n", "详情：": "Details: ",
    "图片太多": "Too many images", " 张图片。": " images.", "拖动框住一个按钮或一段文字（Esc 取消）": "Drag to box a button or text (Esc cancels)", "取样失败": "Sampling failed", "截图进程没有返回结果": "The capture process returned nothing", "图片 ": "Image ", "选一张只有按钮或文字的图片，大小不用管": "Choose an image of just the button or text. Any size is fine", "运行中不能添加图片，请停止后再上传": "Can't add images while running. Stop first, then upload", "上传失败": "Upload failed", "处理图片的进程没有返回结果": "The image process returned nothing", "读不出这张图片，请换 PNG 或 JPG 格式": "Couldn't read this image. Try PNG or JPG",
    "注意：这张图几乎是一整块纯色，可能没有“屏幕录制”权限，或者框到了空白处。": "Note: this image is almost one solid color. Screen Recording may be off, or you boxed an empty area.", "例如“开始按钮”“完成”“返回”。名字只是给你看的，可以随时改。": "For example “Start button”, “Done”, “Back”. The name is just for you and can be changed anytime.", "注意：这张图很大，像是整张截图。图片要裁剪到只剩按钮或文字本身，否则认不出来。": "Note: this looks like a full screenshot. Crop it to just the button or text, or it won't be recognized.", "大小不用管，运行时会自己匹配。图片要裁剪到只剩按钮或文字本身。": "Any size works; it's matched at run time. Crop it to just the button or text.",
    "新图片": "New image", "给这张图片起个名字（": "Name this image (", "例如 开始按钮": "e.g. Start button", "不要了": "Discard", "请输入名字。": "Enter a name.", "已添加图片「": "Added image “", "」，相似度门槛 ": "”, threshold ", "图片改名": "Rename image", "给图片「": "Rename image “", "」改名": "”", "规则里引用的是这张图片本身，改名不影响规则。": "Rules refer to the image itself, so renaming doesn't affect them.", "相似度门槛": "Similarity threshold", "图片「": "Image “", "」的相似度门槛": "” similarity threshold",
    "相似度达到这个值才算“看到”，范围 0.50–0.99，默认 0.85。认错了就调高，明明在屏幕上却认不出就调低。": "Similarity must reach this value to count as “seen”. Range 0.50–0.99, default 0.85. Raise it if it matches the wrong thing; lower it if it misses something on screen. ", "开“演练”运行时，图片列表会实时显示当前相似度，方便参考。": "During a dry run, the image list shows live similarity for reference.", "请输入 0.50–0.99（也可以写 85 表示 0.85）": "Enter 0.50–0.99 (85 also means 0.85)", "请输入 0.50–0.99 之间的数。": "Enter a number from 0.50 to 0.99.", "」相似度门槛：": "” threshold: ",

    // 次数对话框
    "间隔请填 ": "Interval must be ", " 的整数毫秒": " ms (whole number)", "次数请填 1–": "Count must be 1–", "点击次数": "Click count", "：运行几轮？": ": how many rounds?", "：点几次？": ": how many clicks?", "一轮 = 把方案里的点按顺序、按各自的间隔全部点一遍。填运行几轮，以及每轮之间再等多少毫秒（1000 毫秒 = 1 秒）。": "One round = click every point in the layout, in order, with its own interval. Enter the number of rounds and the wait between rounds (1000 ms = 1 second). ", "填写点几次，以及两次点击之间隔多少毫秒（1000 毫秒 = 1 秒）。": "Enter how many clicks and the time between them (1000 ms = 1 second). ",
    "勾选“一直点”后会不停地点，直到规则卡片里“直到”那一行的条件满足（例如看到某张图片）就停；最多连续 ": "With “Keep clicking”, it clicks until the “Until” line on the rule card is met (for example, an image is seen), for at most ", " 分钟，Esc 随时可停。": " min. Esc stops it at any time.", "一直运行": "Keep running", "一直点": "Keep clicking", "，直到“直到”那一行的条件满足": " until the “Until” line is met", "轮": "rnd", "次": "×", "毫秒/每轮": "ms/rnd", "毫秒间隔": "ms gap",
    "将会：一轮接一轮地运行，每轮之间等 ": "Will: run round after round, waiting ", " 毫秒，直到条件满足": " ms between them, until the condition is met", "将会：运行 ": "Will: run ", " 轮": " rounds", "，每轮之间等 ": ", waiting between rounds: ", "将会：一直点，每次间隔 ": "Will: keep clicking every ", " 毫秒，直到条件满足（次数不用填）": " ms until the condition is met (no count needed)", "将会：点 ": "Will: click ", " 次": " times", "，每次间隔 ": ", every ",

    // 删除和清空
    "删除图片": "Delete image", "删除图片「": "Delete image “", " 用到了这张图片，删除后这些地方会显示“已删除”，对应条件不再成立。": " use this image. After deleting, they show “deleted” and those conditions no longer apply.", "没有规则用到这张图片。": "No rules use this image.", "已删除图片「": "Deleted image “", "规则": "Rules", "规则里用到这些图片的条件会显示“已删除”，不再成立。": "Rule conditions using these images show “deleted” and no longer apply. ", "规则里用到这些点位的动作需要重新选择点位。": "Rule actions using these points need a new point. ", "图片和点位都会留着。": "Images and points are kept. ",
    "当前没有": "No ", "可以清空": " to clear", "清空全部 ": "Clear all ", "不能撤销；已保存的脚本方案不受影响。": "This can't be undone. Saved script presets aren't affected.", "已清空": "Cleared ", "（拖动调整位置）": " (drag to move)", "点位太多": "Too many points", " 个点位。": " points.", "已添加点位 ": "Added point ", "，请拖动绿色圆点到目标位置": ". Drag the green dot to your target",

    // 点位
    "导入点位": "Import points", "点击模式现在的点位（": "Click mode's current points (", "点击模式保存的方案：": "Layouts saved in Click mode:", "方案「": "layout “", "点击模式": "Click mode", "点击模式里没有点位": "No points in Click mode", "先在点击模式里放置点位，再回来导入。": "Place points in Click mode first, then come back to import.", "导入 ": "Import ", "已从": "From ", "（已达上限 ": " (limit reached: ", "，已换算成相对窗口的位置": ", converted to window-relative positions", "」位置已保存": "” position saved", "已删除点位「": "Deleted point “", "点位改名": "Rename point", "给点位 ": "Name point ", "例如“开始”“确认”“关闭弹窗”，规则里会显示这个名字。": "For example “Start”, “Confirm”, “Close popup”. Rules show this name.", " 已改名为「": " renamed to “", "」的点击间隔": "” click interval",
    "默认连点时，点完这个点后等待多久再点下一个（1–60,000 毫秒）。规则动作点这个点时不使用这个间隔。": "When looping by default: how long to wait before the next point (1–60,000 ms). Rule actions don't use this interval.", "例如 500": "e.g. 500", "点位「": "Point “", "」间隔 ": "” interval ",

    // 扫描频率、自动停止
    "扫描频率": "Scan rate", "每秒扫描屏幕多少次": "How many times to scan the screen per second", " 次，默认 ": ", default ", " 次。越高反应越快，也越占 CPU；画面变化慢就可以调低。": ". Higher reacts faster but uses more CPU; lower it for slow-changing screens. ", "运行时下方状态会显示“每帧 N ms”：如果 N 比每次扫描的间隔（1000 ÷ 次数）还大，实际就达不到这么快。": "While running, the status shows “per frame N ms”. If N is larger than the scan interval (1000 ÷ rate), the real rate will be lower.", "次/秒": "/sec", "请输入 1–": "Enter 1–",
    "自动停止": "Auto stop", "多久没识别到任何页面就停止": "Stop after how long with no rule matched", "从上一次有任何一条规则对上开始计时，超过这么多分钟就停止脚本（1–": "Counted from the last time any rule matched. The script stops after this many minutes (1–", "这个时间要比一轮完整流程的时长更长，否则可能中途被停掉。": "Make it longer than one full round, or it may stop halfway through.", " 的整数分钟。": " minutes, whole number.", "连续 ": "Stop after ", " 分钟没识别到任何页面就停止": " min with no match",

    // 脚本方案
    "脚本方案": "Script presets", "脚本方案（": "Script presets (", "还没有保存的脚本方案": "No saved script presets yet", " 图 / ": " images / ", " 规则）": " rules)", "把当前脚本保存为方案…": "Save current script as a preset…", "删除脚本方案": "Delete script preset", "脚本 ": "Script ", "保存脚本方案": "Save script preset", "把当前脚本保存为方案": "Save the current script as a preset", "一起保存：扫描范围、图片、点位、规则、默认连点和自动停止设置。和点击模式的方案分开存放。同名会覆盖。": "Saves the scan area, images, points, rules, default clicks and auto-stop settings, separately from Click mode layouts. The same name is replaced.", "例如 每日任务": "e.g. Daily tasks", " 个脚本方案。": " script presets.", "已保存脚本方案「": "Saved script preset “", "已载入脚本方案「": "Loaded script preset “", "删除脚本方案「": "Delete script preset “", "只删除保存的方案，不影响当前正在编辑的脚本。": "Only the saved preset is deleted. The current script isn't affected.", "已删除脚本方案「": "Deleted script preset “",

    // 屏幕录制和开始前检查
    "屏幕录制权限正常": "Screen Recording permission is OK", "识别进程（眼睛）可以截取屏幕内容。": "The recognition process can capture the screen.", "需要“屏幕录制”权限": "Screen Recording permission needed", "脚本模式要截屏识别图片。请到 系统设置 → 隐私与安全性 → 屏幕与系统录音（屏幕录制），打开“AutoClicker”。\n": "Script mode captures the screen to recognize images. Go to System Settings → Privacy & Security → Screen & System Audio Recording and turn on “AutoClicker”.\n", "macOS 要求授权后退出并重新打开 AutoClicker 才生效。": "macOS requires quitting and reopening the app after allowing it.", "授权后点“退出 AutoClicker”，再重新打开。": "After allowing it, click “Quit AutoClicker” and open it again.",
    "有条件还没选图片": "A condition has no image selected", "条件里的图片已被删除": "An image in a condition was deleted", "还没选要点击的点位": "No point selected to click", "要点击的点位已被删除": "The point to click was deleted", "还没选要运行的点击方案": "No layout selected to run", "“直到”里的图片已被删除": "The image in “Until” was deleted", "“一直点，直到…”还没选图片": "“Keep clicking until…” has no image selected", "脚本是空的": "The script is empty", "请先添加至少一条规则。": "Add at least one rule first.", " 还没写完": " isn't finished", "。请修改或删除这条规则。": ". Fix or delete this rule.",
    "找不到要扫描的窗口": "Can't find the window to scan", "当前不在屏幕上（可能被最小化、关闭或在别的桌面）。请打开它，或在“扫描范围”里重新选择。": " isn't on screen (it may be minimized, closed or on another desktop). Open it or choose again under “Scan area”.", "还没有框选区域": "No area selected", "请在“扫描范围”里点“框选区域…”。": "Click “Select area…” under “Scan area”.", "挡住了扫描范围": " covers the scan area", "请把": "Drag the ", "拖到扫描范围外面，否则会挡住要识别的画面。": " outside the scan area, or it will hide what needs to be recognized.", "（先点“— 最小化”，再拖动小条）": " (click “— Minimize” first, then drag the bar)", "」不在屏幕内": "” is off screen", "请重新拖动这个点位。": "Drag this point again.", "」被": "” is covered by the ", "请移动": "Move the ", "或拖动点位。": " or drag the point.",

    // 运行中
    "启动中": "starting", "未运行": "not running", "识别进程出错：": "Recognition process error: ", "已重启 ": "restarted ", "出错：": "error: ", "运行中✓": "running ✓", "暂时没有结果": "no results yet", "等待识别进程启动…": "Waiting for the recognition process…", "已停止：": "Stopped: ", " 分钟没有识别到任何页面": " min with no match", "找不到扫描窗口": "Can't find the scan window", "“直到”的条件满足了": "The “Until” condition was met", " 冷却中（还剩 ": " cooling down (", " 秒）": "s left)", "找不到扫描窗口，暂停连点（等待窗口回来）": "Can't find the scan window. Paused until it returns", "没对上任何规则 → 什么都不做，等待中": "No rule matched → doing nothing, waiting", "没对上任何规则 → ": "No rule matched → ", "【演练】": " [dry run]", "没对上任何规则（没有默认连点的点位）": "No rule matched (no default points)", "找大小…": "Sizing…", "检测到 Esc 已按下，未执行动作": "Esc is down. Action skipped",
    " → 点击「": " → click “", " → 等待 ": " → wait ", " → 没有可点的位置，跳过": " → nothing to click, skipped", "已经连续点了 ": "Clicked for ", " 分钟，先停下": " min. Stopping for now", "」第 ": "”: ", " 次（直到": " clicks (until ", "点完 ": "Clicked ", "点击方案里没有点": "The layout has no points", " → 运行「": " → run “", "，第 ": ", point ", "运行完 ": "Ran ", "默认方案": "Default layout",

    // 最小化和手机遥控
    "开始后会自动最小化，停止后自动展开": "Minimizes on start and restores on stop", "开始后不自动最小化": "Won't minimize on start", "开始后自动最小化（停止后自动展开）": "Auto-minimize on start (restore on stop)", "运行中 · ": "Running · ", " · 演练": " · Dry run", " 秒后开始（Esc 取消）": "s to start (Esc cancels)", "停止": "Stop", "开始（3 秒后）": "Start (in 3s)", "找不到 python3，无法打开手机遥控": "python3 not found, so the phone remote can't open", "网页服务启动失败：": "Web service failed to start: ", "网页服务启动失败": "Web service failed to start", "网页服务反复退出，已放弃。详情见 remote-stderr.log": "The web service keeps exiting, so it was stopped. See remote-stderr.log", "还没选模式（请在电脑上选）": "No mode chosen (choose one on the computer)", "已用手机停止": "Stopped from phone", "已用手机取消开始": "Start cancelled from phone", "还没选模式": "No mode chosen", "请先在电脑上选择“点击”或“脚本”模式。": "Choose “Click” or “Script” mode on the computer first.",
    "已换新密码，手机需要重新扫码": "New password set. Scan the QR code again on your phone", "已复制网址": "Copied", "手机遥控": "Phone remote", "手机和电脑连同一个 Wi‑Fi，用手机相机扫码打开，建议存成书签。换 Wi‑Fi 不用重新扫码；只有点“换密码”后才要重扫。": "Use the same Wi‑Fi on both, scan with your phone's camera and bookmark the page. Only “New password” needs a new scan. ", "手机上可以看状态、开始和停止，不能改设置。第一次打开时如果 Mac 问是否允许 Python 接受连接，请点“允许”。": "The phone can only view status, start and stop. If your Mac asks to allow Python connections, click “Allow”.", "复制网址": "Copy URL", "换密码": "New password", "换一个新密码，旧的书签和二维码都会失效": "Set a new password. Old bookmarks and QR codes stop working", "手机遥控：已打开 ✓": "Phone remote: on ✓", "手机遥控：正在打开…": "Phone remote: starting…", "手机遥控：已关闭": "Phone remote: off", "关闭遥控": "Turn off", "打开遥控": "Turn on", "扫码打不开时试试这个（只在当前 Wi‑Fi 有效）：": "If the QR code doesn't open, try this (current Wi‑Fi only): ", "正在启动网页服务…": "Starting web service…", "点右上角“打开遥控”后，这里会显示二维码": "Click “Turn on” at the top right to show the QR code",

    // 切换语言
    "运行中不能切换语言，请先停止": "Stop the run before changing the language"
};
