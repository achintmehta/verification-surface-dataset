const API_URL = '/api';

const messagesContainer = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

function renderMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  
  const time = new Date(message.created_at).toLocaleTimeString();
  
  div.innerHTML = `
    <div class="message-text">${escapeHTML(message.text)}</div>
    <div class="message-time">${time}</div>
  `;
  
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

async function fetchMessages() {
  try {
    const response = await fetch(`${API_URL}/messages`);
    const messages = await response.json();
    messages.forEach(renderMessage);
  } catch (error) {
    console.error('Error fetching messages:', error);
  }
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type !== 'connected') {
      renderMessage(data);
    }
  };

  eventSource.onerror = (error) => {
    console.error('SSE Error:', error);
  };
}

messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const text = messageInput.value.trim();
  if (!text) return;
  
  messageInput.value = '';
  
  try {
    await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
  } catch (error) {
    console.error('Error posting message:', error);
  }
});

// Initialize
fetchMessages().then(() => {
  setupSSE();
});
