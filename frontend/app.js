(function () {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendButton = document.getElementById('chat-send');
  const messages = document.getElementById('chat-messages');

  // Matches the backend's MAX_HISTORY_MESSAGES.
  const HISTORY_LIMIT = 10;
  let conversationHistory = [];

  function addBubble(text, sender) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (sender === 'user' ? 'chat-bubble-user' : 'chat-bubble-bot');
    bubble.textContent = text;
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }

  async function handleSend(event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    addBubble(text, 'user');
    input.value = '';
    sendButton.disabled = true;
    const typing = addBubble('Typing…', 'bot');
    typing.classList.add('chat-bubble-typing');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationHistory: conversationHistory.slice(-HISTORY_LIMIT) }),
      });
      const data = await res.json();
      typing.remove();
      if (res.status === 429) {
        addBubble("You're sending messages too quickly. Please wait a minute and try again.", 'bot');
      } else if (!res.ok) {
        addBubble(data.reply || 'Sorry, something went wrong. Please try again.', 'bot');
      } else {
        addBubble(data.reply, 'bot');
        conversationHistory = data.conversationHistory;
      }
    } catch (err) {
      typing.remove();
      addBubble("Sorry, I can't connect right now. Please check your connection and try again.", 'bot');
    } finally {
      sendButton.disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', handleSend);
})();
