# Freefall

A single-page portfolio for an independent designer, told as one fall. Scrolling drives everything: two films play frame by frame under your scroll, type flies past in 3D, and the story ends at a door you walk through to get in touch.

This repository holds the code only. The films, frames and images are not included, so the page shows its layout and type but no footage until you add your own frames (see [Adding the films](#adding-the-films)). The full project with media is at [gireeshkumarreddy/freefall-portfolio](https://github.com/gireeshkumarreddy/freefall-portfolio).

## The story, in scroll order

1. **Loader.** A thin gold line fills while the first frames load, then you enter with or without sound.
2. **The leap.** A figure falls through a shaft of light. Words, short lines and buttons rise past him in 3D, tilt with the mouse, and stretch with scroll speed. An altitude readout counts down to zero.
3. **Impact.** At the hard cut the screen flashes white, shakes once and booms.
4. **The noise.** He lands in a crowd surrounded by grey voices ("make the logo bigger"). A ring of fire blows them away.
5. **Rise.** R-I-S-E assembles out of the depth as he stands up.
6. **Index.** The film shrinks into one tile among floating project covers. Click a cover to jump to its case.
7. **Selected work.** Four case screens stack and recede, each with a sliding title, a spinning disc and circular type.
8. **About and services.** A manifesto that lights up word by word, a client marquee that follows your scroll, and service rows with a cursor-following preview.
9. **The portal.** A man walks out of a burning doorway while arches fly past, then the closing call to action.
10. **Contact.** Email, links, a live Lisbon clock, and "Fall again", which rewinds the whole story.

## Adding the films

The page expects two WebP frame sequences, numbered from `000`:

| Folder | Frames | Source |
| --- | --- | --- |
| `assets/fall/` | `000.webp` to `464.webp`, 720×1280 | a 15.5 s vertical clip at 30 fps |
| `assets/portal/` | `000.webp` to `238.webp`, 1600×900 | a 10 s landscape clip at 24 fps |

Extract them from your clips with ffmpeg:

```bash
ffmpeg -i fall.mp4 -an -vf "fps=30,scale=720:1280" -c:v libwebp -quality 68 -start_number 0 assets/fall/%03d.webp
```

```bash
ffmpeg -i portal.mp4 -an -vf "scale=1600:900" -c:v libwebp -quality 66 -start_number 0 assets/portal/%03d.webp
```

If your clips have a different number of frames, change `FALL_N` and `PORTAL_N` at the top of `js/main.js`, and `FRAME_KEYS` to match where your cut happens.

## Run it

Serve the folder with any static server and open it in a browser:

```bash
python -m http.server 8000
```

Then open http://localhost:8000. Fonts (Google Fonts) and smooth scrolling ([Lenis](https://github.com/darkroomengineering/lenis)) load from CDNs, so you need a connection.

## Project layout

```
index.html            all page markup and copy
css/style.css         styles; colours and type are tokens at the top
js/main.js            the scroll engine: frame scrubbing, 3D type, every section
showcase/             scripts that record the site and put it on a monitor photo
```

## Making it yours

The name **Arin Vale**, the email, the clients and the four projects are placeholders.

- **Name, email, projects, services:** `index.html`.
- **Words that fly past during the story:** `WORLD`, `LINES` and `CTAS` near the top of `js/main.js`.
- **Story timing** (which scroll position shows which frame, where the flash and shockwave land): `FRAME_KEYS`, `CUT` and `SHOCK` in `js/main.js`.
- **Colours and fonts:** the `:root` block at the top of `css/style.css`.

From the browser console, `freefall.jump('work')` scrolls to a section (`top`, `work`, `about`, `services`, `portal`, `contact`, or `story:0.5` for a point in the story).

## Showcase video scripts

`showcase/record.mjs` drives headless Chrome through the whole site on a virtual clock, so every animation is captured frame-perfect. `showcase/composite.py` places that recording on a monitor photo (`showcase/monitor.webp`, not included), adds glass and light spill, and generates a soundtrack from the scroll. They need Node 22 or newer, Google Chrome, ffmpeg, and Python with Pillow, NumPy and SciPy. Run both from the repository root:

```bash
node showcase/record.mjs
```

```bash
python -I showcase/composite.py
```
