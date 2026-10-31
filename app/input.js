// The child's taps on the teacher's slides: one left click at a screen point, then the cursor goes back,
// and only onto a PowerPoint slide show. koffi ships prebuilt FFI binaries for every OS/arch.
// Coordinates are what the OS expects (see toOS in main.js).
const koffi = require('koffi');
const { execFile } = require('node:child_process');

function windows() {
  const user32 = koffi.load('user32.dll');
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
  const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, uint32 dx, uint32 dy, int32 data, uintptr extra)');
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
  const WindowFromPoint = user32.func('void * __stdcall WindowFromPoint(POINT p)');
  const GetAncestor = user32.func('void * __stdcall GetAncestor(void *hwnd, uint32 flags)');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint8 *buf, int max)');
  return {
    click(to, back) {
      SetCursorPos(to.x, to.y);
      mouse_event(0x0002, 0, 0, 0, 0); // left down
      mouse_event(0x0004, 0, 0, 0, 0); // left up
      SetCursorPos(back.x, back.y);
    },
    // The top-level window right under the tap must be "screenClass", PowerPoint's slide show window
    // (not the editor, not a notification or another app on top). Click-through windows (our overlay) don't count.
    async accepts(to) {
      const buf = Buffer.alloc(512);
      const n = GetClassNameW(GetAncestor(WindowFromPoint(to), 2 /* GA_ROOT */), buf, 256);
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
  const run = (args) => new Promise((ok) => execFile('/usr/bin/lsappinfo', args, (err, out) => ok(err ? '' : out)));
  return {
    // Always click count 1: a quick double tap stays two single clicks, never a double click (text editing).
    click(to, back) {
      fire(5 /* mouseMoved */, to);
      fire(1 /* leftMouseDown */, to, 1);
      fire(2 /* leftMouseUp */, to, 1);
      fire(5, back);
    },
    // ponytail: front app only, so the PowerPoint editor or a notification banner over the slides would take
    // the tap too; look up the window under the point (CGWindowListCopyWindowInfo) like on Windows.
    async accepts() {
      const asn = (await run(['front'])).trim();
      return !!asn && /"CFBundleIdentifier"="com\.microsoft\.Powerpoint"/i.test(await run(['info', '-only', 'bundleid', asn]));
    },
  };
}

module.exports = process.platform === 'darwin' ? mac() : windows();
