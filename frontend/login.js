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
  if (res.status === 401 || res.status === 400) {
    errorEl.textContent = 'Incorrect username or password.';
  } else if (res.status === 429) {
    errorEl.textContent = 'Too many sign-in attempts. Please wait a few minutes and try again.';
  } else {
    errorEl.textContent = 'Sign-in failed. Please try again.';
  }
  errorEl.hidden = false;
});
