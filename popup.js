const FORMATS = [
  { id: 'png', label: 'PNG', color: '#2563eb' },
  { id: 'jpg', label: 'JPG', color: '#16a34a' },
  { id: 'pdf', label: 'PDF', color: '#dc2626' },
];

const statusEl = document.getElementById('status');

// File-type icon: a page with a folded corner and a colored label.
function fileIcon({ label, color }) {
  return `<svg viewBox="0 0 24 28" aria-hidden="true">
    <path d="M4 1h11l6 6v18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" class="page"/>
    <path d="M15 1v6h6" class="fold"/>
    <rect x="0" y="13" width="20" height="9" rx="2" fill="${color}"/>
    <text x="10" y="19.8" text-anchor="middle">${label}</text>
  </svg>`;
}

for (const row of document.querySelectorAll('.row')) {
  const name = row.querySelector('.label').textContent;
  for (const format of FORMATS) {
    const button = document.createElement('button');
    button.className = 'icon-btn';
    button.title = `Save ${name} as ${format.label}`;
    button.setAttribute('aria-label', button.title);
    button.innerHTML = fileIcon(format);
    button.addEventListener('click', () => start(row.dataset.mode, format.id));
    row.querySelector('.actions').append(button);
  }
}

const buttons = document.querySelectorAll('.icon-btn');

function show(status) {
  if (!status) return;
  statusEl.textContent = status.text;
  statusEl.className = status.state;
  buttons.forEach((b) => (b.disabled = status.state === 'working'));
}

async function start(mode, format) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = await chrome.runtime
    .sendMessage({ type: 'capture', mode, format, tabId: tab.id })
    .catch(() => null);
  show(status);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') show(msg);
});

chrome.runtime.sendMessage({ type: 'getStatus' }).then(show, () => {});
