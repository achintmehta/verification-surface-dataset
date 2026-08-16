// Smoke test for convergence guarantees. Run the server first, then:
//   node scripts/concurrency-check.js
// Verifies: concurrent moves of the same card leave it in exactly one column,
// and concurrent reorders converge to a single total order.

const BASE = process.env.BASE || 'http://localhost:3001';

async function api(pathname, opts) {
  const res = await fetch(BASE + pathname, opts);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  return res.json();
}

async function createCard(columnId, text) {
  const { card } = await api('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  return card;
}

async function move(id, columnId, beforeId, afterId) {
  return api(`/api/cards/${id}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

(async () => {
  const { columns } = await api('/api/board');
  const [todo, inprog, done] = columns.map((c) => c.id);

  // --- Concurrent move of the SAME card to two columns -------------------
  const card = await createCard(todo, 'concurrent-target');
  await Promise.all([
    move(card.id, inprog, null, null),
    move(card.id, done, null, null),
  ]);
  const after = await api('/api/board');
  let occurrences = 0;
  for (const col of after.columns) {
    if (col.cards.some((c) => c.id === card.id)) occurrences++;
  }
  assert(occurrences === 1, `card must be in exactly one column, found in ${occurrences}`);
  console.log('OK: concurrent move leaves card in exactly one column');

  // --- Total, stable, unique ordering -----------------------------------
  for (const col of after.columns) {
    const positions = col.cards.map((c) => Number(c.position));
    const sorted = [...positions].sort((a, b) => a - b);
    assert(JSON.stringify(positions) === JSON.stringify(sorted), `${col.title} not sorted`);
    assert(new Set(positions).size === positions.length, `${col.title} has duplicate positions`);
  }
  console.log('OK: every column has a total, stable, unique ordering');

  // --- Concurrent reorders converge -------------------------------------
  const a = await createCard(todo, 'A');
  const b = await createCard(todo, 'B');
  const c = await createCard(todo, 'C');
  await Promise.all([
    move(c.id, todo, a.id, null), // C to top
    move(a.id, todo, null, c.id), // A to bottom
  ]);
  const final = await api('/api/board');
  const todoCol = final.columns.find((col) => col.id === todo);
  const ids = todoCol.cards.map((x) => x.id);
  assert(new Set(ids).size === ids.length, 'duplicate card ids in column');
  const pos = todoCol.cards.map((x) => Number(x.position));
  assert(JSON.stringify(pos) === JSON.stringify([...pos].sort((a, b) => a - b)), 'not converged/sorted');
  console.log('OK: concurrent reorders converge to a single total order');
  console.log('Final To Do order:', todoCol.cards.map((x) => x.text).join(' -> '));

  console.log('\nALL CHECKS PASSED');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
