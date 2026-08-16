import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

const renderColumnReplacement = `function renderColumn(column) {
  const visibleCards = column.cards.filter(card => {
    if (selectedLabelIds.size === 0) return true;
    return (card.labels || []).some(l => selectedLabelIds.has(l.id));
  });

  return \`
    <section class="column" data-column-id="\${escapeHtml(column.id)}">
      <h2>\${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="\${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="\${escapeHtml(column.id)}">
        \${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  \`;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${cardLabels.map(l => \`<span class="label-chip" style="background-color: \${escapeHtml(l.color)}">\${escapeHtml(l.name)}</span>\`).join('')}
        <button class="btn-icon add-label-btn" data-card-id="\${escapeHtml(card.id)}">+</button>
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
      \${cardLabelMenuOpen === card.id ? renderCardLabelMenu(card) : ''}
    </article>
  \`;
}

function renderCardLabelMenu(card) {
  const cardLabelIds = new Set((card.labels || []).map(l => l.id));
  return \`
    <div class="card-label-menu">
      <div class="card-label-menu-header">
        <span>Labels</span>
        <button class="btn-close close-card-label-menu">&times;</button>
      </div>
      <div class="card-label-menu-body">
        \${labels.map(label => \`
          <label class="card-label-option">
            <input type="checkbox" class="toggle-card-label" data-card-id="\${escapeHtml(card.id)}" data-label-id="\${escapeHtml(label.id)}" \${cardLabelIds.has(label.id) ? 'checked' : ''} />
            <span class="label-chip" style="background-color: \${escapeHtml(label.color)}">\${escapeHtml(label.name)}</span>
          </label>
        \`).join('')}
      </div>
    </div>
  \`;
}
`;

code = code.replace(/function renderColumn\(column\) \{[\s\S]*?<\/article>\n  `;\n}/m, renderColumnReplacement);
fs.writeFileSync('src/main.js', code);
