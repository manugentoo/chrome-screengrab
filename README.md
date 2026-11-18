# ScreenGrab

A Chrome extension that captures a whole web page, from top to bottom, or just the visible area.
It saves the result as **PNG**, **JPG** or **PDF**. After each capture, your system's **Save As**
dialog opens so you can choose the folder and file name. It works on Windows, macOS, Linux and ChromeOS.

## About

Click the ScreenGrab icon in the toolbar and pick a format:

```
Full Page      [PNG] [JPG] [PDF]
Visible Area   [PNG] [JPG] [PDF]
```

- **Full Page** scrolls through the page, captures each screen and stitches the screens into one image.
- **Visible Area** captures only what is currently on screen.
- **PDF** output is split into A4 pages.

What it handles:
- Fixed or sticky headers and banners show up once, at the top, not on every screen.
- Very tall pages that go past Chrome's ~32,767px canvas limit are saved as `-part1`, `-part2`, …
- Files are named `screengrab-<site>-<date>_<time>.<ext>`.
- Nothing is uploaded. Everything happens locally in your browser.

Limits:
- Keep the tab in front while it captures. If you switch tabs, the capture stops.
- Chrome blocks extensions from capturing `chrome://` pages and the Chrome Web Store.
- `file://` pages need **Allow access to file URLs** turned on in the extension's details.
- Pages that scroll inside an inner panel, instead of the window, only capture the visible part.
- PDFs are made of images, so you can't select or search their text.

## File structure

```
screengrab/
├── manifest.json    Extension config (Manifest V3) and permissions
├── background.js    Service worker: scroll-and-capture, stitching, PNG/JPG/PDF output, Save As
├── popup.html       Toolbar popup markup
├── popup.css        Popup styles (light and dark mode)
├── popup.js         Builds the format icons and sends capture requests
├── icons/           Toolbar and store icons (16, 48, 128 px)
├── README.md
└── .gitignore
```

Permissions used:
- `activeTab` – capture the current tab, only after you click the extension
- `scripting` – scroll the page and hide fixed headers during capture
- `downloads` – open the Save As dialog and save the file

## Installation

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `screengrab` folder.
5. Optional: pin ScreenGrab from the puzzle-piece menu so it stays in the toolbar.

To update after changing the code, click the reload icon on the ScreenGrab card in `chrome://extensions`.

The same steps work in other Chromium browsers, such as Edge (`edge://extensions`), Brave and Opera.

## Credits

- Created by **Manu Gentoo**.
- Uses no third-party libraries. Image stitching uses the browser's `OffscreenCanvas`, and the PDF writer is built in.
- Icons are original artwork made for this project.
