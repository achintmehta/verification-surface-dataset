import fs from 'fs';
let content = fs.readFileSync('src/style.css', 'utf8');
content += `
.controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 2rem;
  background: white;
  border-bottom: 1px solid #cbd5e1;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.filter-bar label {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
}

.label-chip {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  color: white;
  text-shadow: 0 1px 2px rgba(0,0,0,0.4);
}

.card-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
}

.card-actions {
  margin-top: 0.5rem;
  display: flex;
  justify-content: flex-end;
}

.assign-label-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  opacity: 0.5;
}

.assign-label-btn:hover {
  opacity: 1;
}

dialog {
  border: none;
  border-radius: 12px;
  box-shadow: 0 12px 35px rgba(15, 23, 42, 0.2);
  padding: 1.5rem;
  width: 400px;
  max-width: 90vw;
}

dialog::backdrop {
  background: rgba(15, 23, 42, 0.5);
}

#label-list {
  list-style: none;
  padding: 0;
  margin: 0 0 1rem 0;
}

#label-list li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.create-label-form {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.create-label-form input[type="text"], #label-list input[type="text"] {
  flex: 1;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 0.25rem 0.5rem;
}

.delete-label-btn {
  background: #ef4444;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.25rem 0.5rem;
  cursor: pointer;
}

.delete-label-btn:hover {
  background: #dc2626;
}

#create-label-btn {
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.25rem 0.5rem;
  cursor: pointer;
}

#create-label-btn:hover {
  background: #1d4ed8;
}

#clear-filter {
  background: #64748b;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.25rem 0.5rem;
  cursor: pointer;
}

#clear-filter:hover {
  background: #475569;
}

#manage-labels-btn {
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-weight: 600;
}

#manage-labels-btn:hover {
  background: #e2e8f0;
}
`;
fs.writeFileSync('src/style.css', content);
