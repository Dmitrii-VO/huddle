// Text chat over the data channel; a toast and a dot on the button while it's closed.
const $ = (id) => document.getElementById(id);

export function createChat({ sendData, toast, fitInk }) {
  function addMessage(text, mine, delivered = true) {
    const p = document.createElement('p');
    p.className = mine ? 'me' : '';
    const who = document.createElement('b');
    who.textContent = mine ? 'Вы' : 'Собеседник';
    p.append(who, text + (delivered ? '' : ' (не доставлено)'));
    $('messages').append(p);
    p.scrollIntoView();
    if (!mine && $('chat').hidden) {
      $('unread').hidden = false;
      toast(`Собеседник: ${text}`);
    }
  }

  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    addMessage(text, true, sendData({ t: 'chat', text }));
    $('chat-input').value = '';
  };
  function toggleChat() {
    $('chat').hidden = !$('chat').hidden;
    $('unread').hidden = true;
    if (!$('chat').hidden) $('chat-input').focus();
    fitInk();
  }
  $('chat-toggle').onclick = toggleChat;
  $('chat-close').onclick = toggleChat;
  return addMessage;
}
