const API_BASE = 'http://localhost:3000';
const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

// Fetch and render historical messages
async function fetchMessages() {
  try {
    const response = await fetch(`${API_BASE}/api/messages`);
    const messages = await response.json();
    messagesContainer.innerHTML = '';
    messages.forEach(addMessageToDOM);
    scrollToBottom();
  } catch (error) {
    console.error('Error fetching messages:', error);
  }
}

// Add a message to the DOM
function addMessageToDOM(message) {
  const div = document.createElement('div');
  div.className = 'message';
  const time = new Date(message.created_at).toLocaleTimeString();
  div.innerHTML = `
    <div>${escapeHtml(message.text)}</div>
    <div class="message-time">${time}</div>
  `;
  messagesContainer.appendChild(div);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Connect to SSE for real-time updates
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/api/stream`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'new_message' && data.message) {
        addMessageToDOM(data.message);
        scrollToBottom();
      }
    } catch (e) {
      // Ignore non-JSON or connected message
    }
  };

  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
    // Optionally reconnect logic here
  };

  return eventSource;
}

// Handle form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  try {
    const response = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (response.ok) {
      input.value = '';
    } else {
      const error = await response.json();
      alert('Error: ' + (error.error || 'Failed to send message'));
    }
  } catch (error) {
    console.error('Error sending message:', error);
    alert('Failed to send message. Is the server running?');
  }
});

// Initialize app
async function init() {
  await fetchMessages();
  connectSSE();
}

init();