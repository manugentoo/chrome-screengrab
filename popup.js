const statusEl = document.getElementById('status');
const buttons = document.querySelectorAll('button[data-mode]');

function show(status) {
  if (!status) return;
  statusEl.textContent = status.text;
  statusEl.className = status.state;
  buttons.forEach((b) => (b.disabled = status.state === 'working'));
}

buttons.forEach((button) =>
  button.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const status = await chrome.runtime
      .sendMessage({ type: 'capture', mode: button.dataset.mode, tabId: tab.id })
      .catch(() => null);
    show(status);
  })
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') show(msg);
});

chrome.runtime.sendMessage({ type: 'getStatus' }).then(show, () => {});
