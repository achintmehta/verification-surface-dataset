const express = require('express');
const cors = require('cors');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const db = new PGlite(path.join(__dirname, '../pglite-data'));

async function initDb() {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS events (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            start_at TIMESTAMPTZ NOT NULL,
            end_at TIMESTAMPTZ NOT NULL,
            CONSTRAINT end_after_start CHECK (end_at > start_at)
        );
    `);

    const res = await db.query('SELECT count(*) FROM events');
    if (parseInt(res.rows[0].count) === 0) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const start1 = new Date(today); start1.setHours(9, 0, 0, 0);
        const end1 = new Date(today); end1.setHours(10, 30, 0, 0);
        
        const start2 = new Date(today); start2.setHours(10, 0, 0, 0);
        const end2 = new Date(today); end2.setHours(11, 0, 0, 0);
        
        const start3 = new Date(today); start3.setHours(9, 30, 0, 0);
        const end3 = new Date(today); end3.setHours(11, 30, 0, 0);

        await db.query('INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)', ['Event 1', start1.toISOString(), end1.toISOString()]);
        await db.query('INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)', ['Event 2', start2.toISOString(), end2.toISOString()]);
        await db.query('INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3)', ['Event 3', start3.toISOString(), end3.toISOString()]);
    }
}

initDb().catch(console.error);

app.get('/api/events', async (req, res) => {
    const { start, end } = req.query;
    try {
        const result = await db.query(
            `SELECT * FROM events WHERE start_at < $1 AND end_at > $2`,
            [end, start]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/events', async (req, res) => {
    const { title, start_at, end_at } = req.body;
    if (!title || title.trim() === '') {
        return res.status(400).json({ error: 'Title is required' });
    }
    if (new Date(end_at) <= new Date(start_at)) {
        return res.status(400).json({ error: 'End time must be after start time' });
    }
    try {
        const result = await db.query(
            `INSERT INTO events (title, start_at, end_at) VALUES ($1, $2, $3) RETURNING *`,
            [title, start_at, end_at]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/events/:id', async (req, res) => {
    const { id } = req.params;
    const { title, start_at, end_at } = req.body;
    if (!title || title.trim() === '') {
        return res.status(400).json({ error: 'Title is required' });
    }
    if (new Date(end_at) <= new Date(start_at)) {
        return res.status(400).json({ error: 'End time must be after start time' });
    }
    try {
        const result = await db.query(
            `UPDATE events SET title = $1, start_at = $2, end_at = $3 WHERE id = $4 RETURNING *`,
            [title, start_at, end_at, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/events/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query(`DELETE FROM events WHERE id = $1 RETURNING *`, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
