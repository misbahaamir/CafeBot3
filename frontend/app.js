(function () {
  const widget = document.querySelector('.chat-widget');
  const toggleBtn = document.getElementById('chat-toggle');
  const closeBtn = document.getElementById('chat-close');
  const chatWindow = document.getElementById('chat-window');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const messages = document.getElementById('chat-messages');

  const HISTORY_LIMIT = 10;
  let conversationHistory = [];

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
    return bubble;
  }

  function showTypingIndicator() {
    const bubble = addBubble('CafeBot is typing…', 'bot');
    bubble.classList.add('chat-bubble-typing');
    return bubble;
  }

  async function handleSend(event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    addBubble(text, 'user');
    input.value = '';

    const typingBubble = showTypingIndicator();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversationHistory: conversationHistory.slice(-HISTORY_LIMIT),
        }),
      });

      const data = await res.json();
      typingBubble.remove();

      if (!res.ok) {
        addBubble(data.reply || "Sorry, something went wrong. Please try again.", 'bot');
        return;
      }

      addBubble(data.reply, 'bot');
      conversationHistory = data.conversationHistory || conversationHistory;
    } catch (err) {
      typingBubble.remove();
      addBubble("Sorry, I'm having trouble connecting right now. Please check your connection and try again.", 'bot');
    }
  }

  toggleBtn.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', closeChat);
  form.addEventListener('submit', handleSend);
})();
