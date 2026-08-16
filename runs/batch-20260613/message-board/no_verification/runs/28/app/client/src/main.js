const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

// Format timestamp
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Render a single message
function renderMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  div.innerHTML = `
    <div class="message-text">${escapeHtml(message.text)}</div>
    <div class="message-time">${formatTime(message.created_at)}</div>
  `;
  return div;
}

// Simple HTML escape
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Fetch historical messages
async function fetchMessages() {
  try {
    const response = await fetch('/api/messages');
    const messages = await response.json();
    
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
      const msgEl = renderMessage(msg);
      messagesContainer.appendChild(msgEl);
    });
    
    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (error) {
    console.error('Failed to fetch messages:', error);
  }
}

// Connect to SSE
function connectSSE() {
  const eventSource = new EventSource('/api/stream');
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'new_message' && data.message) {
        const msgEl = renderMessage(data.message);
        messagesContainer.appendChild(msgEl);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    } catch (e) {
      // Ignore parse errors or connected message
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
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
    
    if (response.ok) {
      input.value = '';
    } else {
      const error = await response.json();
      alert('Error: ' + (error.error || 'Failed to send message'));
    }
  } catch (error) {
    console.error('Failed to send message:', error);
    alert('Failed to send message. Please try again.');
  }
});

// Initialize app
async function init() {
  await fetchMessages();
  connectSSE();
}

init();