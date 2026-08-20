/* Copy button for the server code block on the chat set-up guide.
   Inline scripts are blocked by the CSP, so this lives in its own file. */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('copy-server');
  const code = document.getElementById('server-code');
  if (!btn || !code) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      btn.textContent = 'Copied';
    } catch {
      // Fallback: select the code so the user can copy manually.
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      btn.textContent = 'Select all → copy';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 2200);
  });
});
