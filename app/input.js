// Synthetic mouse input through the OS APIs (koffi ships prebuilt FFI binaries for every OS/arch).
// Coordinates are screen pixels as the OS expects them (see toScreen in main.js).
const koffi = require('koffi');

function windows() {
  const user32 = koffi.load('user32.dll');
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
  const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, uint32 dx, uint32 dy, int32 data, uintptr extra)');
  const FLAGS = { left: [0x0002, 0x0004], right: [0x0008, 0x0010] }; // [down, up]
  return {
    move: (x, y) => SetCursorPos(x, y),
    button: (b, down) => mouse_event(FLAGS[b][down ? 0 : 1], 0, 0, 0, 0),
    wheel: (dy) => mouse_event(0x0800, 0, 0, -Math.round(dy), 0), // browser +dy = down, Windows +data = up
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
  };
}

module.exports = process.platform === 'darwin' ? mac() : windows();
