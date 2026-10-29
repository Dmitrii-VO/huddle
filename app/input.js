// Synthetic mouse and keyboard input through the OS APIs (koffi ships prebuilt FFI binaries for every OS/arch).
// Coordinates are screen pixels as the OS expects them (see toScreen in main.js).
const koffi = require('koffi');

function windows() {
  const user32 = koffi.load('user32.dll');
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
  const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, uint32 dx, uint32 dy, int32 data, uintptr extra)');
  const FLAGS = { left: [0x0002, 0x0004], right: [0x0008, 0x0010] }; // [down, up]

  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', ki: KEYBDINPUT, pad: koffi.array('uint8', 8) }); // union padded to MOUSEINPUT size
  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 n, _In_ INPUT *inputs, int size)');
  const sendKey = (vk, scan, flags) =>
    SendInput(1, { type: 1 /* INPUT_KEYBOARD */, ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 }, pad: [0, 0, 0, 0, 0, 0, 0, 0] }, koffi.sizeof(INPUT));
  const EXTENDED = 0x1, KEYUP = 0x2, UNICODE = 0x4;
  // [virtual key, needs EXTENDED flag]
  const VK = {
    ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1],
    PageUp: [0x21, 1], PageDown: [0x22, 1], End: [0x23, 1], Home: [0x24, 1], Delete: [0x2e, 1],
    Enter: [0x0d, 0], Backspace: [0x08, 0], Tab: [0x09, 0], Escape: [0x1b, 0], ' ': [0x20, 0],
  };

  return {
    move: (x, y) => SetCursorPos(x, y),
    button: (b, down) => mouse_event(FLAGS[b][down ? 0 : 1], 0, 0, 0, 0),
    wheel: (dy) => mouse_event(0x0800, 0, 0, -Math.round(dy), 0), // browser +dy = down, Windows +data = up
    key(name, down) {
      const [vk, ext] = VK[name];
      sendKey(vk, 0, (ext ? EXTENDED : 0) | (down ? 0 : KEYUP));
    },
    type(ch) {
      for (let i = 0; i < ch.length; i++) {
        sendKey(0, ch.charCodeAt(i), UNICODE);
        sendKey(0, ch.charCodeAt(i), UNICODE | KEYUP);
      }
    },
  };
}

function mac() {
  const cg = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });
  const createMouse = cg.func('void *CGEventCreateMouseEvent(void *src, uint32 type, CGPoint pos, uint32 button)');
  const createScroll = cg.func('void *CGEventCreateScrollWheelEvent(void *src, uint32 units, uint32 count, int32 wheel1, ...)');
  const setField = cg.func('void CGEventSetIntegerValueField(void *e, uint32 field, int64 value)');
  const post = cg.func('void CGEventPost(uint32 tap, void *e)');
  const release = cf.func('void CFRelease(void *p)');
  const createKey = cg.func('void *CGEventCreateKeyboardEvent(void *src, uint16 key, bool down)');
  const setUnicode = cg.func('void CGEventKeyboardSetUnicodeString(void *e, unsigned long len, const uint16 *chars)');
  const KEYCODE = {
    ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126, PageUp: 116, PageDown: 121,
    Home: 115, End: 119, Delete: 117, Enter: 36, Backspace: 51, Tab: 48, Escape: 53, ' ': 49,
  };
  const postKey = (code, down, chars) => {
    const e = createKey(null, code, down);
    if (chars) setUnicode(e, chars.length, chars);
    post(0, e);
    release(e);
  };

  // macOS needs explicit drag events and click counts (for double-click), Windows infers both.
  const TYPES = { left: { down: 1, up: 2, drag: 6 }, right: { down: 3, up: 4, drag: 7 } };
  let pos = { x: 0, y: 0 }, held = null, clicks = 0, lastDown = 0;
  const fire = (type, button, clickState) => {
    const e = createMouse(null, type, pos, button);
    if (clickState) setField(e, 1 /* kCGMouseEventClickState */, clickState);
    post(0 /* kCGHIDEventTap */, e);
    release(e);
  };
  return {
    move(x, y) {
      pos = { x, y };
      fire(held ? TYPES[held].drag : 5 /* mouseMoved */, held === 'right' ? 1 : 0);
    },
    button(b, down) {
      if (down) {
        const now = Date.now();
        clicks = now - lastDown < 400 ? clicks + 1 : 1;
        lastDown = now;
        held = b;
      } else {
        held = null;
      }
      fire(TYPES[b][down ? 'down' : 'up'], b === 'right' ? 1 : 0, clicks);
    },
    wheel(dy) {
      const e = createScroll(null, 0 /* pixels */, 1, -Math.round(dy));
      post(0, e);
      release(e);
    },
    key: (name, down) => postKey(KEYCODE[name], down),
    type(ch) {
      const chars = Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i));
      postKey(0, true, chars);
      postKey(0, false, chars);
    },
  };
}

module.exports = process.platform === 'darwin' ? mac() : windows();
