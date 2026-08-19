(function () {
  const widget = document.querySelector('.chat-widget');
  const toggleBtn = document.getElementById('chat-toggle');
  const closeBtn = document.getElementById('chat-close');
  const chatWindow = document.getElementById('chat-window');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const messages = document.getElementById('chat-messages');

  const MOCK_REPLY = "Hi! I’m CafeBot. My AI brain isn’t connected yet.";

  function openChat() {
    widget.classList.add('is-open');
    toggleBtn.setAttribute('aria-expanded', 'true');
    chatWindow.setAttribute('aria-hidden', 'false');
    input.focus();
  }

  function closeChat() {
    widget.classList.remove('is-open');
    toggleBtn.setAttribute('aria-expanded', 'false');
    chatWindow.setAttribute('aria-hidden', 'true');
  }

  function toggleChat() {
    if (widget.classList.contains('is-open')) {
      closeChat();
    } else {
      openChat();
    }
  }

  function addBubble(text, sender) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (sender === 'user' ? 'chat-bubble-user' : 'chat-bubble-bot');
    bubble.textContent = text;
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
  }

  function handleSend(event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    addBubble(text, 'user');
    input.value = '';

    window.setTimeout(function () {
      addBubble(MOCK_REPLY, 'bot');
    }, 500);
  }

  toggleBtn.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', closeChat);
  form.addEventListener('submit', handleSend);
})();
