# Metra Live Network

A live map of every Metra train in the Chicago region, moving in real time on a clean schematic diagram of the whole system.

Built to sit on a second monitor like an aquarium: quiet, calm, and fun to watch for hours. Also works on a phone.

**Live site:** `https://evan-dawkins.github.io/metra-live-network/`

---

## What you see

- **All 11 Metra lines and 238 stations**, drawn as a schematic (straight lines and 45° turns) matched to Metra's own system diagram. That includes the Rock Island Beverly Branch, the Metra Electric South Chicago and Blue Island branches, the UP-NW McHenry Branch, and all four downtown terminals (Ogilvie, Union Station, LaSalle Street, Millennium).
- **Real trains, live.** Each train is an arrow pointing the way it's heading, with a soft fading trail showing where it has just been.
- **Train details.** Click a train to see its line, its train number, where it's headed ("to Waukegan"), where it is now, its next stop and its last stop, with Metra's predicted times.
- **Station schedules.** Click any station to see the next few trains in each direction (to Chicago and away from Chicago, or arriving and departing at the downtown terminals), with minutes away.
- **Your stations.** Pin up to 5 favorite stations to a small departure board that sits over Lake Michigan, out of the way of the map. It tucks into a ★ button by the title when you don't need it.
- **Service alerts** from Metra, in a small dropdown in the top bar. Lines with alerts get a tiny amber dot.
- **Clean station names at every zoom level.** Labels are placed using their real measured size and never overlap each other, the tracks, other stations, or any open panel.
- **Ambience.** Small circles drift across Lake Michigan, and soft brown noise plays in the background. Both can be turned off.

## What you can do

| Action | Desktop | Phone |
|---|---|---|
| Move around | Drag | Drag with one finger |
| Zoom | Scroll wheel, or `+` / `−` | Pinch |
| See the whole network | ⛶ button, or `0` | ⛶ button |
| Focus one line | Click its name in the bottom bar | Tap its name in the bottom bar |
| Fold the line bar | ◂ at the end of the bar (▸ to open it again) | ◂ at the start of the bar |
| Inspect a train | Click it | Tap it |
| See a station's next trains | Click the station | Tap the station |
| Pin a station | Click it, then ☆ | Tap it, then ☆ |
| See your stations | Board on the right, over the lake | Tap the strip above the line bar, or ★ |
| Tuck the board away | ▴ on the board; ★ by the title brings it back | — |
| Read alerts | Click the alerts button | Tap the alerts button |
| Light / dark mode | Sun/moon button next to the title, or `T` | Sun/moon button |
| Ambient sound on/off | Speaker button next to the title, or `M` | Speaker button |
| Welcome guide | **?** next to the title, or `?` | **?** next to the title |
| Close things | `Esc` | Tap the map |

## Honest by design

- **Nothing is made up.** Train positions, directions, arrival times, destinations, and alerts come only from Metra's live feeds. Arrival times are Metra's own per-stop predictions. If the feed has no prediction, no time is shown. Instead, the schedules fall back to what live GPS really shows ("3 stops away"), or say plainly that nothing is on the way.
- **Train numbers are real.** They come from Metra's feed (it matches the number in the trip name, like train 334 on trip UN334), so you can match them against Metra's printed schedules.
- **Trains never run ahead of the data.** A marker glides smoothly between two real GPS reports and stops at the newest one. Direction comes only from real GPS reports.
- **Clear status.** The top bar says Live, Delayed, Offline, or Simulated. While it checks for new data only the dot pulses, so the header doesn't jump around. Hover the status to see when it last updated. Extra detail only appears when something's wrong.
- **Simulated mode is opt-in and labelled.** If the live feed can't load, the dashboard offers fake trains so there's something to look at. They're marked "Simulated" everywhere and are never mixed with real trains.

## Calm when untouched

- **Controls fade back.** After about 10 seconds without input, the controls fade so the map and trains are the whole picture. They come right back the moment you move the mouse or touch the screen.
- **Smooth, quiet motion.** Every panel (train details, station schedules, alerts, your stations, the line bar) opens with a short fade and closes by playing it in reverse. On phones, panels slide up from the bottom and back down. Switching light and dark mode crossfades. New trains fade in, and arrows turn smoothly at bends.
- **Reduced motion is respected.** If your device is set to reduce motion, everything switches instantly: panels, camera moves, the lake, and the intro.
- **Light on your computer.** Trains and trails only redraw when they actually move, so it's comfortable to leave running all day.

## How it works

```
Metra's live feeds  →  Cloudflare Worker (worker.js)  →  index.html in your browser
 (protobuf, ~30 s)      decodes to clean JSON              draws the map and trains
```

- **`index.html`**: the whole dashboard in one file. No build step, no install. Open it in a browser or host it anywhere. The site icon is built in too.
- **`worker.js`**: a small Cloudflare Worker that fetches Metra's GTFS-realtime **vehicle positions**, **trip updates** (arrival predictions), and **service alerts** feeds, decodes them by hand (no libraries), and returns JSON. It's needed because browsers can't call Metra's feed directly, and Metra's license asks that apps serve the data through their own server rather than sending users to Metra's.
- The dashboard checks for new data every 30 seconds, which is how often Metra updates its feed. It asks for `?trips=1` to get per-stop predictions.
- Metra names stations by code (`DAVIS`, `OTC`, `CUS`…). The dashboard maps every code to its station on the map using Metra's own station list.
- Opening the Worker's address with `?peek=1` shows a readable sample of what Metra is sending, which is handy for checking the data. It never includes your key.

## Setting up your own copy

1. **Get a Metra API key** by filling out the form at [metra.com/developers](https://metra.com/developers).
2. **Create a Cloudflare Worker**, paste in `worker.js`, and click **Deploy**.
3. **Add your key as a secret** on the Worker (Settings → Variables and Secrets) named `METRA_API_TOKEN`. The key lives only in Cloudflare, never in this repo.
4. **Point the dashboard at your Worker**: in `index.html`, change `WORKER_URL` to your Worker's address.
5. **Host the page**: turn on GitHub Pages for this repo (Settings → Pages → branch `main`, folder `/ (root)`). The dashboard is named `index.html`, so it opens straight from the site's main link. You can also just open the file in a browser.

## Files

| File | What it is |
|---|---|
| `index.html` | The dashboard |
| `worker.js` | The Cloudflare Worker (backup copy; Cloudflare is what actually runs it) |
| `README.md` | This file |

## Updating the dashboard

Push a new `index.html` to `main` (or use Add file → Upload files with the same name). GitHub Pages republishes it in about a minute, and the link stays the same. If you still see the old version, press **Ctrl + Shift + R** (Mac: **Cmd + Shift + R**) once.

## Notes

- Soft brown-noise ambience is on by default and starts the first time you click or tap the page, because browsers block sound until then.
- Your sound and theme choices aren't saved between visits. Light or dark follows your device's setting each time the page opens.
- A few things are remembered, all in your own browser and nowhere else:
  - "Don't show this on start" for the welcome guide
  - your pinned stations, and whether the board is tucked away
  - whether the line bar is folded
- Metra only. CTA 'L' trains aren't included.
- Train data from Metra's public GTFS-realtime feeds. This is an independent project and isn't affiliated with Metra.
