import './style.css';

const messagesDiv = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

// Fetch initial messages
async function fetchMessages() {
  try {
    const response = await fetch('/api/messages');
    const messages = await response.json();
    messages.forEach(addMessageToDOM);
  } catch (error) {
    console.error('Error fetching messages:', error);
  }
}

// Add message to DOM
function addMessageToDOM(message) {
  const messageEl = document.createElement('div');
  messageEl.style.marginBottom = '8px';
  messageEl.style.padding = '8px';
  messageEl.style.backgroundColor = '#f0f0f0';
  messageEl.style.borderRadius = '4px';
  messageEl.innerHTML = `
    <div><strong>${new Date(message.created_at).toLocaleString()}</strong></div>
    <div>${escapeHtml(message.text)}</div>
  `;
  messagesDiv.appendChild(messageEl);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Connect to SSE
function connectSSE() {
  const eventSource = new EventSource('/api/stream');
  
  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);
    addMessageToDOM(message);
  };
  
  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
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

// Initialize
fetchMessages();
connectSSE();