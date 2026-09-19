const form = document.getElementById('add-form');
const input = document.getElementById('task-input');
const list = document.getElementById('task-list');
const empty = document.getElementById('empty');
const errorBox = document.getElementById('error');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const userName = document.getElementById('user-name');
const logoutBtn = document.getElementById('logout');

function showError(message) {
  errorBox.textContent = message || '';
  errorBox.hidden = !message;
}

function showLogin() {
  appView.hidden = true;
  loginView.hidden = false;
}

function showApp(user) {
  loginView.hidden = true;
  appView.hidden = false;
  userName.textContent = user.name || user.email || '';
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    const err = new Error('Please sign in.');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) {
    let message = 'Request failed.';
    try { message = (await res.json()).error || message; } catch (_) {}
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

function render(tasks) {
  list.innerHTML = '';
  empty.hidden = tasks.length > 0;

  for (const t of tasks) {
    const li = document.createElement('li');
    if (t.done) li.classList.add('done');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = t.done;
    checkbox.setAttribute('aria-label', 'Mark done');
    checkbox.addEventListener('change', () => toggle(t.id, checkbox.checked));

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = t.task; // textContent avoids XSS

    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => remove(t.id));

    li.append(checkbox, text, del);
    list.appendChild(li);
  }
}

async function load() {
  try {
    render(await api('/api/tasks'));
    showError('');
  } catch (err) {
    if (!err.unauthorized) showError(err.message);
  }
}

async function toggle(id, done) {
  try {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) });
    showError('');
  } catch (err) {
    if (!err.unauthorized) showError(err.message);
  }
  load();
}

async function remove(id) {
  try {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    showError('');
  } catch (err) {
    if (!err.unauthorized) showError(err.message);
  }
  load();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const task = input.value.trim();
  if (!task) return;
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ task }) });
    input.value = '';
    showError('');
  } catch (err) {
    if (!err.unauthorized) showError(err.message);
  }
  load();
});

logoutBtn.addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch (_) {}
  list.innerHTML = '';
  showLogin();
});

async function init() {
  if (new URLSearchParams(location.search).get('login') === 'failed') {
    showError('Google sign-in failed. Please try again.');
  }
  try {
    showApp(await api('/api/me'));
    load();
  } catch (err) {
    if (!err.unauthorized) showError(err.message);
  }
}

init();
