#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$PROJECT_DIR/dist/AutoClicker.app"
SOURCES=("$PROJECT_DIR/Sources/I18n.js" "$PROJECT_DIR/Sources/AutoClicker.js" "$PROJECT_DIR/Sources/ScriptMode.js" "$PROJECT_DIR/Sources/Remote.js")
WATCHDOG="$PROJECT_DIR/Sources/watchdog.js"
EYE="$PROJECT_DIR/Sources/eye.py"
BUNDLE_ID="com.charlie.autoclicker"
BUILD_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/autoclicker-build.XXXXXX")"
TEMP_APP="$BUILD_TEMP/AutoClicker.app"
PLIST="$TEMP_APP/Contents/Info.plist"

cleanup() {
    rm -rf "$BUILD_TEMP"
}
trap cleanup EXIT

mkdir -p "$PROJECT_DIR/dist"

# osacompile is built into macOS. This avoids requiring a full Xcode install.
# Build outside Desktop first because cloud-synced Desktop folders can attach
# Finder metadata while osacompile is still creating the bundle.
# 主程序和脚本模式分成两个文件写，编译前按顺序拼成一个（脚本模式给主控制器添加方法）。
SOURCE="$BUILD_TEMP/AutoClicker-combined.js"
cat "${SOURCES[@]}" > "$SOURCE"
osacompile -l JavaScript -s -o "$TEMP_APP" "$SOURCE"

set_plist_value() {
    local key="$1"
    local type="$2"
    local value="$3"
    /usr/libexec/PlistBuddy -c "Set :$key $value" "$PLIST" 2>/dev/null || \
        /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$PLIST"
}

set_plist_value "CFBundleName" string "AutoClicker"
set_plist_value "CFBundleDisplayName" string "AutoClicker"
set_plist_value "CFBundleIdentifier" string "$BUNDLE_ID"
set_plist_value "CFBundleShortVersionString" string "3.0"
set_plist_value "CFBundleVersion" string "6"
set_plist_value "LSUIElement" bool "true"
set_plist_value "LSMinimumSystemVersion" string "13.0"

# 独立看门狗进程的脚本，主程序通过 NSTask 用 osascript 运行它。
cp "$WATCHDOG" "$TEMP_APP/Contents/Resources/watchdog.js"
# 脚本模式的识别进程（"眼睛"），主程序通过 NSTask 用 python3 运行它。
cp "$EYE" "$TEMP_APP/Contents/Resources/eye.py"
cp "$PROJECT_DIR/Sources/remote.py" "$TEMP_APP/Contents/Resources/remote.py"

# osacompile may copy Finder metadata that modern codesign rejects.
xattr -cr "$TEMP_APP"
rm -rf "$APP_DIR"
ditto "$TEMP_APP" "$APP_DIR"
xattr -cr "$APP_DIR"

# Ad-hoc 签名默认的 designated requirement 只包含 cdhash，每次重新构建 cdhash 都会变，
# 导致"辅助功能"里旧的授权条目不再匹配（开关是开的但 AXIsProcessTrusted 返回 false）。
# 这里显式指定按 bundle identifier 匹配的 requirement，重新构建后授权仍然有效。
codesign --force --deep --sign - \
    --requirements "=designated => identifier \"$BUNDLE_ID\"" \
    "$APP_DIR"
codesign --verify --deep --strict "$APP_DIR"
plutil -lint "$PLIST"
echo "designated requirement: $(codesign -d -r- "$APP_DIR" 2>&1 | grep designated)"

echo "构建完成：$APP_DIR"
