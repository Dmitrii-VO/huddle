// Desktop app while I share: the child's camera in a small window over my full-screen slides. main.js keeps it
// on top and out of the captured picture; it's a blank same-origin window, so the stream is simply handed over.
let camWin = null;
export function syncCam(sharing, cam) {
  if (!sharing) { camWin?.close(); camWin = null; return; }
  if (!camWin || camWin.closed) {
    camWin = open('about:blank', 'huddle-cam');
    if (!camWin) return;
    const d = camWin.document;
    d.title = 'Ученик';
    d.body.style.cssText = 'margin:0;background:#000;overflow:hidden;-webkit-app-region:drag'; // drag anywhere to move
    d.body.innerHTML = '<video autoplay playsinline muted style="width:100vw;height:100vh;object-fit:cover"></video>';
  }
  const v = camWin.document.querySelector('video');
  if (v.srcObject !== cam) v.srcObject = cam; // muted copy: the sound keeps playing in the main window
}
