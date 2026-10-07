# Metra Live Network

A live map of every Metra train around Chicago. You watch the trains move in real time on a simple, clean diagram of the whole system.

It's made to sit on a second monitor, like a fish tank, but it works on a phone too.

**See it here:** https://evan-dawkins.github.io/metra-live-network/

---

## What it does

- Shows all 11 Metra lines and their stations.
- Shows each train as a small arrow that moves as the train moves.
- Click a train or a station to see what's coming and when.
- Shows Metra's service alerts.
- Has light and dark mode.

## Is the data real?

Yes. Everything comes straight from Metra's live feeds. Nothing is guessed or made up.

If Metra doesn't give a time for something, the map says so instead of inventing one. If the live data can't load, you can choose to see pretend trains, and they're clearly labelled "Simulated."

## How it works (the simple version)

1. Metra publishes live train data, but in a format your browser can't read directly.
2. A tiny program on Cloudflare (`worker.js`) grabs that data, turns it into something readable, and keeps your Metra key secret.
3. The page (`index.html`) asks that program for the data every 30 seconds and draws the map.

That's it. There's nothing to install and no build step.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole map, in one file |
| `worker.js` | The Cloudflare program that fetches Metra's data (a backup copy; Cloudflare runs the real one) |
| `README.md` | This page |

## Make your own copy

1. **Get a free Metra key** at [metra.com/developers](https://metra.com/developers).
2. **Make a Cloudflare Worker.** Paste in `worker.js` and click Deploy.
3. **Add your key to it.** In the Worker's settings, add a secret named `METRA_API_TOKEN` and paste your key. It stays in Cloudflare and never goes in this repo.
4. **Point the page at your Worker.** In `index.html`, change `WORKER_URL` to your Worker's address.
5. **Put it online.** In this repo, go to Settings → Pages, pick the `main` branch and `/ (root)`, and save.

## Updating it

Upload or push a new `index.html` to the `main` branch. The site updates in about a minute. If you still see the old version, refresh with **Ctrl + Shift + R** (Mac: **Cmd + Shift + R**).

## Good to know

- It covers Metra only, not CTA trains.
- This is an independent project and isn't affiliated with Metra.
