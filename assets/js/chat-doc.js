/* Copy buttons for the server code blocks on the chat set-up guide.
   Inline scripts are blocked by the CSP, so this lives in its own file.
   There is more than one block now (the standard server and Heretic), so
   each button is paired with the <code> inside its own .code-wrap. */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.code-copy').forEach((btn) => {
    const code = btn.closest('.code-wrap')?.querySelector('code');
    if (!code) return;
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
});
