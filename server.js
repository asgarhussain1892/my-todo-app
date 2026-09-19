const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Pool } = require('pg');

for (const name of ['DATABASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']) {
  if (!process.env[name]) {
    console.error(`${name} environment variable is not set.`);
    process.exit(1);
  }
}

// Render's managed Postgres requires SSL for external connections; internal
// connections don't. Enable SSL unless the URL points at localhost, or
// PGSSLMODE=disable is set.
const isLocal = /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.DATABASE_URL);
const useSsl = !isLocal && process.env.PGSSLMODE !== 'disable';
const isProd = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

const app = express();
// Render terminates TLS in front of the app; trust its proxy so secure cookies
// and the Google callback URL use https.
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new pgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: '/auth/google/callback',
      proxy: true,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
        const { rows } = await pool.query(
          `INSERT INTO users (google_id, email, name)
           VALUES ($1, $2, $3)
           ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
           RETURNING id, email, name`,
          [profile.id, email, profile.displayName || email]
        );
        done(null, rows[0]);
      } catch (err) {
        done(err);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [id]);
    done(null, rows[0] || false);
  } catch (err) {
    done(err);
  }
});

app.use(passport.initialize());
app.use(passport.session());

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

app.get('/auth/google', passport.authenticate('google', { scope: ['openid', 'email', 'profile'] }));

app.get(
  '/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?login=failed' }),
  (req, res) => res.redirect('/')
);

app.post('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.status(204).end();
    });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name });
});

app.get('/api/tasks', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, task, done FROM tasks WHERE user_id = $1 ORDER BY id',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/tasks', requireAuth, async (req, res, next) => {
  try {
    const task = typeof req.body.task === 'string' ? req.body.task.trim() : '';
    if (!task) return res.status(400).json({ error: 'Task text is required.' });
    if (task.length > 500) return res.status(400).json({ error: 'Task text is too long (max 500).' });
    const { rows } = await pool.query(
      'INSERT INTO tasks (task, user_id) VALUES ($1, $2) RETURNING id, task, done',
      [task, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.patch('/api/tasks/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    if (typeof req.body.done !== 'boolean') {
      return res.status(400).json({ error: '"done" must be a boolean.' });
    }
    const { rows } = await pool.query(
      'UPDATE tasks SET done = $1 WHERE id = $2 AND user_id = $3 RETURNING id, task, done',
      [req.body.done, id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/tasks/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [
      id,
      req.user.id,
    ]);
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
    CREATE TABLE IF NOT EXISTS users (
      id        SERIAL PRIMARY KEY,
      google_id TEXT NOT NULL UNIQUE,
      email     TEXT,
      name      TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id   SERIAL PRIMARY KEY,
      task TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  // Tasks created before login existed have no owner (user_id IS NULL); they
  // are kept but not shown to anyone.
  await pool.query(
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE'
  );
  await pool.query('CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON tasks (user_id)');
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Listening on port ${port}`));
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
