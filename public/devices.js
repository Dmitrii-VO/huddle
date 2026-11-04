// My microphone and camera: the mute buttons, and swapping a device mid-call.
const $ = (id) => document.getElementById(id);

export function createDevices({ local, getPc, render, sendState, reportMic, toast }) {
  function toggle(button, getTracks, labels) {
    const label = button.querySelector('span');
    if (!getTracks().length) {
      button.disabled = true; // a device chosen in settings re-enables it
      button.classList.add('off');
    }
    button.onclick = () => {
      const tracks = getTracks();
      const enabled = !tracks[0].enabled;
      tracks.forEach((t) => (t.enabled = enabled));
      button.classList.toggle('off', !enabled);
      label.textContent = labels[enabled ? 0 : 1];
      sendState();
      reportMic();
      render();
    };
  }
  toggle($('mic'), () => local.getAudioTracks(), ['Выкл. звук', 'Вкл. звук']);
  toggle($('cam'), () => local.getVideoTracks(), ['Остановить видео', 'Включить видео']);

  // Swap camera / microphone mid-call without renegotiating (replaceTrack).
  async function switchDevice(kind, deviceId) {
    let track;
    try {
      [track] = (await navigator.mediaDevices.getUserMedia({ [kind]: { deviceId: { exact: deviceId } } })).getTracks();
    } catch (e) {
      return toast(`Не удалось включить устройство: ${e.message}`);
    }
    const old = kind === 'video' ? local.getVideoTracks()[0] : local.getAudioTracks()[0];
    const sender = old && getPc()?.getSenders().find((s) => s.track === old);
    if (old) {
      track.enabled = old.enabled;
      local.removeTrack(old);
      old.stop();
    }
    local.addTrack(track);
    if (sender) await sender.replaceTrack(track);
    else if (getPc()) getPc().addTrack(track, local);
    $(kind === 'video' ? 'cam' : 'mic').disabled = false;
    $(kind === 'video' ? 'cam' : 'mic').classList.toggle('off', !track.enabled);
    $('local').srcObject = local;
    render();
  }

  return switchDevice;
}
