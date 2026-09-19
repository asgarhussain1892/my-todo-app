const path = require('path');
const express = require('express');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable is not set.');
  process.exit(1);
}

// Render's managed Postgres requires SSL for external connections; internal
// connections don't. Enable SSL unless the URL points at localhost, or
// PGSSLMODE=disable is set.
const isLocal = /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.DATABASE_URL);
const useSsl = !isLocal && process.env.PGSSLMODE !== 'disable';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tasks', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, task, done FROM tasks ORDER BY id');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/tasks', async (req, res, next) => {
  try {
    const task = typeof req.body.task === 'string' ? req.body.task.trim() : '';
    if (!task) return res.status(400).json({ error: 'Task text is required.' });
    if (task.length > 500) return res.status(400).json({ error: 'Task text is too long (max 500).' });
    const { rows } = await pool.query(
      'INSERT INTO tasks (task) VALUES ($1) RETURNING id, task, done',
      [task]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.patch('/api/tasks/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    if (typeof req.body.done !== 'boolean') {
      return res.status(400).json({ error: '"done" must be a boolean.' });
    }
    const { rows } = await pool.query(
      'UPDATE tasks SET done = $1 WHERE id = $2 RETURNING id, task, done',
      [req.body.done, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/tasks/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Task not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id   SERIAL PRIMARY KEY,
      task TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Listening on port ${port}`));
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
