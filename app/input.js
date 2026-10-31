// The child's taps on the teacher's slides: one left click at a screen point, then the cursor goes back,
// and only while PowerPoint is the front app. koffi ships prebuilt FFI binaries for every OS/arch.
// Coordinates are what the OS expects (see toOS in main.js).
const koffi = require('koffi');
const { execFile } = require('node:child_process');

function windows() {
  const user32 = koffi.load('user32.dll');
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
  const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, uint32 dx, uint32 dy, int32 data, uintptr extra)');
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint8 *buf, int max)');
  return {
    click(to, back) {
      SetCursorPos(to.x, to.y);
      mouse_event(0x0002, 0, 0, 0, 0); // left down
      mouse_event(0x0004, 0, 0, 0, 0); // left up
      SetCursorPos(back.x, back.y);
    },
    // "screenClass" is PowerPoint's slide show window; the editor would let a tap drag shapes around.
    async inFront() {
      const buf = Buffer.alloc(512);
      const n = GetClassNameW(GetForegroundWindow(), buf, 256);
      return buf.toString('utf16le', 0, n * 2) === 'screenClass';
    },
  };
}

function mac() {
  const cg = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });
  const createMouse = cg.func('void *CGEventCreateMouseEvent(void *src, uint32 type, CGPoint pos, uint32 button)');
  const setField = cg.func('void CGEventSetIntegerValueField(void *e, uint32 field, int64 value)');
  const post = cg.func('void CGEventPost(uint32 tap, void *e)');
  const release = cf.func('void CFRelease(void *p)');
  const fire = (type, pos, clicks) => {
    const e = createMouse(null, type, pos, 0);
    if (clicks) setField(e, 1 /* kCGMouseEventClickState */, clicks);
    post(0 /* kCGHIDEventTap */, e);
    release(e);
  };
  // macOS doesn't infer double clicks: a quick second tap must say so, or PowerPoint sees two single clicks.
  let clicks = 0, last = 0;
  const run = (args) => new Promise((ok) => execFile('/usr/bin/lsappinfo', args, (err, out) => ok(err ? '' : out)));
  return {
    click(to, back) {
      const now = Date.now();
      clicks = now - last < 400 ? clicks + 1 : 1;
      last = now;
      fire(5 /* mouseMoved */, to);
      fire(1 /* leftMouseDown */, to, clicks);
      fire(2 /* leftMouseUp */, to, clicks);
      fire(5, back);
    },
    // ponytail: front app only, so the PowerPoint editor counts too; check the slide show window
    // (CGWindowList) if taps ever land in edit mode.
    async inFront() {
      const asn = (await run(['front'])).trim();
      return !!asn && /"CFBundleIdentifier"="com\.microsoft\.Powerpoint"/i.test(await run(['info', '-only', 'bundleid', asn]));
    },
  };
}

module.exports = process.platform === 'darwin' ? mac() : windows();
