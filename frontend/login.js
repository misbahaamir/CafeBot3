const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;

  const res = await fetch('/api/staff/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    }),
  });

  if (res.ok) {
    window.location.href = 'staff.html';
    return;
  }
  errorEl.textContent = res.status === 401 || res.status === 400 ? 'Incorrect username or password.' : 'Sign-in failed. Please try again.';
  errorEl.hidden = false;
});
