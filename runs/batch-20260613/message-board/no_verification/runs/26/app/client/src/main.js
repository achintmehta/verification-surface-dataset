const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

// Fetch historical messages
async function fetchMessages() {
  try {
    const response = await fetch('/api/messages');
    const messages = await response.json();
    messages.forEach(addMessageToDOM);
  } catch (error) {
    console.error('Failed to fetch messages:', error);
  }
}

// Add a message to the DOM
function addMessageToDOM(message) {
  const messageEl = document.createElement('div');
  messageEl.className = 'message';
  messageEl.innerHTML = `
    <div class="message-text">${escapeHtml(message.text)}</div>
    <div class="message-time">${new Date(message.created_at).toLocaleString()}</div>
  `;
  messagesContainer.appendChild(messageEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Simple HTML escape
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Connect to SSE for real-time updates
function connectSSE() {
  const eventSource = new EventSource('/api/stream');
  
  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);
    addMessageToDOM(message);
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
      console.error('Failed to post message');
    }
  } catch (error) {
    console.error('Error posting message:', error);
  }
});

// Initialize app
fetchMessages();
connectSSE();