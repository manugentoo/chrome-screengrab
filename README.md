# ScreenGrab

Chrome extension that screenshots a whole web page, top to bottom, and opens the
"Save As" dialog so you choose the folder. Works on Windows, macOS, Linux and ChromeOS.

## Install
1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder

## Use
Click the ScreenGrab icon, then:
- **Full page** – scrolls the page, captures every part and stitches it into one PNG
- **Visible area** – captures just what's on screen

Keep the tab in front while it captures. Fixed headers/banners appear only once, at the top.

## Notes
- Chrome blocks capturing `chrome://` pages and the Chrome Web Store.
- `file://` pages need **Allow access to file URLs** in the extension's details.
- Very tall pages (beyond Chrome's ~32,767px canvas limit) are saved as `-part1.png`, `-part2.png`, …
- Pages that scroll inside an inner panel (instead of the window) only capture the visible part.
