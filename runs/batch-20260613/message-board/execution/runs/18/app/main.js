const API_URL = 'http://localhost:3000/api';

const messagesContainer = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

// Render a single message
function renderMessage(message) {
  const messageEl = document.createElement('div');
  messageEl.className = 'message';
  
  const textEl = document.createElement('span');
  textEl.className = 'text';
  textEl.textContent = message.text;
  
  const timeEl = document.createElement('span');
  timeEl.className = 'time';
  timeEl.textContent = new Date(message.created_at).toLocaleTimeString();
  
  messageEl.appendChild(textEl);
  messageEl.appendChild(timeEl);
  
  messagesContainer.appendChild(messageEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Fetch initial messages
async function fetchMessages() {
  try {
    const response = await fetch(`${API_URL}/messages`);
    const messages = await response.json();
    messages.forEach(renderMessage);
  } catch (error) {
    console.error('Error fetching messages:', error);
  }
}

// Setup SSE
function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);
    renderMessage(message);
  };
  
  eventSource.onerror = (error) => {
    console.error('SSE Error:', error);
  };
}

// Handle form submission
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
fetchMessages();
setupSSE();
