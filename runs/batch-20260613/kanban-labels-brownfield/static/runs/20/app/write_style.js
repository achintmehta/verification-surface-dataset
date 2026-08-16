import fs from 'fs';

const content = fs.readFileSync('src/style.css', 'utf8');
const newContent = content + `
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 2rem;
  background: white;
  border-bottom: 1px solid #e2e8f0;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.filter-label {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  color: white;
  text-shadow: 0 1px 2px rgba(0,0,0,0.2);
}

.card-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
}

.remove-label-btn {
  background: none;
  border: none;
  color: white;
  cursor: pointer;
  padding: 0;
  font-size: 1rem;
  line-height: 1;
  opacity: 0.7;
}

.remove-label-btn:hover {
  opacity: 1;
}

.add-label-dropdown {
  margin-top: 0.5rem;
}

.add-label-select {
  width: 100%;
  padding: 0.25rem;
  border-radius: 4px;
  border: 1px solid #cbd5e1;
  font-size: 0.8rem;
}

dialog {
  border: none;
  border-radius: 12px;
  padding: 1.5rem;
  box-shadow: 0 12px 35px rgba(15, 23, 42, 0.2);
  width: 400px;
  max-width: 90vw;
}

dialog::backdrop {
  background: rgba(15, 23, 42, 0.5);
}

.label-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.create-label-form {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.edit-label-name, #new-label-name {
  flex: 1;
  padding: 0.25rem 0.5rem;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
}

.edit-label-color, #new-label-color {
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

button {
  padding: 0.25rem 0.5rem;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  background: white;
  cursor: pointer;
}

button:hover {
  background: #f1f5f9;
}

#manage-labels-btn {
  padding: 0.5rem 1rem;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 8px;
  font-weight: 600;
}

#manage-labels-btn:hover {
  background: #1d4ed8;
}
`;

fs.writeFileSync('src/style.css', newContent);
