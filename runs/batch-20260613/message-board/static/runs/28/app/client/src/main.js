const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');
const statusEl = document.getElementById('status');

// Render a single message
function renderMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  
  const time = new Date(message.created_at).toLocaleTimeString();
  
  div.innerHTML = `
    <div class="message-text">${escapeHtml(message.text)}</div>
    <div class="message-time">${time}</div>
  `;
  
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
    if (!response.ok) throw new Error('Failed to fetch');
    const messages = await response.json();
    
    messagesContainer.innerHTML = '';
    messages.forEach(renderMessage);
    statusEl.textContent = `${messages.length} messages loaded`;
  } catch (error) {
    console.error('Error fetching messages:', error);
    statusEl.textContent = 'Failed to load messages';
  }
}

// Connect to SSE for real-time updates
function connectSSE() {
  const eventSource = new EventSource('/api/stream');
  
  eventSource.onopen = () => {
    statusEl.textContent = 'Connected - listening for updates';
  };
  
  eventSource.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
      statusEl.textContent = 'New message received';
      // Reset status after a bit
      setTimeout(() => {
        if (statusEl.textContent === 'New message received') {
          statusEl.textContent = 'Connected - listening for updates';
        }
      }, 2000);
    } catch (e) {
      console.error('Error parsing SSE message:', e);
    }
  };
  
  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
    statusEl.textContent = 'Connection lost - retrying...';
  };
  
  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    eventSource.close();
  });
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
    
    if (!response.ok) {
      throw new Error('Failed to post message');
    }
    
    // Clear input - message will appear via SSE
    input.value = '';
  } catch (error) {
    console.error('Error posting message:', error);
    alert('Failed to send message. Please try again.');
  }
});

// Initialize app
async function init() {
  await fetchMessages();
  connectSSE();
}

init();